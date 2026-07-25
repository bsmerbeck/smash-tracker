import type { Database } from 'firebase-admin/database';
import { claimInvitationRecordSchema, coachClientEntrySchema } from '@smash-tracker/shared';
import { hashClaimCode, normalizeClaimCode } from './crypto.js';
import {
  checkAndIncrement,
  claimRedemptionAccountPath,
  claimRedemptionIpPath,
  CLAIM_REDEMPTION_PER_ACCOUNT_HOURLY_LIMIT,
  CLAIM_REDEMPTION_PER_IP_HOURLY_LIMIT,
} from './rateLimits.js';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { RtdbService } from '../services/rtdb.js';

/**
 * Phase 23 (Claim Credential & Atomic Ownership Transition, CRED-05/CLAIM-02/
 * CLAIM-04/EVT-02/EVT-03): the single no-oracle redemption transaction and
 * the atomic ownership flip it gates.
 *
 * **Uniform call shape, not equal timing.** Every redemption attempt —
 * never-issued digest, expired, revoked, consumed by another account, a
 * corrupt record, or a genuinely fresh win — performs EXACTLY ONE
 * `.transaction()` call against `claimInvitations/{digest}` and NO
 * `.get()` on that record. A transaction against a nonexistent node is a
 * legal operation (`current` is simply `null`), so ALL eligibility logic —
 * expired, revoked, already-consumed, never-existed, corrupt — lives INSIDE
 * the transaction's update function. That is what makes those five failure
 * classes structurally indistinguishable from the caller's point of view:
 * none of them can be told apart by counting RTDB round trips.
 *
 * **The 200ms floor (`CLAIM_REDEMPTION_FLOOR_MS`) is defense-in-depth, not
 * the primary control.** The uniform-call-shape design above still leaves
 * one residual gap: a winning redemption performs one MORE write (the
 * ownership-flip `update()`) than a losing one, which could theoretically
 * leak a few milliseconds of timing signal. `floorDelay` closes that gap by
 * padding every reply — success or failure — up to a fixed wall-clock floor
 * before the route sends any response. Trade-off, accepted explicitly by the
 * owner during Phase 23 planning: this adds latency to every legitimate
 * claim too, which is fine for a rare, one-time-per-relationship action.
 *
 * **No `timingSafeEqual` call anywhere on this path.** The HMAC digest is
 * used as the RTDB KEY (`claimInvitations/{digest}`, see `crypto.ts`), so
 * verification is an O(1) key lookup, never a byte-by-byte comparison of a
 * submitted secret against a stored one — there is no secret-dependent
 * comparison branch whose duration could leak a prefix match.
 *
 * **Content records are never touched.** `flipTenantOwnership` writes
 * exactly six control-record paths (`clientMembers`, `clientTenants`,
 * `coachClients`, `activeClaimInvitationByTenant`) and nothing else — every
 * match, playlist, opponent, note, review, session, and delivery record
 * keeps its id and its value, byte-for-byte, because this module never
 * reads or writes any of those trees.
 */

/** Fixed response floor applied to every redemption reply, success and failure alike.
 *
 * Closes the residual timing gap left by the uniform-call-shape design (a
 * winning redemption still performs one more write than a losing one). 200ms
 * is below typical human-perceptible lag and well above the RTDB round-trip
 * delta. Owner decision, Phase 23 planning. Trade-off accepted: every
 * legitimate claim also pays it, which is fine for a one-time-per-relationship
 * action.
 */
export const CLAIM_REDEMPTION_FLOOR_MS = 200;

/**
 * Pads the caller's elapsed time (measured from `startedAtMs`) up to
 * `floorMs` before resolving. Never sleeps when the elapsed time already
 * meets or exceeds the floor.
 */
export async function floorDelay(
  startedAtMs: number,
  floorMs: number = CLAIM_REDEMPTION_FLOOR_MS,
): Promise<void> {
  const elapsed = Date.now() - startedAtMs;
  const remaining = floorMs - elapsed;
  if (remaining <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

export type ClaimConsumeOutcome = 'fresh' | 'replay-same-client' | 'ineligible';

export interface ClaimConsumeResult {
  outcome: ClaimConsumeOutcome;
  tenantId: string | null;
  issuerUid: string | null;
}

/**
 * The single no-oracle transaction. Exactly ONE RTDB operation:
 * `database.ref('claimInvitations/' + digest).transaction(updateFn)` — no
 * `.get()` before it, no second read after it. The transaction is called
 * unconditionally for every digest, real or not; a transaction against a
 * nonexistent node is legal and `current` is simply `null`.
 *
 * After this single call, the outcome is fully determined with no further
 * RTDB read — a nonexistent digest, an expired one, a revoked one, and one
 * consumed by someone else are all indistinguishable from here on.
 */
export async function consumeClaimInvitation(
  database: Database,
  digest: string,
  redeemerUid: string,
): Promise<ClaimConsumeResult> {
  // Declared outside the update function; RESET at the top of every
  // invocation (CR-01 Pattern 3, see `tenants.ts`'s `createClient`) so a
  // value captured during a discarded hash-mismatch run can never leak into
  // the final result.
  let outcome: ClaimConsumeOutcome = 'ineligible';
  let capturedTenantId: string | null = null;
  let capturedIssuerUid: string | null = null;

  const result = await database.ref(`claimInvitations/${digest}`).transaction((current) => {
    outcome = 'ineligible';
    capturedTenantId = null;
    capturedIssuerUid = null;

    if (current === null || current === undefined) {
      // CR-01: first-run null is never a verified abort. Returning the
      // observed value unchanged forces a hash-compare retry against
      // whatever real data actually exists at this path.
      return current;
    }

    const parsed = claimInvitationRecordSchema.safeParse(current);
    if (!parsed.success) {
      // Corrupt record, verified against real data — treated as ineligible.
      return undefined;
    }
    const record = parsed.data;

    if (record.consumedAt != null) {
      if (record.consumedByUid === redeemerUid) {
        outcome = 'replay-same-client';
        capturedTenantId = record.tenantId;
        capturedIssuerUid = record.issuerUid;
      }
      // An already-consumed record must NEVER be rewritten — abort either way.
      return undefined;
    }

    if (record.revokedAt != null || record.expiresAt <= Date.now()) {
      return undefined;
    }

    outcome = 'fresh';
    capturedTenantId = record.tenantId;
    capturedIssuerUid = record.issuerUid;
    return { ...record, consumedAt: Date.now(), consumedByUid: redeemerUid };
  });

  // Widened via `as`: `outcome` is mutated from inside the transaction's
  // update-function closure, and TypeScript's control-flow analysis
  // otherwise over-narrows the read below to the literal it was initialized
  // with (assigning through an intermediate `let` does not defeat this —
  // only an explicit type assertion does).
  let finalOutcome = outcome as ClaimConsumeOutcome;
  if (finalOutcome === 'fresh' && !result.committed) {
    // Lost race: another attempt won between our winning update-function run
    // and the real commit. Downgrade rather than report a phantom success.
    finalOutcome = 'ineligible';
    capturedTenantId = null;
    capturedIssuerUid = null;
  }

  return { outcome: finalOutcome, tenantId: capturedTenantId, issuerUid: capturedIssuerUid };
}

/**
 * ONE root-level multi-path `update()`. This function touches control
 * records only — it must never read, write, copy, move, or delete anything
 * under `matches`, `playlists`, `opponents`, `opponentAliases`,
 * `opponentNotes`, `stageFavorites`, `primaryFighters`, `secondaryFighters`,
 * `reviewDrafts`, `reviewVersions`, `reviewVersionIndex`, `reviewStatus`,
 * `reviewDeliveries`, `trainingSessions`, or `sessionDeliveries`. Record ids
 * never change. That is what makes CLAIM-02's "every record stays
 * byte-for-byte in place" true by construction rather than by care. The
 * client's own personal tree at `matches/{clientUid}` is a different subject
 * id entirely and is likewise never touched here — which is why the
 * no-merge contract (CLAIM-04) is structural, not a policy branch.
 *
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01/CTRL-02): the
 * SEVENTH path below (the client-owner reverse index, keyed under the client's
 * own uid) is written inside this SAME `update()` call — never a follow-up
 * write, so a partial flip can never leave an orphaned index entry. This is
 * the client-keyed mirror of `coachClients/{coachUid}/{tenantId}` and follows
 * the `sharesByUser` reverse-index precedent (`services/rtdb.ts`'s
 * `sharesByUser/{uid}/{shareId}` doc comment): a client-side index the
 * client can enumerate without a second global-scope index or an
 * `orderByChild` rule, so `database.rules.json` stays deny-all/unchanged.
 */
export async function flipTenantOwnership(
  database: Database,
  params: { tenantId: string; clientUid: string; coachUid: string; now: number; label: string },
): Promise<void> {
  const { tenantId, clientUid, coachUid, now, label } = params;
  await database.ref().update({
    [`clientMembers/${tenantId}/${clientUid}`]: { role: 'owner', joinedAt: now },
    // Targeted field write, NOT a whole-record rewrite, so the coach's
    // original joinedAt survives. The record is never deleted — deleting it
    // would sever the coach-client link this milestone exists to preserve.
    [`clientMembers/${tenantId}/${coachUid}/role`]: 'delegate',
    [`clientTenants/${tenantId}/ownerUid`]: clientUid,
    [`clientTenants/${tenantId}/claimedAt`]: now,
    [`coachClients/${coachUid}/${tenantId}/claimedAt`]: now,
    // The code has been consumed — nothing is outstanding.
    [`activeClaimInvitationByTenant/${tenantId}`]: null,
    // Phase 24 7th path — the client-owner reverse index (see doc comment above).
    [`clientOwnedTenants/${clientUid}/${tenantId}`]: { label, claimedAt: now },
  });
}

export interface RedeemClaimCodeParams {
  code: string;
  redeemerUid: string;
  clientIp: string;
  sessionId: string;
  hmacSecret: string;
}

export type RedeemClaimCodeResult =
  { status: 'ok'; tenantId: string } | { status: 'invalid' } | { status: 'rate_limited' };

/**
 * Informational only — per CONTEXT.md's locked "always keep-both" decision
 * there is no reject or defer branch. Fire-and-forget specifically so the
 * extra read cannot add latency to the reply or perturb the timing profile.
 */
async function emitClaimConflictIfPersonalLibraryExists(
  database: Database,
  params: { tenantId: string; redeemerUid: string; sessionId: string },
): Promise<void> {
  const matches = await new RtdbService(database).listMatches(params.redeemerUid);
  if (matches.length === 0) {
    return;
  }
  void createEvent(
    database,
    buildDomainEnvelope({
      eventName: 'claim_conflict_detected',
      actorId: params.redeemerUid,
      sessionId: params.sessionId,
      causationId: `${params.tenantId}:conflict`,
      consentState: 'unknown',
      payload: { reason: 'existing_personal_library' },
    }),
  );
}

/**
 * Total function: never throws. Every input — a genuinely fresh code, a
 * same-client replay, any of the five ineligible classes, a rate-limit hit,
 * or an unexpected internal failure — resolves to one of the three
 * discriminated result variants. This is what keeps the global error
 * handler (`apps/api/src/app.ts`'s `NotFoundError`/`ConflictError`/
 * `ForbiddenError` mapping) entirely out of the redemption path.
 */
export async function redeemClaimCode(
  database: Database,
  params: RedeemClaimCodeParams,
  logger?: { error: (obj: unknown, msg: string) => void },
): Promise<RedeemClaimCodeResult> {
  const now = Date.now();
  try {
    // Always increment BOTH counters, in this order, both awaited, before
    // evaluating either — the call shape must be identical for every
    // request regardless of whether the submitted code is valid or garbage.
    const ipWithinLimit = await checkAndIncrement(
      database,
      claimRedemptionIpPath(params.clientIp, now),
      CLAIM_REDEMPTION_PER_IP_HOURLY_LIMIT,
    );
    const accountWithinLimit = await checkAndIncrement(
      database,
      claimRedemptionAccountPath(params.redeemerUid, now),
      CLAIM_REDEMPTION_PER_ACCOUNT_HOURLY_LIMIT,
    );
    if (!ipWithinLimit || !accountWithinLimit) {
      return { status: 'rate_limited' };
    }

    // Normalization deliberately never validates length or shape, so a
    // malformed code produces a digest that simply does not exist and
    // travels the identical path as a real-but-ineligible one.
    const digest = hashClaimCode(params.hmacSecret, normalizeClaimCode(params.code));

    const consumed = await consumeClaimInvitation(database, digest, params.redeemerUid);

    if (consumed.outcome === 'ineligible') {
      return { status: 'invalid' };
    }

    const tenantId = consumed.tenantId as string;

    if (consumed.outcome === 'fresh') {
      const issuerUid = consumed.issuerUid as string;
      // CRED-05 no-oracle constraint (T-24-02, binding): this read of
      // `coachClients/{issuerUid}/{tenantId}` MUST stay strictly inside this
      // 'fresh' branch, after `consumeClaimInvitation` has already resolved.
      // Moving it anywhere earlier in this function — including a
      // "resolve it once up top" refactor — would add a `coachClients` read
      // to the five ineligible classes and reopen the closed no-oracle
      // call-shape property the line-187 parity test in
      // `redemption.test.ts` exists to guard.
      const coachEntrySnapshot = await database.ref(`coachClients/${issuerUid}/${tenantId}`).get();
      const parsedCoachEntry = coachClientEntrySchema.safeParse(coachEntrySnapshot.val());
      const label = parsedCoachEntry.success ? parsedCoachEntry.data.label : tenantId;

      await flipTenantOwnership(database, {
        tenantId,
        clientUid: params.redeemerUid,
        coachUid: issuerUid,
        now,
        label,
      });

      void createEvent(
        database,
        buildDomainEnvelope({
          eventName: 'claim_completed',
          actorId: params.redeemerUid,
          sessionId: params.sessionId,
          causationId: `${tenantId}:claimed`,
          consentState: 'unknown',
          payload: {},
        }),
      );
      void createEvent(
        database,
        buildDomainEnvelope({
          eventName: 'coach_delegation_granted',
          actorId: params.redeemerUid,
          sessionId: params.sessionId,
          causationId: `${tenantId}:${issuerUid}:granted`,
          consentState: 'unknown',
          payload: {},
        }),
      );
      void emitClaimConflictIfPersonalLibraryExists(database, {
        tenantId,
        redeemerUid: params.redeemerUid,
        sessionId: params.sessionId,
      });
    }

    // A same-client replay is a genuine no-op with zero additional writes —
    // the flip is already in place from the original consumption —
    // mirroring `markStripeEventProcessed`'s replay convention.
    return { status: 'ok', tenantId };
  } catch (err) {
    // An unexpected internal failure must be indistinguishable from an
    // invalid code; a 500 here would itself be an oracle, and it also
    // structurally guarantees no globally-mapped error class can escape
    // this function. Only the error object is logged — never `params`, and
    // never any part of the code.
    logger?.error({ err }, 'Claim redemption failed unexpectedly');
    return { status: 'invalid' };
  }
}

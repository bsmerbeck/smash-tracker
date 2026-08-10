import type { Database } from 'firebase-admin/database';
import { z } from 'zod';
import {
  includedVodSchema,
  MAX_DELIVERY_VODS,
  REVIEW_DELIVERY_STATES,
  shareTokenSchema,
  type IncludedVod,
  type ReviewDeliveryState,
  type ShareToken,
} from '@smash-tracker/shared';
import { buildReviewShareId, NotFoundError } from '../services/rtdb.js';
import { generateShareToken } from '../shares/token.js';
import { freezeIncludedVods } from './deliveryVodFreeze.js';
import { readSubjectKind } from '../research/subjectKind.js';
import { isDemoAccountSubject } from '../research/demoAccount.js';
import type { DemoAccountConfig } from '../config/env.js';

/**
 * Phase 12 Plan 04 (Coach Reviews & Delivery, DLV-01): the coach-side
 * delivery-capability service — mint/list/revoke a revocable CSPRNG
 * delivery for exactly ONE published review version. Plain exported
 * functions taking `(database, tenantId, ...)`, called from thin route
 * files (`apps/api/src/routes/coachingReviewDeliveries.ts`) — mirrors
 * `apps/api/src/coaching/reviews.ts`'s module shape.
 *
 * RTDB layout (this plan's own tree, deferred from 12-02/12-03 — see their
 * SUMMARYs):
 * - `reviewDeliveries/{tenantId}/{reviewId}/{deliveryId}` -> ReviewDeliveryRecord
 *   (push-keyed; `status` is kept authoritative on EVERY write — never
 *   derived at read time — so `reviews.ts`'s existing
 *   `getLatestDeliveryState`/`getMostRecentDeliveryStateForTenant` readers,
 *   which only ever read `{ status, createdAt, version }` off this SAME
 *   node, keep working completely unchanged (12-03-SUMMARY Deviation 3's
 *   "keep status as a derived/duplicated summary field" option) even though
 *   this plan additionally writes `token`/`revokedAt`/`expiresAt`/`ackAt`/
 *   `viewedAt` onto the very same record.
 *
 * Deliberately does NOT route delivery creation through
 * `RtdbService.createShare`'s own `kind: 'coachReview'` branch (see that
 * branch's doc comment) — this module performs its OWN atomic
 * `shareTokens/{token}` + `reviewDeliveries/.../{deliveryId}` multi-path
 * write in `createReviewDelivery` below, so a delivery is never left
 * half-written (a token with no matching delivery record, or vice versa).
 * The two paths still share the exact same primitives — `generateShareToken()`
 * and the `buildReviewShareId` encoding — so there is only ONE token system
 * (DLV-01) even though there are two write call sites.
 */

/**
 * `reviewDeliveries/{tenantId}/{reviewId}/{deliveryId}` — grown beyond
 * 12-03's minimal `{ status, createdAt, version }` read-side contract to
 * carry the full delivery lifecycle this plan's must-haves require:
 * `token` (so the coach-side list can rebuild the delivery URL),
 * `revokedAt`/`expiresAt`/`ackAt`/`viewedAt` (nullish — absent/`null` means
 * "hasn't happened yet", never a bare `.optional()`, per CONCERNS.md's RTDB
 * null-stripping rule). `ackAt`/`viewedAt` are written by 12-05's anonymous
 * routes, not this plan — always `null` here at create time.
 */
export const reviewDeliveryRecordSchema = z.object({
  status: z.enum(REVIEW_DELIVERY_STATES),
  token: z.string().min(1),
  version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullish(),
  expiresAt: z.number().int().nonnegative().nullish(),
  ackAt: z.number().int().nonnegative().nullish(),
  viewedAt: z.number().int().nonnegative().nullish(),
  /**
   * Phase 21 (Rich Client Delivery View, DLVX-02/DLVX-04): the coach-picked
   * VODs, FROZEN at delivery-creation time via `freezeIncludedVods` — a
   * TOP-LEVEL additive field, following `expiresAt`/`ackAt`/`viewedAt`'s own
   * precedent of growing this record additively rather than restructuring
   * (RESEARCH Open Question 1). Absent (never `[]` — RTDB drops empty-array
   * keys on write) when the delivery had zero resolvable picks; every READ
   * path must normalize a missing key back to `[]` before treating it as
   * "this delivery's VOD set" (see `parseDeliveryRecord` below).
   */
  includedVods: z.array(includedVodSchema).max(MAX_DELIVERY_VODS).nullish(),
});
export type ReviewDeliveryRecord = z.infer<typeof reviewDeliveryRecordSchema>;

/**
 * RTDB drops any key whose value is an empty array on write — a delivery
 * created with zero resolvable `includedVods` picks round-trips with NO
 * `includedVods` key at all. Every read of a delivery record that needs to
 * treat `includedVods` as a real (possibly-empty) array must normalize the
 * missing key back to `[]` before validating, mirroring
 * `sessionDeliveries.ts`'s `parseDeliveryRecord` discipline exactly (Pitfall
 * 2 / T-21-04's "empty pick set round-trips as an empty array, never 404").
 */
function parseDeliveryRecord(raw: unknown): ReviewDeliveryRecord {
  if (raw === null || typeof raw !== 'object') {
    return reviewDeliveryRecordSchema.parse(raw);
  }
  const rawRecord = raw as Record<string, unknown>;
  return reviewDeliveryRecordSchema.parse({
    ...rawRecord,
    includedVods: rawRecord.includedVods ?? [],
  });
}

function safeParseDeliveryRecord(raw: unknown): ReviewDeliveryRecord | null {
  try {
    return parseDeliveryRecord(raw);
  } catch {
    return null;
  }
}

/**
 * One row of the coach-side delivery list (`GET .../deliveries`) — the
 * stored record plus its rebuildable share URL. `revokedAt`/`expiresAt`/
 * `ackAt`/`viewedAt` are narrowed to `number | null` (never `undefined`) —
 * `listReviewDeliveries` normalizes every nullish stored value to `null`
 * before returning, matching the wire response schema's `.nullable()`
 * convention (never `.nullish()` — bulkShareRequestSchema's documented
 * "response contracts are never `undefined`" rule).
 */
export interface ReviewDeliveryListItem extends Omit<
  ReviewDeliveryRecord,
  'revokedAt' | 'expiresAt' | 'ackAt' | 'viewedAt'
> {
  deliveryId: string;
  revokedAt: number | null;
  expiresAt: number | null;
  ackAt: number | null;
  viewedAt: number | null;
  url: string;
}

/**
 * Mints a revocable CSPRNG delivery capability pinned to EXACTLY ONE
 * published version (DLV-01). Verifies
 * `reviewVersions/{tenantId}/{reviewId}/{version}` exists BEFORE minting
 * anything — a missing OR unpublished (never-sealed) version throws
 * `NotFoundError`, so a token is never minted for a draft (D-14: delivery
 * only ever exists per PUBLISHED version). One atomic multi-path `.update()`
 * writes `shareTokens/{token}` (reused as-is — `generateShareToken()`, no
 * new token system) and the `reviewDeliveries/.../{deliveryId}` record
 * together, so a delivery is never left half-written.
 */
export async function createReviewDelivery(
  database: Database,
  tenantId: string,
  reviewId: string,
  version: number,
  webBaseUrl: string,
  options: { expiresAt?: number; includedVodMatchIds?: string[] } = {},
  // Phase 30.1 (Demo Account Topology & Migration, RTEN-03 re-scope,
  // review H4): trailing, defaulted to `null` (enforcement inactive) so
  // every existing call site keeps compiling unchanged. This writer does
  // NOT receive `researchConfig` — do not conflate the two allowlists.
  demoConfig: DemoAccountConfig | null = null,
): Promise<{ deliveryId: string; token: string; url: string }> {
  // Phase 29 Plan 06 (RTEN-03, D-05): ONE of exactly THREE independent mint
  // writers for a bearer-delivery token — the other two are
  // `RtdbService.createShare` and `createSessionDelivery` (this directory).
  // Refuses BEFORE the multi-path update below, so a refused mint leaves
  // the database byte-unchanged. Resolution-side gating (the four
  // resolvers in `apps/api/src/services/rtdb.ts`) does NOT substitute for
  // this: a token minted before this phase would still resolve without it.
  const mintKindResolution = await readSubjectKind(database, tenantId);
  if (mintKindResolution !== 'ordinary') {
    // Reuses the SAME class + message this function already throws for
    // input it will not serve — no new error class, nothing that names the
    // discriminator or reveals why (D-05 no-oracle).
    throw new NotFoundError(`Review ${reviewId} has no published version ${version}`);
  }
  // Phase 30.1 (RTEN-03 re-scope, review H4): the SAME subject id
  // (`tenantId`) is checked against the demo allowlist, refusing with the
  // SAME NotFoundError this function already throws (D-05 no-oracle).
  if (isDemoAccountSubject(demoConfig, tenantId)) {
    throw new NotFoundError(`Review ${reviewId} has no published version ${version}`);
  }

  const versionSnapshot = await database
    .ref(`reviewVersions/${tenantId}/${reviewId}/${version}`)
    .get();
  if (!versionSnapshot.exists()) {
    throw new NotFoundError(`Review ${reviewId} has no published version ${version}`);
  }

  // Phase 21 (DLVX-02/DLVX-04, D-10/Pitfall 3): freeze the coach-picked VODs
  // BEFORE the atomic write below — resolved against the review's OWN
  // tenant (T-21-03), never re-read live afterward.
  const frozenIncludedVods: IncludedVod[] = await freezeIncludedVods(
    database,
    tenantId,
    options.includedVodMatchIds ?? [],
  );

  const token = generateShareToken();
  const deliveryRef = database.ref(`reviewDeliveries/${tenantId}/${reviewId}`).push();
  const deliveryId = deliveryRef.key;
  if (!deliveryId) {
    throw new Error('Failed to generate a push key for the new review delivery');
  }

  const now = Date.now();
  const tokenRecord: ShareToken = {
    shareId: buildReviewShareId(tenantId, reviewId, version),
    ownerUid: tenantId,
    permissions: 'view',
    createdAt: now,
    // Plan 05 fix (Rule 2 — missing critical functionality): `getShareByToken`/
    // `resolveCoachReviewShareRef`'s expiry re-check gates on THIS record's
    // `expiresAt` (`shareTokens/{token}`), never the delivery record's own
    // `expiresAt` below — without this, a delivery created with an expiry
    // would never actually stop resolving (DLV-02's "re-checking
    // revocation/expiry on EVERY request" must-have would silently not
    // apply to coachReview deliveries at all).
    ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
  };
  const deliveryRecord = reviewDeliveryRecordSchema.parse({
    status: 'delivered',
    token,
    version,
    createdAt: now,
    revokedAt: null,
    expiresAt: options.expiresAt ?? null,
    ackAt: null,
    viewedAt: null,
    // Conditional-spread (CONCERNS.md null-stripping rule): a zero-pick
    // delivery writes NO includedVods key at all, never `[]`.
    ...(frozenIncludedVods.length > 0 ? { includedVods: frozenIncludedVods } : {}),
  } satisfies ReviewDeliveryRecord);

  await database.ref().update({
    [`shareTokens/${token}`]: shareTokenSchema.parse(tokenRecord),
    [`reviewDeliveries/${tenantId}/${reviewId}/${deliveryId}`]: deliveryRecord,
  });

  return { deliveryId, token, url: `${webBaseUrl}/r/${token}` };
}

/**
 * Lists every delivery ever created for one review (coach-facing —
 * `GET .../deliveries`), most-recent-first. A corrupt/unparseable record is
 * skipped, never breaks the whole list (mirrors `listSharesForUser`'s
 * per-record safeParse-and-skip discipline).
 */
export async function listReviewDeliveries(
  database: Database,
  tenantId: string,
  reviewId: string,
  webBaseUrl: string,
): Promise<ReviewDeliveryListItem[]> {
  const snapshot = await database.ref(`reviewDeliveries/${tenantId}/${reviewId}`).get();
  if (!snapshot.exists()) {
    return [];
  }
  const raw = snapshot.val() as Record<string, unknown>;

  const rows = Object.entries(raw).flatMap(([deliveryId, value]) => {
    const parsed = safeParseDeliveryRecord(value);
    if (!parsed) {
      return [];
    }
    return [
      {
        deliveryId,
        ...parsed,
        // Normalize nullish (never-set) to `null` — the wire response
        // schema uses `.nullable()`, not `.nullish()` (bulkShareRequestSchema's
        // documented convention: response contracts are never `undefined`).
        revokedAt: parsed.revokedAt ?? null,
        expiresAt: parsed.expiresAt ?? null,
        ackAt: parsed.ackAt ?? null,
        viewedAt: parsed.viewedAt ?? null,
        url: `${webBaseUrl}/r/${parsed.token}`,
      },
    ];
  });

  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Revokes a delivery: flips BOTH `reviewDeliveries/.../{deliveryId}`'s
 * `status`/`revokedAt` AND `shareTokens/{token}/revokedAt` in ONE atomic
 * multi-path update — the token write is the one `getShareByToken`'s
 * shared (kind-agnostic) revocation check actually gates on, so revoking
 * only the delivery record would leave the link still resolving. Idempotent:
 * an already-revoked delivery is a silent no-op (returns `revoked: false`)
 * so the route never re-fires `review_delivery_revoked` for a
 * non-transition (D-11 — the event must ride a genuine transition).
 */
export async function revokeReviewDelivery(
  database: Database,
  tenantId: string,
  reviewId: string,
  deliveryId: string,
): Promise<{ revoked: boolean }> {
  const deliveryRef = database.ref(`reviewDeliveries/${tenantId}/${reviewId}/${deliveryId}`);
  const snapshot = await deliveryRef.get();
  if (!snapshot.exists()) {
    throw new NotFoundError(`Delivery ${deliveryId} not found`);
  }
  const record = safeParseDeliveryRecord(snapshot.val());
  if (!record) {
    throw new NotFoundError(`Delivery ${deliveryId} not found`);
  }

  if (record.revokedAt != null) {
    return { revoked: false };
  }

  const revokedAt = Date.now();
  const revokedStatus: ReviewDeliveryState = 'revoked';
  await database.ref().update({
    [`reviewDeliveries/${tenantId}/${reviewId}/${deliveryId}/revokedAt`]: revokedAt,
    [`reviewDeliveries/${tenantId}/${reviewId}/${deliveryId}/status`]: revokedStatus,
    [`shareTokens/${record.token}/revokedAt`]: revokedAt,
  });

  return { revoked: true };
}

/**
 * Phase 12 Plan 05 (DLV-02, D-09 link acknowledgement): idempotently sets
 * `ackAt`/`status: 'acknowledged'` on the ONE delivery record under
 * `reviewDeliveries/{tenantId}/{reviewId}` whose `token` matches — the
 * anonymous ack route's write target (`publicReviewDeliveries.ts`). The
 * caller resolves `(tenantId, reviewId)` from the token itself first (via
 * `RtdbService.resolveCoachReviewShareRef`, the same no-oracle
 * revoked/expired re-check `getShareByToken` uses) — this function's only
 * job is finding and flipping the matching delivery record, never
 * re-validating the token's liveness a second way.
 *
 * A second ack on an already-acked delivery is a silent no-op
 * (`alreadyAcked: true`) — the caller only fires `client_review_acknowledged`
 * on a genuine transition (D-11), mirroring `revokeReviewDelivery`'s
 * idempotent-revoke discipline. Returns `null` if no delivery record under
 * this reviewId carries the given token — defensive; should never happen
 * for a token `resolveCoachReviewShareRef` just resolved, since both write
 * paths always create the token and delivery record together.
 */
export async function setDeliveryAck(
  database: Database,
  tenantId: string,
  reviewId: string,
  token: string,
): Promise<{ deliveryId: string; alreadyAcked: boolean } | null> {
  const snapshot = await database.ref(`reviewDeliveries/${tenantId}/${reviewId}`).get();
  if (!snapshot.exists()) {
    return null;
  }
  const raw = snapshot.val() as Record<string, unknown>;
  const entry = Object.entries(raw).find(([, value]) => {
    const parsed = safeParseDeliveryRecord(value);
    return parsed !== null && parsed.token === token;
  });
  if (!entry) {
    return null;
  }
  const [deliveryId, rawRecord] = entry;
  const record = parseDeliveryRecord(rawRecord);

  if (record.ackAt != null) {
    return { deliveryId, alreadyAcked: true };
  }

  const ackAt = Date.now();
  const ackedStatus: ReviewDeliveryState = 'acknowledged';
  await database.ref().update({
    [`reviewDeliveries/${tenantId}/${reviewId}/${deliveryId}/ackAt`]: ackAt,
    [`reviewDeliveries/${tenantId}/${reviewId}/${deliveryId}/status`]: ackedStatus,
  });

  return { deliveryId, alreadyAcked: false };
}

/**
 * Phase 12 Plan 08 (D-09/D-11, Rule 2 — missing critical functionality):
 * idempotently sets `viewedAt`/`status: 'viewed'` on the ONE delivery
 * record whose `token` matches — mirrors `setDeliveryAck`'s find-by-token
 * discipline exactly, but for the Delivered -> Viewed transition.
 *
 * Deliberately its OWN dedicated route (`POST
 * .../review-deliveries/:token/viewed`, `publicReviewDeliveries.ts`) rather
 * than riding the generic same-origin `POST /api/events` X-ingestion route
 * (`apps/api/src/routes/events.ts`) `client_review_view_loaded` conceptually
 * belongs to per the strategy catalog: that route's envelope `payload` is a
 * privacy-hardened allowlisted bag of primitives that explicitly may never
 * carry "capability tokens or share secrets" (`packages/shared/src/
 * events.ts`'s own doc comment) — and the delivery TOKEN is exactly that, the
 * only thing the anonymous browser actually holds that could identify WHICH
 * delivery a view belongs to. A dedicated token-in-URL route (identical
 * shape to `/ack` above) resolves the delivery server-side the same safe way
 * `/ack` already does, while preserving the crawler-safety property that
 * matters (the CLIENT decides when to call this — after `isReady`, fire-once
 * — never the GET route itself; a crawler that only ever GETs never POSTs
 * here, so it never produces a Viewed signal, D-09/Pitfall 4).
 *
 * Never REGRESSES a later status backward: if the delivery is already
 * `'acknowledged'` (or, in principle, any later terminal state), `viewedAt`
 * still gets stamped (first time only — an honest historical record of when
 * the recipient's player first rendered), but `status` is left untouched.
 * Only a delivery still sitting at `'delivered'` advances to `'viewed'`.
 */
export async function setDeliveryViewed(
  database: Database,
  tenantId: string,
  reviewId: string,
  token: string,
): Promise<{ deliveryId: string; alreadyViewed: boolean } | null> {
  const snapshot = await database.ref(`reviewDeliveries/${tenantId}/${reviewId}`).get();
  if (!snapshot.exists()) {
    return null;
  }
  const raw = snapshot.val() as Record<string, unknown>;
  const entry = Object.entries(raw).find(([, value]) => {
    const parsed = safeParseDeliveryRecord(value);
    return parsed !== null && parsed.token === token;
  });
  if (!entry) {
    return null;
  }
  const [deliveryId, rawRecord] = entry;
  const record = parseDeliveryRecord(rawRecord);

  if (record.viewedAt != null) {
    return { deliveryId, alreadyViewed: true };
  }

  const viewedAt = Date.now();
  const viewedStatus: ReviewDeliveryState = 'viewed';
  const updates: Record<string, unknown> = {
    [`reviewDeliveries/${tenantId}/${reviewId}/${deliveryId}/viewedAt`]: viewedAt,
  };
  if (record.status === 'delivered') {
    updates[`reviewDeliveries/${tenantId}/${reviewId}/${deliveryId}/status`] = viewedStatus;
  }
  await database.ref().update(updates);

  return { deliveryId, alreadyViewed: false };
}

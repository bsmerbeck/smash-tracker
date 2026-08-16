import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  activeClaimInvitationPointerSchema,
  claimInvitationRecordSchema,
  clientHubRowSchema,
  clientMembershipSchema,
  coachClientEntrySchema,
  isResearchKind,
  mapDeliveryStateToHubState,
  type ClientHubList,
  type ClientHubRow,
  type ClientTenantKind,
} from '@smash-tracker/shared';
import type { ResearchConfig } from '../config/env.js';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { onboardingCausePayload } from '../onboarding/activation.js';
import { assertTenantAccess } from '../research/access.js';
import { readSubjectKind } from '../research/subjectKind.js';
import { ConflictError, ForbiddenError, RtdbService } from '../services/rtdb.js';
import { requireTenantRole } from './membershipRoles.js';
import { countOpenDrafts, getMostRecentDeliveryStateForTenant } from './reviews.js';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-01/TEN-05/TEN-06):
 * the managed-client tenant domain — claim-ready creation, the compact
 * Client Hub listing, soft archive/restore, hard-delete cascade, and JSON
 * export. Mirrors `apps/api/src/services/rtdb.ts`'s conventions (same
 * `ConflictError`/`ForbiddenError` classes, same multi-path-update and
 * transaction idioms) rather than forking a parallel service — every
 * client-scoped tree this module cascades/exports is read through the
 * EXISTING `RtdbService`, called with a tenantId instead of a coachUid (that
 * class's methods are already subject-parameterized; see RESEARCH.md).
 *
 * Naming: `Coaching`/`Tenant`/`Client` only — NEVER a bare `Coach*`
 * identifier (Phase 8's `CoachAttribution`/`coachNotes.ts` already own that
 * prefix for an unrelated anonymous-share-reviewer concept).
 */

/** Soft cap on ACTIVE (non-archived) clients per coach — config-raisable. */
export const MAX_ACTIVE_CLIENTS_PER_COACH = 20;

/**
 * The SINGLE ordered list of subject-keyed tree prefixes holding a managed
 * client's data — the ONE source of truth `deleteClient`'s hard-delete
 * cascade builds its multi-path `null`-delete update from, AND (imported
 * directly) the foreign-client authorization harness iterates
 * (`apps/api/src/coaching/foreignClient.test.ts`) so the two can never drift
 * apart (RESEARCH.md Open Question 2). `primaryFighters`/`secondaryFighters`
 * are two sibling trees (not a single `fighterSelection` tree — see
 * `RtdbService.getFighterSelection`/`setFighterSelection`).
 */
export const CANONICAL_TENANT_TREES = [
  'matches',
  'playlists',
  'opponents',
  'opponentAliases',
  'opponentNotes',
  'stageFavorites',
  'primaryFighters',
  'secondaryFighters',
  // Phase 12 Plan 03 (Coach Reviews & Delivery): the review-authoring trees
  // `apps/api/src/coaching/reviews.ts` reads/writes.
  'reviewDrafts',
  'reviewVersions',
  'reviewVersionIndex',
  'reviewStatus',
  // Phase 12 Plan 04: the delivery tree `apps/api/src/coaching/reviewDeliveries.ts`
  // reads/writes (deferred here from 12-02/12-03 — see their SUMMARYs' deferral notes).
  'reviewDeliveries',
  // Phase 20 Plan 02 (Coaching Workflow, SESS-01/02): the training-session
  // mutable-log tree `apps/api/src/coaching/sessions.ts` reads/writes.
  'trainingSessions',
  // Phase 20 Plan 02: registered here (ahead of its writer) so the
  // hard-delete cascade + export cover it from day one — the delivery tree
  // itself is written by `apps/api/src/coaching/sessionDeliveries.ts`
  // (Phase 20 Plan 03). A not-yet-populated tree is a harmless no-op on the
  // cascade's null-path delete.
  'sessionDeliveries',
  // Phase 23 (Claim Credential & Atomic Ownership Transition) — the
  // one-active-code-per-workspace pointer is keyed by tenantId and
  // therefore has the exact `{tree}/{tenantId}` shape this cascade builds
  // its null-path update from. The invitation RECORD it points at is keyed
  // by HMAC digest instead, so it cannot be reached by this list and is
  // nulled explicitly in `deleteClient` below, mirroring the
  // `shareTokens/{token}` step already added in Phase 20 for the same class
  // of root-level orphan.
  'activeClaimInvitationByTenant',
] as const;

/**
 * Phase 29 Plan 10 (Research Tenancy, Isolation & Governance Gate, RTEN-05A,
 * production-gap item 10, cycle-2 finding C2-HIGH-10): the HARD-DELETE
 * manifest `deleteClient`'s cascade below actually iterates — a documented
 * SUPERSET of `CANONICAL_TENANT_TREES` above, which stays BYTE-UNCHANGED by
 * this plan.
 *
 * The two manifests answer different questions and must not be merged:
 *
 * - `CANONICAL_TENANT_TREES` is the SAME-SUBJECT CONTENT manifest — trees a
 *   tenant's own content occupies, each reachable through a
 *   membership-gated same-subject route. It is what
 *   `apps/api/src/coaching/foreignClient.test.ts`'s `TREE_TO_ROUTE_PATH`
 *   proves 403 coverage over (an EXHAUSTIVE `Record` requiring every member
 *   to have a covered same-subject route) and what plan 29-07's
 *   content-tree aggregation lock scans.
 * - `TENANT_DELETION_TREES` is the HARD-DELETE manifest — everything keyed
 *   by tenant id that must not survive its tenant. It is a strict superset
 *   of the content manifest, and every extra member carries a written
 *   reason (in the exceptions table `foreignClient.test.ts` checks) stating
 *   why it has no same-subject route.
 *
 * `researchEntitlements` was the first extra member; Phase 30 Plan 01
 * (ING-02/ING-03/ING-05/ING-07/ING-08, D-02) added five more research trees
 * ahead of any writer, and Phase 30.2 Plan 01 (ENR-04/ENR-05/ENR-06/ENR-08/
 * ENR-10/ENR-12) adds SIX more Liquipedia enrichment trees ahead of any
 * writer — the extra-member set is now TWELVE trees, all admin-only and all
 * reached through the same uniform-404 research route family, so the same
 * reasoning applies to each: registering them in `CANONICAL_TENANT_TREES`
 * instead would have broken `TREE_TO_ROUTE_PATH`'s exhaustive-record
 * requirement outright.
 */
export const TENANT_DELETION_TREES = [
  ...CANONICAL_TENANT_TREES,
  // Phase 29 Plan 10 (RTEN-05A): admin-only, no same-subject route — see
  // the header comment above for why this cannot live in
  // CANONICAL_TENANT_TREES instead.
  'researchEntitlements',
  // Phase 30 Plan 01 (ING-03): the lossless provider-set tier
  // (`researchSource/{tenantId}/sets/{providerSetId}`) — admin-only,
  // reached only through the research route family's uniform 404.
  'researchSource',
  // Phase 30 Plan 01 (ING-08): the manual/VOD supplement overlay tier
  // (`researchSupplements/{tenantId}/{targetSetId}/{supplementId}`).
  'researchSupplements',
  // Phase 30 Plan 01 (ING-07): the admin-confirmed player-ID identity
  // mapping (`researchIdentity/{tenantId}`).
  'researchIdentity',
  // Phase 30 Plan 01 (ING-02): backfill run state and staged counters
  // (`researchIngestionRuns/{tenantId}`).
  'researchIngestionRuns',
  // Phase 30 Plan 01 (ING-05): the published completeness snapshot
  // (`researchCoverage/{tenantId}`).
  'researchCoverage',
  // Phase 30.2 Plan 01 (ENR-04): one row per extracted Liquipedia fact
  // (`researchEnrichmentObservations/{tenantId}/{observationId}`).
  'researchEnrichmentObservations',
  // Phase 30.2 Plan 01 (ENR-05): the persisted resolver receipt an automatic
  // attachment is checked against
  // (`researchEnrichmentReceipts/{tenantId}/{observationId}`).
  'researchEnrichmentReceipts',
  // Phase 30.2 Plan 01 (ENR-06): the authorization record that lets an
  // observation reach projection
  // (`researchEnrichmentAttachments/{tenantId}/{targetSetId}/{observationId}`).
  'researchEnrichmentAttachments',
  // Phase 30.2 Plan 01 (ENR-08): the stage/VOD ownership witness, stored
  // outside the match row (`researchEnrichmentProjection/{tenantId}/{matchKey}`).
  'researchEnrichmentProjection',
  // Phase 30.2 Plan 01 (ENR-12): the published enrichment coverage snapshot
  // (`researchEnrichmentCoverage/{tenantId}`).
  'researchEnrichmentCoverage',
  // Phase 30.2 Plan 01 (ENR-10): enrichment backfill run state
  // (`researchEnrichmentRuns/{tenantId}`).
  'researchEnrichmentRuns',
  // Phase 30.2 Plan 09 (ENR-10, cycle-1 review MEDIUM 8): the shrink-guard
  // review-entry log a held refresh writes, naming the previous/next
  // observation counts it refused to silently overwrite
  // (`researchEnrichmentShrinkReviews/{tenantId}/{entryId}`).
  'researchEnrichmentShrinkReviews',
  // Phase 30.3 Gate 5: the admin-reviewed YouTube VOD candidate tree
  // (`researchEnrichmentVodCandidates/{tenantId}/{targetSetId}/{candidateId}`)
  // — search results persisted as CANDIDATES, never facts; only an explicit
  // admin confirmation lets one project, at the bottom of the VOD
  // source-priority chain.
  'researchEnrichmentVodCandidates',
] as const;

/**
 * Phase 30.2 Plan 01: the global (non-tenant-keyed) Liquipedia rate-limit
 * and page-cache nodes — `researchRateBudget/liquipedia`,
 * `researchRateBudget/liquipediaParse`, and `liquipediaPageCache/{pageId}` —
 * are DELIBERATELY NOT registered above. Each describes a shared resource
 * (a global request budget, a revision-keyed page cache), not a tenant, and
 * stores no tenant-scoped data; the identical reasoning is already written
 * for the start.gg budget node at `apps/api/src/research/ingestion/throttle.ts`
 * ("Why the node is NOT tenant-keyed").
 */

/**
 * Replicates the existing Phase 8 coach-display-name-collision algorithm
 * (`apps/api/src/services/rtdb.ts`), renamed to avoid that feature's naming
 * collision (RESEARCH.md Pitfall 2) — trims, collapses inner whitespace to a
 * single space, and case-folds so "Sam", "sam", and "Sam  Jones"/"Sam Jones"
 * collide as intended while distinct labels never accidentally match.
 */
export function normalizeClientLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Throws when the caller has no `clientMembers/{tenantId}/{coachUid}`
 * record. Exported (Phase 12, Plan 03) so `apps/api/src/routes/coachingReviews.ts`
 * can gate its own `/api/coaching/clients/:clientId/reviews/*` routes the
 * SAME way this module's own archive/delete/export routes already do —
 * direct membership check on the URL's `:clientId`, never the
 * `X-Active-Subject` header/`resolveSubject` mechanism (that pair is for
 * header-driven same-subject routes like `/api/matches`, not this
 * URL-param-driven `/coaching/clients/:clientId/*` family).
 *
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, review consensus
 * finding 1): the pre-existing existence check runs FIRST, unchanged, and
 * ONLY THEN does this function call `assertTenantAccess` — the ONE shared
 * research-authorization decision site. `researchConfig` is a REQUIRED
 * trailing parameter (never optional-with-a-default — see
 * `requireTenantRole`'s doc comment in `membershipRoles.ts` for why).
 * Removing this second check is exactly what would make removing a uid from
 * `RESEARCH_ADMIN_UIDS` stop revoking access on every route this function
 * guards.
 */
export async function requireMembership(
  database: Database,
  coachUid: string,
  tenantId: string,
  researchConfig: ResearchConfig | null,
): Promise<void> {
  const membership = await database.ref(`clientMembers/${tenantId}/${coachUid}`).get();
  if (!membership.exists()) {
    // T-11-07/no-oracle: a foreign coach's guessed-but-real tenantId and a
    // genuinely nonexistent tenantId must be indistinguishable — both 403.
    throw new ForbiddenError('Not a member of this client tenant');
  }
  // Research gate — throws the SAME rejection above for `denied` and
  // `indeterminate` alike (no-oracle).
  await assertTenantAccess({ database, researchConfig, uid: coachUid, tenantId });
}

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, D-02, RTEN-04):
 * the telemetry-silent creation core — performs the uniqueness/cap
 * transaction and the tenant/membership/index writes, returns `{ tenantId
 * }`, and calls `createEvent` NOWHERE in this function body. Exported so
 * plan 29-05's `apps/api/src/research/tenants.ts` can create a research
 * tenant that structurally CANNOT emit `managed_client_created` — exclusion
 * by construction, not a branch guard (the anti-pattern
 * `packages/shared/src/researchKind.ts`'s `isResearchKind` doc comment
 * warns against for the ledger's sole writer).
 *
 * A fresh, coach-independent `tenantId` (never derived from `ownerUid` —
 * claim-readiness) plus three sibling records —
 * `coachClients/{ownerUid}/{tenantId}` (written INSIDE the uniqueness/cap
 * transaction below, mirroring `createNote`'s abort-without-writing
 * convention verbatim), `clientTenants/{tenantId}`, and
 * `clientMembers/{tenantId}/{ownerUid}` (written together in one multi-path
 * update once the transaction has committed — safe because a freshly
 * minted `randomUUID()` tenantId can never collide, so only the
 * `coachClients` write needs transactional collision/cap protection).
 *
 * Per-coach case-insensitive label uniqueness and the
 * `MAX_ACTIVE_CLIENTS_PER_COACH` soft cap are both enforced INSIDE the
 * transaction's `updateFn` (CR-01 "reset per run" discipline: `nameConflict`/
 * `capExceeded` are reassigned at the top of every invocation, including
 * discarded hash-mismatch runs) so two concurrent creates from the same
 * coach can never both commit a colliding label or push the coach over the
 * cap via a lost-update race.
 *
 * D-01: the discriminator is applied ONLY via conditional spread on
 * `clientTenants/{tenantId}` — the coaching branch's write stays EXACTLY
 * `{ createdAt, archivedAt: null }`, no additional key. The coaching member
 * is NEVER written explicitly onto any record; only the research member is
 * ever actually stamped, and only through this one spread site.
 */
export async function createClientCore(
  database: Database,
  ownerUid: string,
  label: string,
  kind: ClientTenantKind,
): Promise<{ tenantId: string }> {
  const tenantId = randomUUID();
  const now = Date.now();
  const normalizedNew = normalizeClientLabel(label);

  let nameConflict = false;
  let capExceeded = false;
  const coachClientsRef = database.ref(`coachClients/${ownerUid}`);
  const result = await coachClientsRef.transaction((raw) => {
    // Reset per run (CR-01): a flag captured during a DISCARDED
    // (hash-mismatch) run must never leak into the final outcome.
    nameConflict = false;
    capExceeded = false;

    const current = (raw ?? {}) as Record<string, unknown>;
    const activeEntries = Object.entries(current).flatMap(([id, value]) => {
      const parsed = coachClientEntrySchema.safeParse(value);
      if (!parsed.success || parsed.data.archivedAt != null) {
        return [];
      }
      return [{ id, ...parsed.data }];
    });

    if (activeEntries.length >= MAX_ACTIVE_CLIENTS_PER_COACH) {
      capExceeded = true;
      return undefined; // abort without writing
    }

    const collides = activeEntries.some(
      (entry) => normalizeClientLabel(entry.label) === normalizedNew,
    );
    if (collides) {
      nameConflict = true;
      return undefined; // abort without writing
    }

    return {
      ...current,
      [tenantId]: { label, createdAt: now, archivedAt: null },
    };
  });

  if (capExceeded) {
    throw new ForbiddenError(
      `You can create at most ${MAX_ACTIVE_CLIENTS_PER_COACH} active clients`,
    );
  }
  if (nameConflict || !result.committed) {
    throw new ConflictError('A client with that label already exists');
  }

  await database.ref().update({
    [`clientTenants/${tenantId}`]: {
      createdAt: now,
      archivedAt: null,
      // D-01: conditional spread ONLY — the coaching member is never
      // written explicitly onto any record.
      ...(isResearchKind(kind) ? { kind } : {}),
    },
    [`clientMembers/${tenantId}/${ownerUid}`]: { role: 'custodian', joinedAt: now },
  });

  return { tenantId };
}

/**
 * Thin coaching wrapper over `createClientCore` — UNCHANGED signature and
 * behavior for every existing caller (Phase 29, D-02). Calls the core with
 * the coaching kind, then runs the SAME `managed_client_created` emission
 * block verbatim (same event name, same actor/session/causation/consent
 * fields, same conditional-spread envelope discipline) — byte-identical to
 * the pre-Phase-29 behavior.
 *
 * Emits `managed_client_created` (a D event, MEAS-02) after the durable
 * writes commit — `actorId` is the COACH's uid, `causationId` is the new
 * `tenantId`, and the payload carries no label/PII (reference ids only).
 */
export async function createClient(
  database: Database,
  coachUid: string,
  label: string,
  options: { sessionId: string },
): Promise<{ tenantId: string }> {
  const result = await createClientCore(database, coachUid, label, 'coaching');

  // Fire-and-forget, mirrors `signup_completed`'s call site (users.ts) — the
  // durable RTDB write above has already committed, so this D event rides a
  // genuine transition (MEAS-02) rather than gating the response on it.
  //
  // Phase 13 (ONBD-05, D-08): payload carries onboardingCause=coach_clients
  // ONLY when the coach's saved intent is coach_clients (mirrors matches.ts's
  // client_vod_attached call site) — causationId stays tenantId (the dedup
  // key), never repurposed to carry the cause (RESEARCH.md Pattern 3).
  const payload = await onboardingCausePayload(database, coachUid);
  void createEvent(
    database,
    buildDomainEnvelope({
      eventName: 'managed_client_created',
      actorId: coachUid,
      sessionId: options.sessionId,
      causationId: result.tenantId,
      consentState: 'unknown',
      payload,
    }),
  );

  return result;
}

/**
 * Phase 24 (CTRL-03): reads whether a tenant currently has a live,
 * redeemable claim code, returning ONLY its `expiresAt` (or `null`) — never
 * the digest. Mirrors `apps/api/src/claims/invitations.ts`'s
 * `getClaimInvitationStatus` liveness logic (revoked / consumed / expired
 * all mean not-live) but deliberately performs NO membership or role check
 * of its own: `listClients` reaches this tenant by scanning the CALLER'S OWN
 * `coachClients` index, so a second check here would be redundant work. The
 * digest itself is read locally and never returned, logged, or passed to a
 * logger — this helper is module-private (not exported) with exactly one
 * call site, inside `listClients`'s `Promise.all` below.
 */
async function readPendingInvitationExpiresAt(
  database: Database,
  tenantId: string,
): Promise<number | null> {
  const pointerSnapshot = await database.ref(`activeClaimInvitationByTenant/${tenantId}`).get();
  const pointer = activeClaimInvitationPointerSchema.safeParse(pointerSnapshot.val());
  if (!pointer.success) {
    return null;
  }

  const recordSnapshot = await database.ref(`claimInvitations/${pointer.data.digest}`).get();
  const record = claimInvitationRecordSchema.safeParse(recordSnapshot.val());
  if (!record.success) {
    return null;
  }

  if (
    record.data.revokedAt != null ||
    record.data.consumedAt != null ||
    record.data.expiresAt <= Date.now()
  ) {
    return null;
  }

  return record.data.expiresAt;
}

/**
 * Lists a coach's clients as compact, purpose-built Client Hub rows (TEN-05,
 * TEN-03: `clientHubRowSchema` structurally omits coachUid, membership
 * internals, and any client PII beyond the label). `lastActivityAt` is
 * assembled from the client's own `matches/{tenantId}` tree (max `time`).
 * `draftCount`/`deliveryState` (Phase 12 Plan 03, Pitfall 5) are now real:
 * `draftCount` from `reviews.ts`'s `countOpenDrafts` (non-archived
 * `reviewDrafts/{tenantId}` entries) and `deliveryState` from
 * `getMostRecentDeliveryStateForTenant` projected through the documented
 * 6-state -> 3-value Hub mapping (`mapDeliveryStateToHubState`, plan 02) —
 * bounded to THIS tenant's own subtree, never a full cross-tenant scan.
 *
 * Defaults to non-archived clients only (11-03's original contract,
 * preserved for every existing caller). Pass `{ includeArchived: true }`
 * (11-06, TEN-06 "soft-archive/restore") to also return archived rows with
 * their real `archivedAt` — without this, a soft-archived client would have
 * no read path back into the UI, making "restore" unreachable.
 */
export async function listClients(
  database: Database,
  coachUid: string,
  researchConfig: ResearchConfig | null,
  options: { includeArchived?: boolean } = {},
): Promise<ClientHubList> {
  const includeArchived = options.includeArchived ?? false;
  const callerIsResearchAllowlisted =
    researchConfig !== null && researchConfig.adminUids.has(coachUid);
  const snapshot = await database.ref(`coachClients/${coachUid}`).get();
  if (!snapshot.exists()) {
    return [];
  }

  const raw = snapshot.val() as Record<string, unknown>;
  const entries = Object.entries(raw).flatMap(([tenantId, value]) => {
    const parsed = coachClientEntrySchema.safeParse(value);
    if (!parsed.success || (!includeArchived && parsed.data.archivedAt != null)) {
      return [];
    }
    return [
      {
        tenantId,
        label: parsed.data.label,
        archivedAt: parsed.data.archivedAt ?? null,
        // Phase 24 (CTRL-03): already on the parsed coachClientEntrySchema
        // record (Phase 23's flip writes it) — no extra read required, and
        // available on BOTH the success and degrade paths below.
        claimedAt: parsed.data.claimedAt ?? null,
      },
    ];
  });

  const rtdb = new RtdbService(database);
  const rows = await Promise.all(
    entries.map(
      async ({ tenantId, label, archivedAt, claimedAt }): Promise<ClientHubRow | null> => {
        // Phase 29 (review finding 29-01 HIGH): the tri-state kind read runs
        // in its OWN step, OUTSIDE the enrichment `try`/`catch` below — an
        // enrichment-read failure must never also decide the row's kind. A
        // row must never be constructed with a hard-coded ordinary
        // resolution; both the success path and the degrade path below read
        // this SAME value.
        const kind = await readSubjectKind(database, tenantId);

        // Phase 29 (review consensus finding 1): a research row is dropped
        // ENTIRELY from a non-allowlisted caller's listing — the Client Hub
        // must never even reveal the row's existence to a demoted admin or an
        // ordinary coach. `isResearchKind` is the one predicate permitted to
        // compare against the research member (packages/shared/src/researchKind.ts).
        if (isResearchKind(kind) && !callerIsResearchAllowlisted) {
          return null;
        }

        // Phase 29 (cycle-2 finding C2-HIGH-3): an UNRESOLVED row is kept
        // visible (a transient read failure must not look like a deleted
        // client to an ordinary coach) but, for a caller who is NOT a
        // research admin, every derived field is WITHHELD and the four
        // enrichment reads that would produce them are SKIPPED entirely —
        // built from the caller's own coachClients index entry alone. This
        // is what keeps a demoted research admin (whose coachClients index
        // and clientMembers membership both persist forever) from reading a
        // research workspace's activity metadata through a failed kind read.
        // A research admin IS already authorized for every research tenant,
        // so withholding costs them diagnosis and protects nothing — their
        // unresolved rows are enriched normally below.
        if (kind === 'unresolved' && !callerIsResearchAllowlisted) {
          return clientHubRowSchema.parse({
            clientId: tenantId,
            label,
            lastActivityAt: null,
            draftCount: 0,
            deliveryState: null,
            archivedAt,
            claimedAt,
            pendingInvitationExpiresAt: null,
            kind,
          } satisfies ClientHubRow);
        }

        // 260725-juj (defense-in-depth): one tenant's corrupt/unparseable
        // subtree must never 500 the whole Client Hub for every OTHER coach
        // client. Guards against the SAME class of read-path crash the
        // reviews.ts null-stripping fix addresses at the source — this is a
        // backstop, not the primary fix. This module has no request logger
        // (same rationale as `renderShareHtml.ts`'s module-level
        // `console.error` calls), so degrade to a minimal row and log with
        // `console.warn`.
        try {
          const [matches, draftCount, deliveryState6, pendingInvitationExpiresAt] =
            await Promise.all([
              rtdb.listMatches(tenantId),
              countOpenDrafts(database, tenantId),
              getMostRecentDeliveryStateForTenant(database, tenantId),
              readPendingInvitationExpiresAt(database, tenantId),
            ]);
          const lastActivityAt = matches.reduce<number | null>(
            (latest, match) => (latest === null || match.time > latest ? match.time : latest),
            null,
          );
          return clientHubRowSchema.parse({
            clientId: tenantId,
            label,
            lastActivityAt,
            draftCount,
            deliveryState:
              deliveryState6 === null ? null : mapDeliveryStateToHubState(deliveryState6),
            archivedAt,
            claimedAt,
            pendingInvitationExpiresAt: pendingInvitationExpiresAt ?? null,
            kind,
          } satisfies ClientHubRow);
        } catch (err) {
          console.warn(`listClients: degrading tenant ${tenantId} after a read failure`, err);
          // Phase 29: the enrichment degrade deliberately does NOT degrade
          // the kind — `kind` was already resolved above, OUTSIDE this try,
          // so an enrichment failure on a research tenant still reports
          // research (never silently downgraded to ordinary or unresolved).
          return clientHubRowSchema.parse({
            clientId: tenantId,
            label,
            lastActivityAt: null,
            draftCount: 0,
            deliveryState: null,
            archivedAt,
            claimedAt,
            pendingInvitationExpiresAt: null,
            kind,
          } satisfies ClientHubRow);
        }
      },
    ),
  );

  // Drop the null placeholders left by research rows filtered out above for
  // a non-allowlisted caller.
  return rows.filter((row): row is ClientHubRow => row !== null);
}

/**
 * Soft archive (or restore, when `archived` is `false`) — sets/clears
 * `archivedAt` on BOTH the tenant record and the coach's index entry so
 * either read path (`listClients`'s index scan, a future direct tenant
 * lookup) sees a consistent state. Restorable: the underlying data is never
 * touched, only the flag. Requires membership — a foreign coach 403s
 * identically to a nonexistent tenantId (no oracle).
 *
 * Phase 23 (Claim Credential & Atomic Ownership Transition, CLAIM-03):
 * `archiveClient`, `deleteClient`, and `exportClient` (below) are the
 * destructive/exfiltrating routes in this file — hard delete, archive, and
 * full JSON export. After a claim the issuing coach's role is `delegate`,
 * and a delegate must not be able to destroy, hide, or bulk-export the
 * workspace the client now owns, so all three gate on
 * `requireTenantRole(..., ['custodian', 'owner'])` rather than the
 * existence-only `requireMembership`. `owner` is included because the
 * claimed client may of course manage their own workspace; `custodian` is
 * included so pre-claim coach behavior is byte-for-byte unchanged. Every
 * OTHER `/api/coaching/clients/:clientId/*` route — reviews, sessions,
 * deliveries — and every same-subject content route deliberately stays
 * role-blind (still gated by the unchanged, exported `requireMembership`
 * below), because a delegate coach working in the client's workspace IS the
 * coaching relationship this milestone exists to preserve. Owner decision,
 * Phase 23 planning; supersedes RESEARCH.md assumption A5.
 *
 * The parameter is still named `coachUid` at all three call sites — left
 * unchanged to keep the diff scoped — but the caller may now legitimately
 * be the client owner, not only the coach.
 */
export async function archiveClient(
  database: Database,
  coachUid: string,
  tenantId: string,
  archived: boolean,
  researchConfig: ResearchConfig | null,
): Promise<void> {
  await requireTenantRole(database, coachUid, tenantId, ['custodian', 'owner'], researchConfig);
  const archivedAt = archived ? Date.now() : null;
  await database.ref().update({
    [`clientTenants/${tenantId}/archivedAt`]: archivedAt,
    [`coachClients/${coachUid}/${tenantId}/archivedAt`]: archivedAt,
  });
}

/**
 * Hard-delete: an irreversible multi-path `null`-delete cascade covering
 * EXACTLY the tenant's data (built from the exported `TENANT_DELETION_TREES`
 * array — a documented superset of `CANONICAL_TENANT_TREES`, the SAME list
 * `foreignClient.test.ts` iterates for same-subject route coverage, so the
 * two manifests can never silently drift apart either — see
 * `TENANT_DELETION_TREES`'s header comment above for the Phase 29 Plan 10
 * split, and RESEARCH.md Open Question 2 for the original single-manifest
 * rationale) plus the tenant's own metadata/index/membership records.
 * Role-gated (see `archiveClient`'s doc comment above for the Phase 23
 * rationale shared by all three
 * destructive routes).
 *
 * Phase 20 Plan 03 (T-20-11, RESEARCH Pitfall 4): a session delivery mints a
 * root-level `shareTokens/{token}` entry the `CANONICAL_TENANT_TREES` cascade
 * above does NOT reach — nulling `sessionDeliveries/{tenantId}` deletes the
 * delivery RECORDS, but the bearer token itself lives at RTDB's root, outside
 * any tenant-prefixed tree. Without this extra step, a deleted client's
 * session-delivery links would keep resolving via `getShareByToken` forever
 * (the token record would still exist and still pass its revoked/expiry
 * checks). Collected BEFORE the cascade update is built, then folded into the
 * SAME atomic multi-path update below — a deleted client's delivery tokens
 * die in the same transaction as everything else.
 *
 * Phase 23 (RESEARCH.md Pitfall 5): `activeClaimInvitationByTenant/{tenantId}`
 * is now in `CANONICAL_TENANT_TREES` above, so the cascade already nulls the
 * POINTER. But the invitation RECORD it points at,
 * `claimInvitations/{digest}`, is keyed by HMAC digest, not tenantId, so it
 * cannot be reached by that tree list. Without an explicit extra step here, a
 * hard-deleted client's outstanding claim code would stay redeemable
 * forever, and redeeming it would mint an `owner` membership record on a
 * tenant that no longer has data or a coach. Resolved the SAME way as the
 * `shareTokens/{token}` step above: read the pointer, `safeParse` it, and if
 * it parses, fold `claimInvitations/{digest}: null` into the same atomic
 * update.
 *
 * Quick 260726-r7 (P0 regression): `flipTenantOwnership`
 * (`apps/api/src/claims/redemption.ts`) writes SEVEN paths on claim, six of
 * which are `{tree}/{tenantId}`-shaped and therefore already covered by
 * `CANONICAL_TENANT_TREES`/the tenant-metadata nulls below. The seventh,
 * `clientOwnedTenants/{clientUid}/{tenantId}`, is CLIENT-keyed, not
 * tenant-keyed — the one Phase 24 reverse index this cascade cannot reach by
 * iterating tenant-shaped trees, which is exactly how it slipped through at
 * Phase 24 ship time. Audited: every other Phase 24 write site
 * (`activeClaimInvitationByTenant`, `claimInvitations/{digest}`) already has
 * an explicit cascade step above; `clientOwnedTenants` was the only gap.
 * Resolved by resolving the owning client's uid from
 * `clientMembers/{tenantId}` (the member whose `role` is `'owner'`) BEFORE
 * that node is nulled below, then folding
 * `clientOwnedTenants/{ownerUid}/{tenantId}: null` into the SAME atomic
 * update. An unclaimed client has no `'owner'` member — `ownerUid` stays
 * `null` and this step becomes a normal no-op, never an error.
 */
export async function deleteClient(
  database: Database,
  coachUid: string,
  tenantId: string,
  researchConfig: ResearchConfig | null,
): Promise<void> {
  await requireTenantRole(database, coachUid, tenantId, ['custodian', 'owner'], researchConfig);

  const sessionDeliveriesSnapshot = await database.ref(`sessionDeliveries/${tenantId}`).get();
  const deliveryTokens: string[] = [];
  if (sessionDeliveriesSnapshot.exists()) {
    const bySession = sessionDeliveriesSnapshot.val() as Record<
      string,
      Record<string, unknown> | null
    >;
    for (const deliveries of Object.values(bySession ?? {})) {
      for (const value of Object.values(deliveries ?? {})) {
        const token = (value as { token?: unknown } | null)?.token;
        if (typeof token === 'string' && token.length > 0) {
          deliveryTokens.push(token);
        }
      }
    }
  }

  const activeInvitationSnapshot = await database
    .ref(`activeClaimInvitationByTenant/${tenantId}`)
    .get();
  const activeInvitationParsed = activeClaimInvitationPointerSchema.safeParse(
    activeInvitationSnapshot.val(),
  );

  // Quick 260726-r7: resolve the claimed owner (if any) BEFORE
  // `clientMembers/{tenantId}` is nulled below — safeParse-and-skip per
  // member (CONCERNS.md guardrail 3) so one corrupt membership record can
  // never abort the whole delete.
  const membersSnapshot = await database.ref(`clientMembers/${tenantId}`).get();
  let ownerUid: string | null = null;
  if (membersSnapshot.exists()) {
    const members = membersSnapshot.val() as Record<string, unknown>;
    for (const [memberUid, memberValue] of Object.entries(members)) {
      const parsedMember = clientMembershipSchema.safeParse(memberValue);
      if (parsedMember.success && parsedMember.data.role === 'owner') {
        ownerUid = memberUid;
        break;
      }
    }
  }

  const updates: Record<string, null> = {};
  // Phase 29 Plan 10: iterates TENANT_DELETION_TREES (a documented superset
  // of CANONICAL_TENANT_TREES, see that constant's header comment above),
  // not CANONICAL_TENANT_TREES directly — this is what keeps
  // apps/api/src/research/entitlements.ts's tree from outliving a deleted
  // tenant (production-gap item 10) without registering an admin-only tree
  // in the same-subject content manifest the foreign-client harness scans.
  for (const tree of TENANT_DELETION_TREES) {
    updates[`${tree}/${tenantId}`] = null;
  }
  updates[`clientTenants/${tenantId}`] = null;
  updates[`coachClients/${coachUid}/${tenantId}`] = null;
  updates[`clientMembers/${tenantId}`] = null;
  for (const token of deliveryTokens) {
    updates[`shareTokens/${token}`] = null;
  }
  if (activeInvitationParsed.success) {
    updates[`claimInvitations/${activeInvitationParsed.data.digest}`] = null;
  }
  if (ownerUid !== null) {
    // Quick 260726-r7: the client-owner reverse index (Phase 24's 7th
    // `flipTenantOwnership` path) — the client-keyed gap the cascade never
    // covered, see doc comment above.
    updates[`clientOwnedTenants/${ownerUid}/${tenantId}`] = null;
  }

  // Root-level multi-path update: null values delete keys atomically
  // (mirrors `RtdbService.deleteShare`'s cascade convention).
  await database.ref().update(updates);
}

/** Synchronous JSON dump of a client workspace (TEN-06) — see Open Question 1. */
export interface ClientWorkspaceExport {
  clientId: string;
  label: string;
  exportedAt: number;
  matches: Awaited<ReturnType<RtdbService['listMatches']>>;
  playlists: Awaited<ReturnType<RtdbService['listPlaylists']>>;
  opponents: Awaited<ReturnType<RtdbService['listOpponents']>>;
  opponentAliases: Awaited<ReturnType<RtdbService['listOpponentAliases']>>;
  opponentNotes: Awaited<ReturnType<RtdbService['listOpponentNotes']>>;
  stageFavorites: Awaited<ReturnType<RtdbService['getStageFavorites']>>;
  fighterSelection: Awaited<ReturnType<RtdbService['getFighterSelection']>>;
}

/**
 * Assembles a single JSON object from the client's own trees, reusing
 * `RtdbService`'s existing subject-parameterized reads verbatim (never a
 * forked `CoachRtdbService` — RESEARCH.md Anti-Patterns) called with
 * `tenantId` in place of a coachUid. Synchronous at Foundation's per-client
 * data scale (RESEARCH.md Open Question 1) — no job-lifecycle infra needed.
 * Role-gated (see `archiveClient`'s doc comment above for the Phase 23
 * rationale shared by all three destructive routes — a full JSON dump is
 * bulk exfiltration, so a demoted `delegate` coach must not reach it).
 *
 * Phase 29 (RTEN-03): refused OUTRIGHT for a research tenant — for EVERY
 * caller, including an allowlisted research admin who is a custodian. This
 * is deliberate and unconditional, not an authorization check: a full JSON
 * dump is precisely the bulk-exfiltration artifact RTEN-03 exists to
 * prevent, so passing the role/allowlist gate above does not make export
 * reachable for a research tenant. Reuses the SAME rejection the role gate
 * above already raises, so a research admin's refusal is not a new
 * observable shape.
 */
export async function exportClient(
  database: Database,
  coachUid: string,
  tenantId: string,
  researchConfig: ResearchConfig | null,
): Promise<ClientWorkspaceExport> {
  await requireTenantRole(database, coachUid, tenantId, ['custodian', 'owner'], researchConfig);

  const kind = await readSubjectKind(database, tenantId);
  if (isResearchKind(kind)) {
    throw new ForbiddenError('Not a member of this client tenant');
  }

  const entrySnapshot = await database.ref(`coachClients/${coachUid}/${tenantId}`).get();
  const entry = coachClientEntrySchema.parse(entrySnapshot.val());

  const rtdb = new RtdbService(database);
  const [
    matches,
    playlists,
    opponents,
    opponentAliases,
    opponentNotes,
    stageFavorites,
    fighterSelection,
  ] = await Promise.all([
    rtdb.listMatches(tenantId),
    rtdb.listPlaylists(tenantId),
    rtdb.listOpponents(tenantId),
    rtdb.listOpponentAliases(tenantId),
    rtdb.listOpponentNotes(tenantId),
    rtdb.getStageFavorites(tenantId),
    rtdb.getFighterSelection(tenantId),
  ]);

  return {
    clientId: tenantId,
    label: entry.label,
    exportedAt: Date.now(),
    matches,
    playlists,
    opponents,
    opponentAliases,
    opponentNotes,
    stageFavorites,
    fighterSelection,
  };
}

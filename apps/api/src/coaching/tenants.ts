import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  clientHubRowSchema,
  coachClientEntrySchema,
  mapDeliveryStateToHubState,
  type ClientHubList,
  type ClientHubRow,
} from '@smash-tracker/shared';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { onboardingCausePayload } from '../onboarding/activation.js';
import { ConflictError, ForbiddenError, RtdbService } from '../services/rtdb.js';
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
] as const;

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
 */
export async function requireMembership(
  database: Database,
  coachUid: string,
  tenantId: string,
): Promise<void> {
  const membership = await database.ref(`clientMembers/${tenantId}/${coachUid}`).get();
  if (!membership.exists()) {
    // T-11-07/no-oracle: a foreign coach's guessed-but-real tenantId and a
    // genuinely nonexistent tenantId must be indistinguishable — both 403.
    throw new ForbiddenError('Not a member of this client tenant');
  }
}

/**
 * Creates a managed-client tenant: a fresh, coach-independent `tenantId`
 * (never derived from `coachUid` — claim-readiness, RESEARCH.md Pitfall/
 * Anti-Pattern "Deriving tenantId from coachUid") plus three sibling
 * records — `coachClients/{coachUid}/{tenantId}` (written INSIDE the
 * uniqueness/cap transaction below, mirroring `createNote`'s
 * abort-without-writing convention verbatim), `clientTenants/{tenantId}`,
 * and `clientMembers/{tenantId}/{coachUid}` (written together in one
 * multi-path update once the transaction has committed — safe because a
 * freshly minted `randomUUID()` tenantId can never collide, so only the
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
  const tenantId = randomUUID();
  const now = Date.now();
  const normalizedNew = normalizeClientLabel(label);

  let nameConflict = false;
  let capExceeded = false;
  const coachClientsRef = database.ref(`coachClients/${coachUid}`);
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
    [`clientTenants/${tenantId}`]: { createdAt: now, archivedAt: null },
    [`clientMembers/${tenantId}/${coachUid}`]: { role: 'custodian', joinedAt: now },
  });

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
      causationId: tenantId,
      consentState: 'unknown',
      payload,
    }),
  );

  return { tenantId };
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
  options: { includeArchived?: boolean } = {},
): Promise<ClientHubList> {
  const includeArchived = options.includeArchived ?? false;
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
    return [{ tenantId, label: parsed.data.label, archivedAt: parsed.data.archivedAt ?? null }];
  });

  const rtdb = new RtdbService(database);
  return Promise.all(
    entries.map(async ({ tenantId, label, archivedAt }) => {
      const [matches, draftCount, deliveryState6] = await Promise.all([
        rtdb.listMatches(tenantId),
        countOpenDrafts(database, tenantId),
        getMostRecentDeliveryStateForTenant(database, tenantId),
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
        deliveryState: deliveryState6 === null ? null : mapDeliveryStateToHubState(deliveryState6),
        archivedAt,
      } satisfies ClientHubRow);
    }),
  );
}

/**
 * Soft archive (or restore, when `archived` is `false`) — sets/clears
 * `archivedAt` on BOTH the tenant record and the coach's index entry so
 * either read path (`listClients`'s index scan, a future direct tenant
 * lookup) sees a consistent state. Restorable: the underlying data is never
 * touched, only the flag. Requires membership — a foreign coach 403s
 * identically to a nonexistent tenantId (no oracle).
 */
export async function archiveClient(
  database: Database,
  coachUid: string,
  tenantId: string,
  archived = true,
): Promise<void> {
  await requireMembership(database, coachUid, tenantId);
  const archivedAt = archived ? Date.now() : null;
  await database.ref().update({
    [`clientTenants/${tenantId}/archivedAt`]: archivedAt,
    [`coachClients/${coachUid}/${tenantId}/archivedAt`]: archivedAt,
  });
}

/**
 * Hard-delete: an irreversible multi-path `null`-delete cascade covering
 * EXACTLY the tenant's data (built from the exported `CANONICAL_TENANT_TREES`
 * array — the SAME list `foreignClient.test.ts` iterates, so the cascade can
 * never silently drift out of sync with the trees `resolveSubject`-covered
 * routes actually write, per RESEARCH.md Open Question 2) plus the tenant's
 * own metadata/index/membership records. Requires membership.
 */
export async function deleteClient(
  database: Database,
  coachUid: string,
  tenantId: string,
): Promise<void> {
  await requireMembership(database, coachUid, tenantId);

  const updates: Record<string, null> = {};
  for (const tree of CANONICAL_TENANT_TREES) {
    updates[`${tree}/${tenantId}`] = null;
  }
  updates[`clientTenants/${tenantId}`] = null;
  updates[`coachClients/${coachUid}/${tenantId}`] = null;
  updates[`clientMembers/${tenantId}`] = null;

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
 * Requires membership.
 */
export async function exportClient(
  database: Database,
  coachUid: string,
  tenantId: string,
): Promise<ClientWorkspaceExport> {
  await requireMembership(database, coachUid, tenantId);

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

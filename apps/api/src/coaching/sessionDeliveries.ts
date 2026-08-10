import type { Database } from 'firebase-admin/database';
import { z } from 'zod';
import {
  clientVisibleSessionSchema,
  homeworkProgressKey,
  homeworkProgressSchema,
  includedVodSchema,
  MAX_DELIVERY_VODS,
  resolveHomeworkDoneIndexes,
  shareTokenSchema,
  trainingSessionSchema,
  type ClientVisibleSession,
  type HomeworkProgress,
  type HomeworkProgressResponse,
  type IncludedVod,
  type ShareToken,
} from '@smash-tracker/shared';
import { buildSessionShareId, NotFoundError } from '../services/rtdb.js';
import { generateShareToken } from '../shares/token.js';
import { freezeIncludedVods } from './deliveryVodFreeze.js';
import { readSubjectKind } from '../research/subjectKind.js';
import { isDemoAccountSubject } from '../research/demoAccount.js';
import type { DemoAccountConfig } from '../config/env.js';

/**
 * Phase 20 Plan 03 (Coaching Workflow, Training Sessions & VOD-less Reviews,
 * SESS-01/02, D-10 immutability): the coach-side session delivery-capability
 * service — mint/list/revoke a revocable CSPRNG delivery for a training
 * session. Mirrors `apps/api/src/coaching/reviewDeliveries.ts`'s module shape
 * near-verbatim (same plain-function-over-`(database, tenantId, ...)` shape,
 * same `generateShareToken()` reuse, same single atomic `.update()`, same
 * idempotent-revoke discipline) with ONE deliberate divergence: a training
 * session is a MUTABLE LOG (`sessions.ts`'s Pattern 1), not an
 * immutable-once-published document like a review version — so there is no
 * live `reviewVersions`-style sealed record to point a delivery at. Instead,
 * `createSessionDelivery` embeds a FROZEN `clientVisibleSessionSchema`
 * snapshot, taken from the live session AT DELIVERY-CREATION TIME, directly
 * in the delivery record (single-tree option, no separate
 * `sessionShareSnapshots` tree) — a later edit to the live session never
 * changes what an already-issued delivery serves.
 *
 * RTDB layout (this plan's own tree, registered ahead of its writer in Plan
 * 02 — see that plan's SUMMARY deferral note):
 * - `sessionDeliveries/{tenantId}/{sessionId}/{deliveryId}` -> SessionDeliveryRecord
 *   (push-keyed; carries the embedded frozen `snapshot` alongside the
 *   lifecycle fields `status`/`token`/`createdAt`/`revokedAt`).
 *
 * Deliberately does NOT route delivery creation through
 * `RtdbService.createShare`'s generic branches — this module performs its OWN
 * atomic `shareTokens/{token}` + `sessionDeliveries/.../{deliveryId}`
 * multi-path write in `createSessionDelivery` below, so a delivery is never
 * left half-written. The two write paths still share the exact same
 * primitives — `generateShareToken()` and a `buildSessionShareId` encoding —
 * so there is only ONE token system even though there are multiple write call
 * sites, mirroring `reviewDeliveries.ts`'s own documented rationale.
 */

/**
 * `sessionDeliveries/{tenantId}/{sessionId}/{deliveryId}` — the delivery
 * lifecycle record PLUS the embedded frozen client-visible snapshot. No
 * `expiresAt`/`ackAt`/`viewedAt` machinery this plan (Phase 21 rebuilds the
 * recipient rendering and can grow this record additively then, exactly like
 * `reviewDeliveryRecordSchema` grew beyond its own 12-03 minimal contract).
 */
export const sessionDeliveryRecordSchema = z.object({
  status: z.enum(['delivered', 'revoked']),
  token: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullish(),
  snapshot: clientVisibleSessionSchema,
  /**
   * Phase 21 (Rich Client Delivery View, DLVX-02/DLVX-04): the coach-picked
   * VODs, FROZEN at delivery-creation time via `freezeIncludedVods` —
   * TOP-LEVEL, a SIBLING to `snapshot` (not nested inside
   * `clientVisibleSessionSchema`, which is shared with coach-side session
   * reads — this is the chosen interpretation of "extend the session record
   * the same way as the review record": additive top-level growth, mirroring
   * `reviewDeliveryRecordSchema`'s own `includedVods` field exactly). Absent
   * (never `[]`) when the delivery had zero resolvable picks.
   */
  includedVods: z.array(includedVodSchema).max(MAX_DELIVERY_VODS).nullish(),
  /**
   * 260731-b1 (client-interactive session-delivery homework): the client's
   * per-item progress + acknowledge/submit stamps against THIS delivery's
   * frozen `snapshot.homework` — a TOP-LEVEL sibling of `snapshot`, mirroring
   * `includedVods`'s own additive-growth placement immediately above. Absent
   * (never `{}`) for a delivery no client has ever touched — `parseDeliveryRecord`
   * needs no normalization for it: it is a map, not an array, so RTDB never
   * drops a populated one (only an empty-array write is dropped), and
   * `.nullish()` on `homeworkProgressSchema` itself covers the absent key. Do
   * NOT add a `?? {}` fallback here — a future reader adding one would
   * silently paper over a genuinely corrupt record instead of failing parse.
   */
  homeworkProgress: homeworkProgressSchema.nullish(),
});
export type SessionDeliveryRecord = z.infer<typeof sessionDeliveryRecordSchema>;

/**
 * RTDB drops any key whose value is an empty array on write — the embedded
 * `snapshot.characterTags`/`snapshot.homework` round-trip with NO key at all
 * when a session had zero tags/homework at delivery time. Every READ of a
 * delivery record must normalize those missing keys back to `[]` before
 * validating, mirroring `sessions.ts`'s `parseSessionRecord` discipline
 * exactly, but one level deeper (on the embedded `snapshot` object).
 *
 * Phase 21 (DLVX-02/DLVX-04): extended to ALSO normalize the top-level
 * `includedVods` field the same way — a delivery with zero resolvable
 * coach-picked VODs round-trips with no `includedVods` key at all.
 */
function parseDeliveryRecord(raw: unknown): SessionDeliveryRecord {
  if (raw === null || typeof raw !== 'object') {
    return sessionDeliveryRecordSchema.parse(raw);
  }
  const rawRecord = raw as Record<string, unknown>;
  const rawSnapshot = rawRecord.snapshot;
  const normalizedSnapshot =
    rawSnapshot !== null && typeof rawSnapshot === 'object'
      ? {
          ...(rawSnapshot as Record<string, unknown>),
          characterTags: (rawSnapshot as { characterTags?: unknown }).characterTags ?? [],
          homework: (rawSnapshot as { homework?: unknown }).homework ?? [],
        }
      : rawSnapshot;
  return sessionDeliveryRecordSchema.parse({
    ...rawRecord,
    snapshot: normalizedSnapshot,
    includedVods: rawRecord.includedVods ?? [],
  });
}

function safeParseDeliveryRecord(raw: unknown): SessionDeliveryRecord | null {
  try {
    return parseDeliveryRecord(raw);
  } catch {
    return null;
  }
}

/**
 * One row of the coach-side delivery list (`GET .../deliveries`) — the
 * stored record plus its rebuildable share URL. `revokedAt` is narrowed to
 * `number | null` (never `undefined`) — `listSessionDeliveries` normalizes
 * the stored nullish value to `null` before returning, matching
 * `ReviewDeliveryListItem`'s documented wire-safety convention.
 */
export interface SessionDeliveryListItem extends Omit<SessionDeliveryRecord, 'revokedAt'> {
  deliveryId: string;
  revokedAt: number | null;
  url: string;
  /**
   * 260731-b1: the four flat coach-facing homework fields, computed from the
   * already-parsed record's `snapshot.homework` + `homeworkProgress` via
   * `resolveHomeworkDoneIndexes` — the SAME resolution function the
   * anonymous client snapshot uses (`RtdbService.getSessionSnapshot`), so
   * the coach's count and the client's `doneIndexes` length can never
   * disagree. No extra RTDB read: everything needed is already on `record`.
   */
  homeworkDoneCount: number;
  homeworkTotal: number;
  homeworkAcknowledgedAt: number | null;
  homeworkSubmittedAt: number | null;
}

/**
 * Mints a revocable CSPRNG delivery capability for a training session
 * (D-10): reads the LIVE session, builds a `clientVisibleSessionSchema`-shaped
 * snapshot (coachPrivateNotes structurally absent — the schema has no field
 * for it), mints a token via `generateShareToken()`, and performs ONE atomic
 * multi-path `.update()` writing `shareTokens/{token}` and the
 * `sessionDeliveries/.../{deliveryId}` record together — a delivery is never
 * left half-written. A missing session throws `NotFoundError` BEFORE any
 * token is minted (mirrors `createReviewDelivery`'s "never mint a token for a
 * draft" discipline, applied to "never mint a token for a nonexistent
 * session").
 *
 * The embedded snapshot is FROZEN at this exact moment: a later
 * `updateSession`/`toggleHomeworkItem` call never reaches back into an
 * already-issued delivery record (immutability locked for Phase 21's two-tab
 * view).
 */
export async function createSessionDelivery(
  database: Database,
  tenantId: string,
  sessionId: string,
  webBaseUrl: string,
  options: { includedVodMatchIds?: string[] } = {},
  // Phase 30.1 (Demo Account Topology & Migration, RTEN-03 re-scope,
  // review H4): trailing, defaulted to `null` (enforcement inactive) so
  // every existing call site keeps compiling unchanged. This writer does
  // NOT receive `researchConfig` — do not conflate the two allowlists.
  demoConfig: DemoAccountConfig | null = null,
): Promise<{ deliveryId: string; token: string; url: string }> {
  // Phase 29 Plan 06 (RTEN-03, D-05): ONE of exactly THREE independent mint
  // writers for a bearer-delivery token — the other two are
  // `RtdbService.createShare` and `createReviewDelivery` (this directory).
  // Refuses BEFORE the multi-path update below, so a refused mint leaves
  // the database byte-unchanged. Resolution-side gating (the four
  // resolvers in `apps/api/src/services/rtdb.ts`) does NOT substitute for
  // this: a token minted before this phase would still resolve without it.
  const mintKindResolution = await readSubjectKind(database, tenantId);
  if (mintKindResolution !== 'ordinary') {
    // Reuses the SAME class + message this function already throws for
    // input it will not serve — no new error class, nothing that names the
    // discriminator or reveals why (D-05 no-oracle).
    throw new NotFoundError(`Training session ${sessionId} not found`);
  }
  // Phase 30.1 (RTEN-03 re-scope, review H4): the SAME subject id
  // (`tenantId`) is checked against the demo allowlist, refusing with the
  // SAME NotFoundError this function already throws (D-05 no-oracle).
  if (isDemoAccountSubject(demoConfig, tenantId)) {
    throw new NotFoundError(`Training session ${sessionId} not found`);
  }

  const sessionSnapshot = await database.ref(`trainingSessions/${tenantId}/${sessionId}`).get();
  if (!sessionSnapshot.exists()) {
    throw new NotFoundError(`Training session ${sessionId} not found`);
  }
  const rawSession = sessionSnapshot.val() as Record<string, unknown>;
  // RTDB drops any key whose value is an empty array on write — normalize
  // missing `characterTags`/`homework` back to `[]` before validating,
  // mirroring `sessions.ts`'s `parseSessionRecord` discipline exactly (this
  // module reads the SAME live `trainingSessions` node that service owns).
  const normalizedSession = {
    ...rawSession,
    characterTags: rawSession.characterTags ?? [],
    homework: rawSession.homework ?? [],
  };
  const liveSession = trainingSessionSchema.parse(normalizedSession);
  const clientVisible: ClientVisibleSession = clientVisibleSessionSchema.parse({
    date: liveSession.date,
    characterTags: liveSession.characterTags,
    summary: liveSession.summary,
    homework: liveSession.homework.map((item) => ({ text: item.text, done: item.done })),
    ...(liveSession.linkedMatchIds !== undefined
      ? { linkedMatchIds: liveSession.linkedMatchIds }
      : {}),
  } satisfies ClientVisibleSession);

  // Phase 21 (DLVX-02/DLVX-04, D-10/Pitfall 3): freeze the coach-picked VODs
  // BEFORE the atomic write below — resolved against the session's OWN
  // tenant (T-21-03), never re-read live afterward.
  const frozenIncludedVods: IncludedVod[] = await freezeIncludedVods(
    database,
    tenantId,
    options.includedVodMatchIds ?? [],
  );

  const token = generateShareToken();
  const deliveryRef = database.ref(`sessionDeliveries/${tenantId}/${sessionId}`).push();
  const deliveryId = deliveryRef.key;
  if (!deliveryId) {
    throw new Error('Failed to generate a push key for the new session delivery');
  }

  const now = Date.now();
  const tokenRecord: ShareToken = {
    shareId: buildSessionShareId(tenantId, sessionId, deliveryId),
    ownerUid: tenantId,
    permissions: 'view',
    createdAt: now,
  };
  const deliveryRecord = sessionDeliveryRecordSchema.parse({
    status: 'delivered',
    token,
    createdAt: now,
    revokedAt: null,
    snapshot: clientVisible,
    // Conditional-spread (CONCERNS.md null-stripping rule): a zero-pick
    // delivery writes NO includedVods key at all, never `[]`.
    ...(frozenIncludedVods.length > 0 ? { includedVods: frozenIncludedVods } : {}),
  } satisfies SessionDeliveryRecord);

  await database.ref().update({
    [`shareTokens/${token}`]: shareTokenSchema.parse(tokenRecord),
    [`sessionDeliveries/${tenantId}/${sessionId}/${deliveryId}`]: deliveryRecord,
  });

  return { deliveryId, token, url: `${webBaseUrl}/r/${token}` };
}

/**
 * Lists every delivery ever created for one session (coach-facing —
 * `GET .../deliveries`), most-recent-first. A corrupt/unparseable record is
 * skipped, never breaks the whole list (mirrors `listReviewDeliveries`'s
 * per-record safeParse-and-skip discipline).
 */
export async function listSessionDeliveries(
  database: Database,
  tenantId: string,
  sessionId: string,
  webBaseUrl: string,
): Promise<SessionDeliveryListItem[]> {
  const snapshot = await database.ref(`sessionDeliveries/${tenantId}/${sessionId}`).get();
  if (!snapshot.exists()) {
    return [];
  }
  const raw = snapshot.val() as Record<string, unknown>;

  const rows = Object.entries(raw).flatMap(([deliveryId, value]) => {
    const parsed = safeParseDeliveryRecord(value);
    if (!parsed) {
      return [];
    }
    const doneIndexes = resolveHomeworkDoneIndexes(
      parsed.snapshot.homework,
      parsed.homeworkProgress,
    );
    return [
      {
        deliveryId,
        ...parsed,
        revokedAt: parsed.revokedAt ?? null,
        url: `${webBaseUrl}/r/${parsed.token}`,
        homeworkDoneCount: doneIndexes.length,
        homeworkTotal: parsed.snapshot.homework.length,
        homeworkAcknowledgedAt: parsed.homeworkProgress?.acknowledgedAt ?? null,
        homeworkSubmittedAt: parsed.homeworkProgress?.submittedAt ?? null,
      },
    ];
  });

  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 260731-b1: builds the WIRE-shaped `HomeworkProgressResponse` for a
 * delivery record — the single place both `readHomeworkProgress` and the two
 * mutating functions below (`setHomeworkItemDone`/`setHomeworkStatus`)
 * derive their return value from, so all three answer with the identical
 * shape.
 */
function buildHomeworkProgressResponse(record: SessionDeliveryRecord): HomeworkProgressResponse {
  return {
    doneIndexes: resolveHomeworkDoneIndexes(record.snapshot.homework, record.homeworkProgress),
    acknowledgedAt: record.homeworkProgress?.acknowledgedAt ?? null,
    submittedAt: record.homeworkProgress?.submittedAt ?? null,
  };
}

/**
 * Resolves a delivery record for a homework read/write — `null` for a
 * missing, unparseable, or revoked delivery (T-B1-01/T-B1-02: the ONLY
 * mutation surface an anonymous token holder reaches is scoped to exactly
 * this delivery's `homeworkProgress` subtree, never the frozen `snapshot`
 * or the live `trainingSessions` tree).
 */
async function loadLiveDeliveryRecord(
  database: Database,
  tenantId: string,
  sessionId: string,
  deliveryId: string,
): Promise<SessionDeliveryRecord | null> {
  const snapshot = await database
    .ref(`sessionDeliveries/${tenantId}/${sessionId}/${deliveryId}`)
    .get();
  if (!snapshot.exists()) {
    return null;
  }
  const record = safeParseDeliveryRecord(snapshot.val());
  if (!record || record.revokedAt != null) {
    return null;
  }
  return record;
}

/**
 * 260731-b1 (F1/F3/F4): reads the current homework progress for a session
 * delivery — `null` for a missing/unparseable/revoked delivery (never
 * throws; the anonymous route collapses that to the shared 404 body). A
 * delivery no client has ever touched still resolves cleanly: an empty
 * `doneIndexes`-equivalent state and two null stamps, never a parse
 * failure.
 */
export async function readHomeworkProgress(
  database: Database,
  tenantId: string,
  sessionId: string,
  deliveryId: string,
): Promise<HomeworkProgressResponse | null> {
  const record = await loadLiveDeliveryRecord(database, tenantId, sessionId, deliveryId);
  if (!record) {
    return null;
  }
  return buildHomeworkProgressResponse(record);
}

/**
 * 260731-b1 (F3/F4, T-B1-02): flips ONE homework item's done-state.
 * `null` for a missing/unparseable/revoked delivery OR an `index` outside
 * `0 .. snapshot.homework.length - 1` (re-checked against the frozen
 * homework length server-side — the caller's own Zod body bound is not
 * trusted alone). Performs ONE atomic multi-path `.update()` writing the
 * LITERAL boolean (never `null` for an uncheck — that would erase the
 * "explicitly unchecked" distinction F4 depends on) at
 * `.../homeworkProgress/items/{homeworkProgressKey(index)}` plus the current
 * epoch ms at the sibling `.../homeworkProgress/updatedAt`.
 */
export async function setHomeworkItemDone(
  database: Database,
  tenantId: string,
  sessionId: string,
  deliveryId: string,
  index: number,
  done: boolean,
): Promise<HomeworkProgressResponse | null> {
  const record = await loadLiveDeliveryRecord(database, tenantId, sessionId, deliveryId);
  if (!record) {
    return null;
  }
  if (index < 0 || index >= record.snapshot.homework.length) {
    return null;
  }

  const basePath = `sessionDeliveries/${tenantId}/${sessionId}/${deliveryId}/homeworkProgress`;
  await database.ref().update({
    [`${basePath}/items/${homeworkProgressKey(index)}`]: done,
    [`${basePath}/updatedAt`]: Date.now(),
  });

  const existingItems: Record<string, boolean> = { ...(record.homeworkProgress?.items ?? {}) };
  existingItems[homeworkProgressKey(index)] = done;
  const updatedProgress: HomeworkProgress = {
    ...record.homeworkProgress,
    items: existingItems,
  };
  return buildHomeworkProgressResponse({ ...record, homeworkProgress: updatedProgress });
}

/**
 * 260731-b1 (F6): stamps `acknowledgedAt`/`submittedAt` — idempotent,
 * mirroring `setDeliveryAck`/`setDeliveryViewed`: only stamps a field that
 * is currently unset. `'submitted'` ALSO back-fills `acknowledgedAt` when
 * absent (a client who submits without an explicit prior ack is still
 * counted as having acknowledged). Submission does NOT lock the checklist —
 * a later `setHomeworkItemDone` call still succeeds (F6, no unlock/reopen
 * flow needed because there is nothing to unlock).
 */
export async function setHomeworkStatus(
  database: Database,
  tenantId: string,
  sessionId: string,
  deliveryId: string,
  status: 'acknowledged' | 'submitted',
): Promise<HomeworkProgressResponse | null> {
  const record = await loadLiveDeliveryRecord(database, tenantId, sessionId, deliveryId);
  if (!record) {
    return null;
  }

  const basePath = `sessionDeliveries/${tenantId}/${sessionId}/${deliveryId}/homeworkProgress`;
  const now = Date.now();
  const updates: Record<string, number> = {};
  const nextProgress: HomeworkProgress = { ...record.homeworkProgress };

  if (status === 'acknowledged' && record.homeworkProgress?.acknowledgedAt == null) {
    updates[`${basePath}/acknowledgedAt`] = now;
    nextProgress.acknowledgedAt = now;
  }
  if (status === 'submitted') {
    if (record.homeworkProgress?.submittedAt == null) {
      updates[`${basePath}/submittedAt`] = now;
      nextProgress.submittedAt = now;
    }
    if (record.homeworkProgress?.acknowledgedAt == null) {
      updates[`${basePath}/acknowledgedAt`] = now;
      nextProgress.acknowledgedAt = now;
    }
  }

  if (Object.keys(updates).length > 0) {
    updates[`${basePath}/updatedAt`] = now;
    nextProgress.updatedAt = now;
    await database.ref().update(updates);
  }

  return buildHomeworkProgressResponse({ ...record, homeworkProgress: nextProgress });
}

/**
 * Revokes a delivery: flips BOTH `sessionDeliveries/.../{deliveryId}`'s
 * `status`/`revokedAt` AND `shareTokens/{token}/revokedAt` in ONE atomic
 * multi-path update — the token write is the one `getShareByToken`'s
 * shared (kind-agnostic) revocation check actually gates on. Idempotent: an
 * already-revoked delivery is a silent no-op (returns `revoked: false`), so
 * the route never re-fires an event for a non-transition — mirrors
 * `revokeReviewDelivery` exactly.
 */
export async function revokeSessionDelivery(
  database: Database,
  tenantId: string,
  sessionId: string,
  deliveryId: string,
): Promise<{ revoked: boolean }> {
  const deliveryRef = database.ref(`sessionDeliveries/${tenantId}/${sessionId}/${deliveryId}`);
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
  await database.ref().update({
    [`sessionDeliveries/${tenantId}/${sessionId}/${deliveryId}/revokedAt`]: revokedAt,
    [`sessionDeliveries/${tenantId}/${sessionId}/${deliveryId}/status`]: 'revoked',
    [`shareTokens/${record.token}/revokedAt`]: revokedAt,
  });

  return { revoked: true };
}

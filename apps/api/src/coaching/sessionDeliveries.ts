import type { Database } from 'firebase-admin/database';
import { z } from 'zod';
import {
  clientVisibleSessionSchema,
  shareTokenSchema,
  trainingSessionSchema,
  type ClientVisibleSession,
  type ShareToken,
} from '@smash-tracker/shared';
import { buildSessionShareId, NotFoundError } from '../services/rtdb.js';
import { generateShareToken } from '../shares/token.js';

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
});
export type SessionDeliveryRecord = z.infer<typeof sessionDeliveryRecordSchema>;

/**
 * RTDB drops any key whose value is an empty array on write — the embedded
 * `snapshot.characterTags`/`snapshot.homework` round-trip with NO key at all
 * when a session had zero tags/homework at delivery time. Every READ of a
 * delivery record must normalize those missing keys back to `[]` before
 * validating, mirroring `sessions.ts`'s `parseSessionRecord` discipline
 * exactly, but one level deeper (on the embedded `snapshot` object).
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
  return sessionDeliveryRecordSchema.parse({ ...rawRecord, snapshot: normalizedSnapshot });
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
): Promise<{ deliveryId: string; token: string; url: string }> {
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
    return [
      {
        deliveryId,
        ...parsed,
        revokedAt: parsed.revokedAt ?? null,
        url: `${webBaseUrl}/r/${parsed.token}`,
      },
    ];
  });

  return rows.sort((a, b) => b.createdAt - a.createdAt);
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

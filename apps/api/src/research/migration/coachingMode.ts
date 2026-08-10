import type { Database } from 'firebase-admin/database';
import { isPathSafeTenantId } from '../subjectKind.js';

/**
 * Phase 30.1 (Demo Account Topology & Migration, ACCT-03): the SINGLE
 * enablement primitive Plan 04's migration CLI calls to turn on Coaching
 * mode for IzAw's demo account.
 *
 * Deliberately NOT `RtdbService.upsertUser` — that method unconditionally
 * re-sets `users/{uid}/email` (`apps/api/src/services/rtdb.ts` 479-499),
 * which would clobber the address the owner set at account sign-up.
 * `enableCoachingMode` mirrors `upsertUser`'s own field-scoped write
 * discipline instead: it writes ONLY `users/{uid}/coachingModeEnabled` and
 * never `set()`s the whole `users/{uid}` node, so every pre-existing field
 * (email, onboardingIntent, anything else) survives untouched.
 *
 * STANDARDIZED silent path (review H3): this is a direct RTDB write with no
 * import of `../../events/*` and no route through `PUT /users/me` — it
 * emits ZERO canonical-ledger/GA4 events. The Profile-UI toggle is NOT an
 * equivalent for migration/seeding purposes (that path emits
 * `coaching_mode_enabled`); this helper is the one the migration CLI must
 * use for IzAw's account.
 *
 * Idempotent: re-running simply sets the same field to `true` again. Guards
 * `izawUid` with `isPathSafeTenantId` BEFORE constructing any ref — both the
 * real Admin SDK and `FakeDatabase` reject RTDB-illegal path characters
 * synchronously at `ref()` construction, so validation must run first.
 */
export async function enableCoachingMode(database: Database, izawUid: string): Promise<void> {
  if (!isPathSafeTenantId(izawUid)) {
    throw new Error(`enableCoachingMode: unsafe uid "${izawUid}"`);
  }

  await database.ref(`users/${izawUid}/coachingModeEnabled`).set(true);
}

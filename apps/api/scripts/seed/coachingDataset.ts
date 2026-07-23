import { randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  clientMembershipSchema,
  clientTenantRecordSchema,
  clientVisibleVersionSchema,
  coachClientEntrySchema,
  type ClientVisibleVersion,
} from '@smash-tracker/shared';
import { RtdbService } from '../../src/services/rtdb.js';
import { autosaveDraft, getDraft, reviewStatusRecordSchema } from '../../src/coaching/reviews.js';
import { createReviewDelivery } from '../../src/coaching/reviewDeliveries.js';
import { ManifestRecorder, backdateTime } from './manifest.js';
import {
  buildClientMatches,
  buildClientReviewDraft,
  buildClientVodNotes,
  CLIENT_VOD_TABLE,
  FIGHTER_STEVE,
} from './content.js';

/**
 * Phase 15 (PAND-01..05, SEED-06): the coaching-dataset orchestrator —
 * provisions the Pandemic managed client and drives the full review loop
 * (client library -> authored draft -> published immutable v1 -> minted
 * delivery) through the SAME zero-canonical-ledger-write discipline
 * `personalDataset.ts` already proved out (Phase 14).
 *
 * Per 15-RESEARCH.md's write-path verdicts: `RtdbService.createMatch`/
 * `createNote`/`setFighterSelection`, `autosaveDraft`/`getDraft`, and
 * `createReviewDelivery` are called DIRECTLY (their own modules have no
 * `../events` import — separable, zero-ledger by construction). Two
 * `coaching/*` functions emit a canonical event INLINE and unconditionally —
 * the managed-client creator (`tenants.ts`) and the review-version publisher
 * (`reviews.ts`) — so NEITHER is ever imported here; instead their
 * durable-write halves are replicated below (`createManagedClientDirect`/
 * `publishVersionDirect`), validated against the SAME exported Zod schemas.
 *
 * Import surface is intentionally limited to `RtdbService`
 * (`../../src/services/rtdb.js`), the two separable `coaching/*` functions
 * named above, `./manifest.js`, `./content.js`, `@smash-tracker/shared`, and
 * `node:crypto` — no import from `apps/api/src/events`, `routes`, the
 * managed-client creator in `../../src/coaching/tenants.js`, or the
 * review-version publisher in `../../src/coaching/reviews.js` (SEED-06).
 */

export interface RunSeedCoachingOptions {
  ownerUid: string;
  now: number;
  webBaseUrl: string;
}

export interface RunSeedCoachingResult {
  deliveryUrl: string;
  token: string;
}

/**
 * Replicates ONLY the durable multi-path write the managed-client creator
 * performs (`apps/api/src/coaching/tenants.ts:123-206`) — the `createEvent`
 * call at that function's lines 193-203 is deliberately NOT replicated. A
 * fresh `randomUUID()` tenantId can never collide with an existing one, so
 * the uniqueness/cap transaction machinery the real creator needs for a
 * real multi-tenant coach is unnecessary for this single deterministic seed
 * run.
 */
async function createManagedClientDirect(
  database: Database,
  coachUid: string,
  label: string,
  now: number,
): Promise<{ tenantId: string }> {
  const tenantId = randomUUID();
  await database.ref().update({
    [`coachClients/${coachUid}/${tenantId}`]: coachClientEntrySchema.parse({
      label,
      createdAt: now,
      archivedAt: null,
    }),
    [`clientTenants/${tenantId}`]: clientTenantRecordSchema.parse({
      createdAt: now,
      archivedAt: null,
    }),
    [`clientMembers/${tenantId}/${coachUid}`]: clientMembershipSchema.parse({
      role: 'custodian',
      joinedAt: now,
    }),
  });
  return { tenantId };
}

/**
 * Replicates ONLY the durable seal write the review-version publisher
 * performs (`apps/api/src/coaching/reviews.ts:196-234,244-287`) — the
 * `createEvent` call at that function's lines 274-284 is deliberately NOT
 * replicated. For a fresh review with no prior published version,
 * `reserveNextVersion`'s output is trivially always `1`, so that transaction
 * is skipped entirely in favor of a plain literal.
 */
async function publishVersionDirect(
  database: Database,
  tenantId: string,
  reviewId: string,
  now: number,
): Promise<void> {
  const draft = await getDraft(database, tenantId, reviewId);
  const sealed: ClientVisibleVersion = clientVisibleVersionSchema.parse({
    sections: draft.sections
      .filter((section) => !section.hidden)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `hidden` is intentionally discarded
      .map(({ hidden: _hidden, ...rest }) => rest),
    publishedAt: now,
  });

  await database.ref().update({
    [`reviewVersionIndex/${tenantId}/${reviewId}`]: { '1': true },
    [`reviewVersions/${tenantId}/${reviewId}/1`]: sealed,
    [`reviewStatus/${tenantId}/${reviewId}`]: reviewStatusRecordSchema.parse({
      status: 'published',
      latestVersion: 1,
    }),
  });
}

const PANDEMIC_LABEL = 'Pandemic';

/**
 * Seeds the Pandemic managed-client coaching dataset for `ownerUid`:
 * coaching mode enabled, one managed client tenant, a >=15-match/5-VOD Steve
 * client library, one authored-and-published 6-section review with
 * populated coach-private notes, and a live delivery capability. Merges its
 * own recorded paths with the personal manifest `runSeedDemo` just flushed
 * so ONE `demoSeed/{ownerUid}` manifest covers the entire seed (personal +
 * coaching) — `--wipe` removes both in one pass.
 */
export async function runSeedCoaching(
  database: Database,
  opts: RunSeedCoachingOptions,
): Promise<RunSeedCoachingResult> {
  const { ownerUid, now, webBaseUrl } = opts;

  // 1. Pre-seed a ManifestRecorder with the personal manifest runSeedDemo
  //    just flushed, so the final flush() below is ONE merged manifest.
  const recorder = new ManifestRecorder();
  const existingManifestSnapshot = await database.ref(`demoSeed/${ownerUid}`).get();
  if (existingManifestSnapshot.exists()) {
    const existing = existingManifestSnapshot.val() as { paths?: string[] };
    for (const path of existing.paths ?? []) {
      recorder.record(path);
    }
  }

  // 2. Coaching-mode flag: a REAL, pre-existing leaf on the owner's profile
  //    — capture the prior value (never recorded as a manifest path; the
  //    manifest's own priorCoachingModeEnabled memo restores it on wipe).
  const priorFlagSnapshot = await database.ref(`users/${ownerUid}/coachingModeEnabled`).get();
  const priorCoachingModeEnabled = priorFlagSnapshot.exists()
    ? (priorFlagSnapshot.val() as boolean)
    : null;
  await database.ref(`users/${ownerUid}/coachingModeEnabled`).set(true);

  // 3. Managed client tenant (durable-write half only, per RESEARCH.md
  //    Pattern 2 — never calls the real managed-client creator).
  const { tenantId } = await createManagedClientDirect(database, ownerUid, PANDEMIC_LABEL, now);
  recorder.record(`coachClients/${ownerUid}/${tenantId}`);
  recorder.record(`clientTenants/${tenantId}`);
  recorder.record(`clientMembers/${tenantId}/${ownerUid}`);

  // 4. Client library — Steve primary fighter, ~24 matches, 5 VOD-coherent
  //    with annotated notes. Every write routed through RtdbService (never
  //    a raw object write), mirroring personalDataset.ts's own discipline.
  const rtdb = new RtdbService(database);
  await rtdb.setFighterSelection(tenantId, { primary: [FIGHTER_STEVE], secondary: [] });
  recorder.record(`primaryFighters/${tenantId}`);
  recorder.record(`secondaryFighters/${tenantId}`);

  const matchEntries = buildClientMatches(now);
  const vodNotesByIndex = buildClientVodNotes();
  const vodIndexToMatchId: Record<number, string> = {};
  const recordedOpponents = new Set<string>();
  let vodIndex = 0;

  for (const { input, timeMs } of matchEntries) {
    const match = await rtdb.createMatch(tenantId, input);
    recorder.record(`matches/${tenantId}/${match.id}`);
    await backdateTime(database, `matches/${tenantId}/${match.id}`, timeMs);

    if (input.opponent !== undefined && !recordedOpponents.has(input.opponent)) {
      recordedOpponents.add(input.opponent);
      recorder.record(`opponents/${tenantId}/${input.opponent}`);
    }

    if (input.vodUrl !== undefined) {
      vodIndexToMatchId[vodIndex] = match.id;
      for (const note of vodNotesByIndex[vodIndex] ?? []) {
        await rtdb.createNote(tenantId, match.id, note);
      }
      vodIndex += 1;
    }
  }

  // 5. Authored review draft — sections cite the REAL client VOD match ids
  //    captured above, in CLIENT_VOD_TABLE order (Pitfall 4, 15-RESEARCH.md).
  const clientVodMatchIds = CLIENT_VOD_TABLE.map((_vod, index) => vodIndexToMatchId[index]!);
  const { sections, coachPrivateNotes } = buildClientReviewDraft(clientVodMatchIds);
  const reviewId = randomUUID();
  await autosaveDraft(database, tenantId, reviewId, { sections, coachPrivateNotes }, 0);
  recorder.record(`reviewDrafts/${tenantId}/${reviewId}`);

  // 6. Publish as immutable v1 (durable-write half only — never calls the
  //    real review-version publisher).
  await publishVersionDirect(database, tenantId, reviewId, now);
  recorder.record(`reviewVersionIndex/${tenantId}/${reviewId}`);
  recorder.record(`reviewVersions/${tenantId}/${reviewId}/1`);
  recorder.record(`reviewStatus/${tenantId}/${reviewId}`);

  // 7. Mint the delivery capability for exactly the published version (real
  //    function, zero-ledger).
  const { deliveryId, token, url } = await createReviewDelivery(
    database,
    tenantId,
    reviewId,
    1,
    webBaseUrl,
  );
  recorder.record(`reviewDeliveries/${tenantId}/${reviewId}/${deliveryId}`);
  recorder.record(`shareTokens/${token}`);

  // 8. Flush the ONE merged manifest (personal + coaching paths).
  await recorder.flush(database, ownerUid, now, { priorCoachingModeEnabled });

  return { deliveryUrl: url, token };
}

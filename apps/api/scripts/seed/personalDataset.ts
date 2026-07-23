import type { Database } from 'firebase-admin/database';
import { RtdbService } from '../../src/services/rtdb.js';
import { ManifestRecorder, backdateTime, wipeDemo } from './manifest.js';
import {
  buildGspSeries,
  buildGspSettings,
  buildOpponentNotes,
  buildOpponents,
  buildPersonalMatches,
  buildPlaylists,
  buildVodNotes,
} from './content.js';

/**
 * Phase 14 (SEED-01/SEED-04/SEED-06): the seeder orchestrator. Composes the
 * 14-02 pure content builders with 14-01's manifest/wipe/back-date
 * primitives, driving every write through `RtdbService`'s public methods —
 * never a raw object write — so validation, null-stripping, and per-user
 * caps apply exactly as they do for a real user action. The only writes NOT
 * routed through `RtdbService` are the `demoSeed/{uid}` manifest flush and
 * the per-record `time` leaf back-date patch (both from `manifest.ts`).
 *
 * Import surface is intentionally limited to `RtdbService`
 * (`../../src/services/rtdb.js`), `./manifest.js`, and `./content.js` (which
 * itself only imports `@smash-tracker/shared`) — no import from
 * `apps/api/src/events`, `routes`, `jobs`, `coaching`, `billing`, or
 * `onboarding`. This makes `createEvent` (the sole writer of
 * `eventLedger`/`outboxPending`/`eventDedup` — see `src/events/ledger.ts`)
 * structurally unreachable from this file's import graph, mirroring the
 * Phase-10 soak window's requirement that manual/seed writes never emit
 * canonical measurement events (SEED-06).
 */

export interface RunSeedDemoOptions {
  uid: string;
  now: number;
}

/**
 * Seeds the full personal showcase dataset for `uid`. If a prior seed
 * manifest exists for `uid`, it is wiped FIRST (wipe-then-reseed refresh
 * semantics) so a second run never duplicates records (SEED-04) — idempotent
 * by construction, not by deduping against existing content.
 */
export async function runSeedDemo(database: Database, opts: RunSeedDemoOptions): Promise<void> {
  const { uid, now } = opts;

  const existingManifest = await database.ref(`demoSeed/${uid}`).get();
  if (existingManifest.exists()) {
    await wipeDemo(database, uid);
  }

  const rtdb = new RtdbService(database);
  const recorder = new ManifestRecorder();

  // 1. Matches — back-date each immediately after write, and for the (first
  //    10, VOD-coherent) matches carrying a vodUrl, capture the real
  //    push-key id and attach the 14-02 VOD notes.
  const matchEntries = buildPersonalMatches(now);
  const vodNotesByIndex = buildVodNotes();
  const vodIndexToMatchId: Record<number, string> = {};
  let vodIndex = 0;

  for (const { input, timeMs } of matchEntries) {
    const match = await rtdb.createMatch(uid, input);
    recorder.record(`matches/${uid}/${match.id}`);
    await backdateTime(database, `matches/${uid}/${match.id}`, timeMs);

    if (input.vodUrl !== undefined) {
      vodIndexToMatchId[vodIndex] = match.id;
      for (const note of vodNotesByIndex[vodIndex] ?? []) {
        await rtdb.createNote(uid, match.id, note);
      }
      vodIndex += 1;
    }
  }

  // 2. Opponents — createMatch already auto-created each via addOpponent();
  //    the manifest still needs the path recorded so --wipe removes it.
  for (const opponent of buildOpponents()) {
    recorder.record(`opponents/${uid}/${opponent.name}`);
  }

  // 3. Opponent notes — same (pre-lowercased) name createMatch used;
  //    setOpponentNote itself does NOT lowercase.
  for (const { name, input } of buildOpponentNotes()) {
    await rtdb.setOpponentNote(uid, name, input);
    recorder.record(`opponentNotes/${uid}/${name}`);
  }

  // 4. GSP settings (per-user singleton) + per-fighter reading series.
  await rtdb.setGspSettings(uid, buildGspSettings(now));
  recorder.record(`gspSettings/${uid}`);

  const gspSeriesByFighter = buildGspSeries(now);
  for (const entries of Object.values(gspSeriesByFighter)) {
    for (const { input, timeMs } of entries) {
      const reading = await rtdb.createGspReading(uid, input);
      recorder.record(`gspReadings/${uid}/${reading.id}`);
      await backdateTime(database, `gspReadings/${uid}/${reading.id}`, timeMs);
    }
  }

  // 5. Playlists — resolve VOD-match indices to the real push-key ids
  //    captured above, in sequence order.
  for (const { name, vodMatchIndices } of buildPlaylists()) {
    const playlist = await rtdb.createPlaylist(uid, { name });
    recorder.record(`playlists/${uid}/${playlist.id}`);
    await rtdb.updatePlaylist(uid, playlist.id, {
      matchIds: vodMatchIndices.map((index) => vodIndexToMatchId[index]!),
    });
  }

  await recorder.flush(database, uid, now);
}

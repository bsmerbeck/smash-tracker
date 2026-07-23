import type { Database } from 'firebase-admin/database';

/**
 * Phase 14 (SEED-02/SEED-03): the demo seeder never adds a `demoSeed` field
 * to any existing record — REQUIREMENTS.md's Out-of-Scope table and the
 * locked CONTEXT.md decision forbid schema changes. Instead, every RTDB
 * path the seeder writes is recorded here in memory and flushed to a
 * SEPARATE `demoSeed/{uid}` tree in one root multi-path `update()` (the same
 * atomic-write primitive `events/ledger.ts`'s `createEvent` uses for its
 * ledger+outbox pair). That manifest node IS the seed marker (SEED-02) and
 * is the sole input `wipeDemo` needs to remove exactly what was seeded,
 * nothing else (SEED-03).
 *
 * Import surface is intentionally limited to `firebase-admin` types — no
 * import from `apps/api/src/events`, `routes`, `jobs`, `coaching`,
 * `billing`, or `onboarding` (SEED-06's zero-ledger-write guarantee is a
 * structural property of this file never reaching `createEvent`).
 */

interface DemoSeedManifest {
  seededAt: number;
  paths: string[];
}

/**
 * Collects RTDB path strings in memory as the seeder writes records, then
 * flushes them under `demoSeed/{uid}` in a single write. Paths are stored as
 * string VALUES inside an array (`demoSeed/{uid}/paths`) rather than as RTDB
 * keys, because a path like `matches/{uid}/{id}` contains `/`, which is
 * illegal in an RTDB key.
 */
export class ManifestRecorder {
  private readonly paths: string[] = [];

  /** Appends a written RTDB path to the in-memory manifest. */
  record(path: string): void {
    this.paths.push(path);
  }

  /**
   * Writes the collected paths under `demoSeed/{uid}` as one node:
   * `{ seededAt: <epoch ms>, paths: string[] }`. `now` defaults to
   * `Date.now()` but accepts an override so tests (and the seeder's own
   * back-dated content) can pin a deterministic timestamp.
   */
  async flush(database: Database, uid: string, now: number = Date.now()): Promise<void> {
    const manifest: DemoSeedManifest = { seededAt: now, paths: [...this.paths] };
    await database.ref(`demoSeed/${uid}`).set(manifest);
  }
}

/**
 * Removes exactly the paths recorded in `demoSeed/{uid}`, plus the manifest
 * node itself, via one root multi-path `update()` with explicit null values
 * — never a prefix/wildcard delete of e.g. `matches/{uid}` (T-14-02). A
 * no-op (does not throw) when no manifest exists for the uid, so `--wipe`
 * is safe to run against an account that was never seeded.
 */
export async function wipeDemo(database: Database, uid: string): Promise<void> {
  const snapshot = await database.ref(`demoSeed/${uid}`).get();
  if (!snapshot.exists()) {
    return;
  }

  const manifest = snapshot.val() as DemoSeedManifest;
  const updates: Record<string, null> = {};
  for (const path of manifest.paths) {
    updates[path] = null;
  }
  updates[`demoSeed/${uid}`] = null;

  await database.ref().update(updates);
}

/**
 * Corrects the server-stamped `time` on an already-written match or GSP
 * reading. `RtdbService.createMatch`/`createGspReading` both hardcode
 * `time: Date.now()` and their input schemas reject a caller-supplied
 * `time`, so the seeder writes the record first (via the normal service
 * method, which returns the record's path) and then back-dates just the
 * `time` leaf — leaving every sibling field untouched.
 */
export async function backdateTime(database: Database, path: string, ms: number): Promise<void> {
  await database.ref(`${path}/time`).set(ms);
}

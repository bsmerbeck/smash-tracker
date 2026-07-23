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
  /**
   * Phase 15 (PAND-01/coaching-mode wipe-restore): the REAL, pre-existing
   * value of `users/{uid}/coachingModeEnabled` at the moment the seeder
   * flipped it on, captured so `wipeDemo` can restore the owner's genuine
   * prior state instead of unconditionally deleting a leaf the seeder does
   * not exclusively own. `undefined` (the field simply absent, e.g. a
   * pre-Phase-15 manifest or a seed run that never touched coaching mode)
   * means "leave this leaf alone on wipe" — backward compatible. `null`
   * means the leaf did not exist before the seed ran (wipe restores
   * absence, i.e. deletes it); a `boolean` means the owner already had that
   * exact value and wipe restores it verbatim.
   */
  priorCoachingModeEnabled?: boolean | null;
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
   *
   * `options.priorCoachingModeEnabled` (Phase 15, additive/backward
   * compatible): included in the written manifest ONLY when the caller
   * supplies it — a caller that omits `options` entirely (every Phase 14
   * call site) writes the EXACT same `{ seededAt, paths }` node it always
   * has, so this extension changes no existing behavior.
   */
  async flush(
    database: Database,
    uid: string,
    now: number = Date.now(),
    options?: { priorCoachingModeEnabled?: boolean | null },
  ): Promise<void> {
    const manifest: DemoSeedManifest = {
      seededAt: now,
      paths: [...this.paths],
      ...(options?.priorCoachingModeEnabled !== undefined
        ? { priorCoachingModeEnabled: options.priorCoachingModeEnabled }
        : {}),
    };
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
  const updates: Record<string, boolean | null> = {};
  for (const path of manifest.paths) {
    updates[path] = null;
  }
  updates[`demoSeed/${uid}`] = null;

  // Phase 15 (PAND-01): `coachingModeEnabled` is a REAL, pre-existing leaf on
  // the owner's profile record, not seed-created data — a naive null-delete
  // would incorrectly turn coaching mode OFF for an owner who had already
  // enabled it manually before running the seeder. This leaf is intentionally
  // NEVER added to `manifest.paths` (restore, not delete) — it gets this one
  // special-cased line instead. A manifest without the field (pre-Phase-15,
  // or a seed run that never touched coaching mode) leaves the leaf
  // untouched entirely, per the field's own back-compat contract.
  if (manifest.priorCoachingModeEnabled !== undefined) {
    updates[`users/${uid}/coachingModeEnabled`] = manifest.priorCoachingModeEnabled;
  }

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

import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase, type FakeReference } from '../src/test-support/fakeDatabase.js';
import { UnsafeOutputPathError } from './outputPathGuard.js';
import {
  exportMatchesForUid,
  buildExportReceipt,
  assertSafeSparg0ExportOutPath,
} from './sparg0ExportCore.js';
// The CLI-arg parsing/emulator-refusal guard helpers live in the thin CLI
// composition root, not the core — importing them here (rather than
// invoking `main()`) is exactly the "assert by invoking the parsed-args/
// guard helper in the test, not by running against production" pattern
// this plan's acceptance criteria calls for. Importing `sparg0Export.ts` is
// safe: its `main()` invocation is guarded by an argv[1] check that never
// matches under the test runner.
import { parseSparg0ExportArgs, assertNotEmulator } from './sparg0Export.js';

const UID = 'sparg0-uid-0000000000000001';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/**
 * Wraps `database.ref` so every `FakeReference` it hands back has its write
 * methods spied on BEFORE `exportMatchesForUid` ever touches it — the
 * read-only proof this test asserts (mirrors
 * `acctTopologyAuditCore.test.ts`'s in-memory `Database` double, per this
 * task's `read_first`).
 */
function watchWrites(database: FakeDatabase): { refs: FakeReference[] } {
  const originalRef = database.ref.bind(database);
  const refs: FakeReference[] = [];
  vi.spyOn(database, 'ref').mockImplementation((path?: string) => {
    const ref = originalRef(path);
    vi.spyOn(ref, 'set');
    vi.spyOn(ref, 'update');
    vi.spyOn(ref, 'remove');
    vi.spyOn(ref, 'push');
    vi.spyOn(ref, 'transaction');
    refs.push(ref);
    return ref;
  });
  return { refs };
}

function assertNoWrites(refs: readonly FakeReference[]): void {
  expect(refs.length).toBeGreaterThan(0); // the read actually happened through a watched ref
  for (const ref of refs) {
    expect(ref.set).not.toHaveBeenCalled();
    expect(ref.update).not.toHaveBeenCalled();
    expect(ref.remove).not.toHaveBeenCalled();
    expect(ref.push).not.toHaveBeenCalled();
    expect(ref.transaction).not.toHaveBeenCalled();
  }
}

describe('exportMatchesForUid — read-only proof', () => {
  it('performs zero write-method invocations on the database double', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      pushKey1: { fighter_id: 1, opponent_id: 8, time: 1_700_000_000_000, win: true },
      pushKey2: { fighter_id: 1, opponent_id: 22, time: 1_700_000_100_000, win: false },
    });
    const { refs } = watchWrites(database);

    const result = await exportMatchesForUid({ database: asDatabase(database), uid: UID });

    assertNoWrites(refs);
    expect(result.uid).toBe(UID);
    expect(result.matchCount).toBe(2);
    expect(result.matches).toHaveLength(2);
  });

  it('self-check: the fixture database is non-empty, so a silently-empty double cannot vacuously pass', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      pushKey1: { fighter_id: 1, opponent_id: 8, time: 1_700_000_000_000, win: true },
    });

    const before = database.dump();
    expect(Object.keys(before)).not.toHaveLength(0);

    const result = await exportMatchesForUid({ database: asDatabase(database), uid: UID });
    expect(result.matchCount).toBeGreaterThan(0);
  });

  it('returns matchCount 0 and an empty matches array for a uid with no matches node — no write attempted either', async () => {
    const database = new FakeDatabase();
    const { refs } = watchWrites(database);

    const result = await exportMatchesForUid({ database: asDatabase(database), uid: UID });

    assertNoWrites(refs);
    expect(result.matchCount).toBe(0);
    expect(result.matches).toEqual([]);
  });

  it('exportedAt comes from the injected clock, never a bare Date.now() at call time', async () => {
    const database = new FakeDatabase();
    database.seed(`matches/${UID}`, {
      pushKey1: { fighter_id: 1, opponent_id: 8, time: 1_700_000_000_000, win: true },
    });

    const result = await exportMatchesForUid({
      database: asDatabase(database),
      uid: UID,
      clock: () => 1_800_000_000_000,
    });

    expect(result.exportedAt).toBe(1_800_000_000_000);
  });
});

describe('buildExportReceipt', () => {
  it('produces a stable sha256 over the serialized matches and carries every required field', async () => {
    const matches = [{ fighter_id: 1, opponent_id: 8, time: 1_700_000_000_000, win: true }];
    const receipt = await buildExportReceipt({
      uid: UID,
      matchCount: matches.length,
      matches,
      exportedAt: 1_800_000_000_000,
      databaseHost: 'smash-tracker-f97b7.firebaseio.com',
    });

    expect(receipt.uid).toBe(UID);
    expect(receipt.matchCount).toBe(1);
    expect(receipt.exportedAt).toBe(1_800_000_000_000);
    expect(receipt.databaseHost).toBe('smash-tracker-f97b7.firebaseio.com');
    expect(receipt.matchesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.matches).toEqual(matches);

    // Same input, same hash — the harness can confirm it is reading the file the owner produced.
    const receiptAgain = await buildExportReceipt({
      uid: UID,
      matchCount: matches.length,
      matches,
      exportedAt: 1_800_000_000_000,
      databaseHost: 'smash-tracker-f97b7.firebaseio.com',
    });
    expect(receiptAgain.matchesSha256).toBe(receipt.matchesSha256);

    // A different payload produces a different hash.
    const differentReceipt = await buildExportReceipt({
      uid: UID,
      matchCount: 0,
      matches: [],
      exportedAt: 1_800_000_000_000,
      databaseHost: 'smash-tracker-f97b7.firebaseio.com',
    });
    expect(differentReceipt.matchesSha256).not.toBe(receipt.matchesSha256);
  });
});

describe('parseSparg0ExportArgs', () => {
  it('requires both --uid and --out', () => {
    expect(() => parseSparg0ExportArgs([])).toThrow(/--uid is required/);
    expect(() => parseSparg0ExportArgs(['--uid', UID])).toThrow(/--out is required/);
  });

  it('parses both flags into Sparg0ExportArgs', () => {
    expect(parseSparg0ExportArgs(['--uid', UID, '--out', 'apps/api/sparg0-export.json'])).toEqual({
      uid: UID,
      outPath: 'apps/api/sparg0-export.json',
    });
  });

  it('rejects an unknown flag rather than silently ignoring it', () => {
    expect(() => parseSparg0ExportArgs(['--uid', UID, '--out', 'x.json', '--wat', 'y'])).toThrow(
      /unknown flag: --wat/,
    );
  });

  it('rejects a duplicate flag', () => {
    expect(() =>
      parseSparg0ExportArgs(['--uid', UID, '--uid', 'other', '--out', 'x.json']),
    ).toThrow(/duplicate flag: --uid/);
  });
});

describe('assertSafeSparg0ExportOutPath (WR-03/D-28)', () => {
  const REPO_ROOT = '/repo';

  it('refuses a path that traverses outside the repo root', () => {
    expect(() =>
      assertSafeSparg0ExportOutPath({
        outPath: '../x.json',
        repoRoot: REPO_ROOT,
        isGitIgnored: () => true,
      }),
    ).toThrow(UnsafeOutputPathError);
  });

  it('refuses a path that does not match the sparg0-export naming pattern', () => {
    expect(() =>
      assertSafeSparg0ExportOutPath({
        outPath: 'apps/api/wrong-name.json',
        repoRoot: REPO_ROOT,
        isGitIgnored: () => true,
      }),
    ).toThrow(/must match apps\/api\/sparg0-export\*\.json/);
  });

  it('refuses a matching path that git reports as tracked (not ignored)', () => {
    expect(() =>
      assertSafeSparg0ExportOutPath({
        outPath: 'apps/api/sparg0-export.json',
        repoRoot: REPO_ROOT,
        isGitIgnored: () => false,
      }),
    ).toThrow(/not confirmed ignored by git/);
  });

  it('allows the happy path: matching name, confirmed ignored', () => {
    expect(() =>
      assertSafeSparg0ExportOutPath({
        outPath: 'apps/api/sparg0-export.json',
        repoRoot: REPO_ROOT,
        isGitIgnored: () => true,
      }),
    ).not.toThrow();
  });

  it('happy path holds against the real repo .gitignore (no injected double)', () => {
    // No `isGitIgnored` override — exercises the real `git check-ignore -q`
    // against this repo's actual `.gitignore`, proving the D-28 rule is
    // really in place, not just asserted by a test double.
    const realRepoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    expect(() =>
      assertSafeSparg0ExportOutPath({
        outPath: 'apps/api/sparg0-export.json',
        repoRoot: realRepoRoot,
      }),
    ).not.toThrow();
  });
});

describe('assertNotEmulator', () => {
  it('does nothing when no emulator host is set', () => {
    expect(() => assertNotEmulator(undefined)).not.toThrow();
  });

  it('throws naming the emulator variable when FIREBASE_DATABASE_EMULATOR_HOST is set', () => {
    expect(() => assertNotEmulator('127.0.0.1:9000')).toThrow(
      /FIREBASE_DATABASE_EMULATOR_HOST is set \(127\.0\.0\.1:9000\)/,
    );
  });
});

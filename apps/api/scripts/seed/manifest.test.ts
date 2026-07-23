import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../src/test-support/fakeDatabase.js';
import { ManifestRecorder, backdateTime, wipeDemo } from './manifest.js';

const FIXED_NOW = Date.UTC(2026, 6, 23, 12, 0, 0);

describe('ManifestRecorder', () => {
  it('records paths in memory and flushes them under demoSeed/{uid} in one write', async () => {
    const database = new FakeDatabase();
    const recorder = new ManifestRecorder();

    recorder.record('matches/test-uid/match1');
    recorder.record('gspReadings/test-uid/reading1');

    await recorder.flush(database as never, 'test-uid', FIXED_NOW);

    const dump = database.dump() as Record<string, unknown>;
    const manifest = (dump.demoSeed as Record<string, unknown> | undefined)?.['test-uid'] as
      { seededAt: number; paths: string[] } | undefined;

    expect(manifest).toBeDefined();
    expect(manifest?.seededAt).toBe(FIXED_NOW);
    expect(manifest?.paths).toEqual(['matches/test-uid/match1', 'gspReadings/test-uid/reading1']);
  });

  it('stores recorded paths as string values, never as RTDB keys', async () => {
    const database = new FakeDatabase();
    const recorder = new ManifestRecorder();
    recorder.record('matches/test-uid/match1');
    await recorder.flush(database as never, 'test-uid', FIXED_NOW);

    const dump = database.dump() as Record<string, unknown>;
    const manifestNode = (dump.demoSeed as Record<string, unknown>)['test-uid'] as Record<
      string,
      unknown
    >;
    // The path string lives as an array element (a VALUE), not as a key on
    // the manifest node — RTDB keys can't contain '/', which every recorded
    // path does.
    expect(Array.isArray(manifestNode.paths)).toBe(true);
    expect(Object.keys(manifestNode)).toEqual(['seededAt', 'paths']);
  });
});

describe('wipeDemo', () => {
  it('removes exactly the manifest-recorded paths plus the manifest node, leaving a non-recorded sibling intact', async () => {
    const database = new FakeDatabase();

    // A recorded (to-be-wiped) match.
    database.seed('matches/test-uid/match1', { fighter_id: 28, win: true, time: 111 });
    // A non-recorded survivor record under the SAME uid.
    database.seed('matches/test-uid/match2', { fighter_id: 86, win: false, time: 222 });
    database.seed('demoSeed/test-uid', {
      seededAt: FIXED_NOW,
      paths: ['matches/test-uid/match1'],
    });

    await wipeDemo(database as never, 'test-uid');

    const dump = database.dump() as Record<string, unknown>;
    const matches = (dump.matches as Record<string, Record<string, unknown>>)['test-uid'];
    expect(matches?.match1).toBeUndefined();
    expect(matches?.match2).toEqual({ fighter_id: 86, win: false, time: 222 });

    const demoSeed = dump.demoSeed as Record<string, unknown> | undefined;
    expect(demoSeed?.['test-uid']).toBeUndefined();
  });

  it('is a no-op when no manifest exists for the uid', async () => {
    const database = new FakeDatabase();
    database.seed('matches/test-uid/match1', { fighter_id: 28, win: true, time: 111 });

    await expect(wipeDemo(database as never, 'test-uid')).resolves.not.toThrow();

    const dump = database.dump() as Record<string, unknown>;
    const matches = (dump.matches as Record<string, Record<string, unknown>>)['test-uid'];
    expect(matches?.match1).toEqual({ fighter_id: 28, win: true, time: 111 });
  });

  // Phase 15 (PAND-01): coachingModeEnabled restore-on-wipe.

  it('restores users/{uid}/coachingModeEnabled to the manifest-recorded prior value (true)', async () => {
    const database = new FakeDatabase();
    database.seed('users/test-uid/coachingModeEnabled', true);
    const recorder = new ManifestRecorder();
    recorder.record('clientTenants/tenant1');
    await recorder.flush(database as never, 'test-uid', FIXED_NOW, {
      priorCoachingModeEnabled: true,
    });

    await wipeDemo(database as never, 'test-uid');

    const dump = database.dump() as Record<string, unknown>;
    const user = (dump.users as Record<string, Record<string, unknown>> | undefined)?.['test-uid'];
    expect(user?.coachingModeEnabled).toBe(true);
  });

  it('restores users/{uid}/coachingModeEnabled to absent when the manifest-recorded prior value is null', async () => {
    const database = new FakeDatabase();
    database.seed('users/test-uid/coachingModeEnabled', true);
    const recorder = new ManifestRecorder();
    recorder.record('clientTenants/tenant1');
    await recorder.flush(database as never, 'test-uid', FIXED_NOW, {
      priorCoachingModeEnabled: null,
    });

    await wipeDemo(database as never, 'test-uid');

    const dump = database.dump() as Record<string, unknown>;
    const user = (dump.users as Record<string, Record<string, unknown>> | undefined)?.['test-uid'];
    expect(user?.coachingModeEnabled).toBeUndefined();
  });

  it('leaves an existing coachingModeEnabled leaf untouched when the manifest omits the option (old behavior)', async () => {
    const database = new FakeDatabase();
    database.seed('users/test-uid/coachingModeEnabled', true);
    const recorder = new ManifestRecorder();
    recorder.record('matches/test-uid/match1');
    await recorder.flush(database as never, 'test-uid', FIXED_NOW); // no options — pre-Phase-15 call shape

    await wipeDemo(database as never, 'test-uid');

    const dump = database.dump() as Record<string, unknown>;
    const user = (dump.users as Record<string, Record<string, unknown>> | undefined)?.['test-uid'];
    expect(user?.coachingModeEnabled).toBe(true);
  });
});

describe('backdateTime', () => {
  it('overwrites only the time leaf of an already-written record, leaving siblings intact', async () => {
    const database = new FakeDatabase();
    database.seed('matches/test-uid/match1', {
      fighter_id: 28,
      opponent_id: 85,
      win: true,
      time: 999999,
    });

    await backdateTime(database as never, 'matches/test-uid/match1', 123456);

    const dump = database.dump() as Record<string, unknown>;
    const match = (dump.matches as Record<string, Record<string, unknown>>)['test-uid']?.match1 as
      Record<string, unknown> | undefined;

    expect(match?.time).toBe(123456);
    expect(match?.fighter_id).toBe(28);
    expect(match?.opponent_id).toBe(85);
    expect(match?.win).toBe(true);
  });
});

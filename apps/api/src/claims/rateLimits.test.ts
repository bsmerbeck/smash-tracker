import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  checkAndIncrement,
  claimIssuancePath,
  claimRedemptionAccountPath,
  claimRedemptionIpPath,
  hashRateLimitSegment,
  hourShardKey,
} from './rateLimits.js';

const ILLEGAL_PATH_CHARS = /[.#$[\]]/;

describe('hourShardKey', () => {
  it('returns UTC YYYYMMDDHH with no separators', () => {
    expect(hourShardKey(Date.UTC(2026, 6, 24, 18, 42, 5))).toBe('2026072418');
  });

  it('output contains no character from the RTDB-illegal set', () => {
    expect(ILLEGAL_PATH_CHARS.test(hourShardKey(Date.UTC(2026, 6, 24, 18, 42, 5)))).toBe(false);
  });
});

describe('hashRateLimitSegment', () => {
  it('returns a 32-character lowercase hex string containing no dot', () => {
    const hash = hashRateLimitSegment('1.2.3.4');
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain('.');
  });

  it('is deterministic for the same input and distinct for distinct inputs', () => {
    expect(hashRateLimitSegment('1.2.3.4')).toBe(hashRateLimitSegment('1.2.3.4'));
    expect(hashRateLimitSegment('1.2.3.4')).not.toBe(hashRateLimitSegment('5.6.7.8'));
  });
});

describe('claimRedemptionAccountPath', () => {
  it('builds claimRedemptionAttempts/{uid}/{hourShardKey}', () => {
    const t = Date.UTC(2026, 6, 24, 18, 42, 5);
    expect(claimRedemptionAccountPath('uid-1', t)).toBe(
      `claimRedemptionAttempts/uid-1/${hourShardKey(t)}`,
    );
  });
});

describe('claimRedemptionIpPath', () => {
  it('builds claimRedemptionAttemptsByIp/{hashedIp}/{hourShardKey} with no raw IP or dots', () => {
    const t = Date.UTC(2026, 6, 24, 18, 42, 5);
    const path = claimRedemptionIpPath('1.2.3.4', t);
    expect(path).toBe(
      `claimRedemptionAttemptsByIp/${hashRateLimitSegment('1.2.3.4')}/${hourShardKey(t)}`,
    );
    expect(path).not.toContain('.');
  });

  it('survives a round trip through FakeDatabase.ref() without throwing for a real-shaped IPv4', () => {
    const t = Date.UTC(2026, 6, 24, 18, 42, 5);
    expect(() => new FakeDatabase().ref(claimRedemptionIpPath('1.2.3.4', t))).not.toThrow();
  });
});

describe('claimIssuancePath', () => {
  it('builds claimIssuanceAttempts/{coachUid}/{dayShardKey}', () => {
    const t = Date.UTC(2026, 6, 24, 18, 42, 5);
    // dayShardKey format is YYYYMMDD — assert structurally rather than re-deriving it here.
    expect(claimIssuancePath('coach-1', t)).toMatch(/^claimIssuanceAttempts\/coach-1\/\d{8}$/);
  });
});

describe('path builders are FakeDatabase-safe', () => {
  it('all three path builders can be passed to new FakeDatabase().ref() without throwing', () => {
    const t = Date.UTC(2026, 6, 24, 18, 42, 5);
    const database = new FakeDatabase();
    expect(() => database.ref(claimRedemptionAccountPath('uid-1', t))).not.toThrow();
    expect(() => database.ref(claimRedemptionIpPath('1.2.3.4', t))).not.toThrow();
    expect(() => database.ref(claimIssuancePath('coach-1', t))).not.toThrow();
  });
});

describe('checkAndIncrement', () => {
  const PATH = 'claimRedemptionAttempts/uid-1/2026072418';
  const LIMIT = 3;

  it('first attempt against an absent counter node commits 1 and returns true', async () => {
    const database = new FakeDatabase();
    const allowed = await checkAndIncrement(database as never, PATH, LIMIT);
    expect(allowed).toBe(true);
    expect((database.dump() as never as Record<string, unknown>).claimRedemptionAttempts).toEqual({
      'uid-1': { '2026072418': 1 },
    });
  });

  it('calls 2 through limit return true, with the stored value equal to the call index', async () => {
    const database = new FakeDatabase();
    for (let i = 1; i <= LIMIT; i += 1) {
      const allowed = await checkAndIncrement(database as never, PATH, LIMIT);
      expect(allowed).toBe(true);
      const dump = database.dump() as never as {
        claimRedemptionAttempts: { 'uid-1': Record<string, number> };
      };
      expect(dump.claimRedemptionAttempts['uid-1']['2026072418']).toBe(i);
    }
  });

  it('call number limit + 1 returns false and leaves the stored value at exactly limit', async () => {
    const database = new FakeDatabase();
    for (let i = 0; i < LIMIT; i += 1) {
      await checkAndIncrement(database as never, PATH, LIMIT);
    }
    const allowed = await checkAndIncrement(database as never, PATH, LIMIT);
    expect(allowed).toBe(false);
    const dump = database.dump() as never as {
      claimRedemptionAttempts: { 'uid-1': Record<string, number> };
    };
    expect(dump.claimRedemptionAttempts['uid-1']['2026072418']).toBe(LIMIT);
  });

  it('coerces a non-number seeded value (corrupt record) to 0 and commits 1', async () => {
    const database = new FakeDatabase();
    database.seed(PATH, 'not-a-number');
    const allowed = await checkAndIncrement(database as never, PATH, LIMIT);
    expect(allowed).toBe(true);
    const dump = database.dump() as never as {
      claimRedemptionAttempts: { 'uid-1': Record<string, number> };
    };
    expect(dump.claimRedemptionAttempts['uid-1']['2026072418']).toBe(1);
  });

  it('two different hour shard keys maintain independent counts', async () => {
    const database = new FakeDatabase();
    const pathHourA = 'claimRedemptionAttempts/uid-1/2026072418';
    const pathHourB = 'claimRedemptionAttempts/uid-1/2026072419';
    database.seed(pathHourA, LIMIT);

    const blockedHourA = await checkAndIncrement(database as never, pathHourA, LIMIT);
    expect(blockedHourA).toBe(false);

    const allowedHourB = await checkAndIncrement(database as never, pathHourB, LIMIT);
    expect(allowedHourB).toBe(true);
  });

  it('never returns undefined on a null/absent observed value (would return false on the first call)', async () => {
    const database = new FakeDatabase();
    const allowed = await checkAndIncrement(database as never, PATH, LIMIT);
    // This is the CR-01 regression case: an update function that aborts on
    // the null first run (returning the unchanged input, per the incorrect
    // research draft) would return `false` here instead of `true`.
    expect(allowed).toBe(true);
  });
});

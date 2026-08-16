import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import {
  computeForeignRowDigest,
  describeForeignRowDigestDelta,
  foreignRowDigestsMatch,
  readForeignRowDigest,
} from './foreignDigest.js';

/**
 * The digest is the preservation witness the Gate-6 audit consumes.
 * `preservedForeignCount` is deliberately shown to be insufficient here: a
 * mutated foreign row leaves the count identical and the digest different.
 */

const UID = 'demo-uid-1';

const MANUAL_ENTRY = {
  eventName: 'Locals #42',
  firstSetAt: 1_700_000_000_000,
  lastSetAt: 1_700_000_000_000,
  setsPlayed: 0,
  source: 'manual',
};
const LEGACY_STARTGG_ENTRY = {
  eventId: 987,
  eventName: 'Ultimate Singles',
  tournamentName: 'Synced Weekly',
  firstSetAt: 1_690_000_000_000,
  lastSetAt: 1_690_000_500_000,
  setsPlayed: 5,
};
const PARRYGG_ENTRY = {
  eventName: 'Ultimate Singles',
  firstSetAt: 1_691_000_000_000,
  lastSetAt: 1_691_000_900_000,
  setsPlayed: 2,
  source: 'parrygg',
};
const OWNED_ROW = {
  entryId: 'histimport:100',
  origin: 'admin-imported',
  provider: 'startgg',
  registryWitness: 'research-import:v1:100',
  eventName: 'Ultimate Singles',
};

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

describe('computeForeignRowDigest', () => {
  it('covers every non-registry child and ignores registry-owned rows', () => {
    const withoutOwned = computeForeignRowDigest(UID, {
      'manual-1': MANUAL_ENTRY,
      '987': LEGACY_STARTGG_ENTRY,
      'pgg-3': PARRYGG_ENTRY,
    });
    const withOwned = computeForeignRowDigest(UID, {
      'manual-1': MANUAL_ENTRY,
      '987': LEGACY_STARTGG_ENTRY,
      'pgg-3': PARRYGG_ENTRY,
      'histimport:100': OWNED_ROW,
    });
    expect(withoutOwned.count).toBe(3);
    expect(withoutOwned.keys).toEqual(['987', 'manual-1', 'pgg-3']);
    expect(withOwned.digest).toBe(withoutOwned.digest);
  });

  it('is insertion-order independent', () => {
    const a = computeForeignRowDigest(UID, { 'manual-1': MANUAL_ENTRY, 'pgg-3': PARRYGG_ENTRY });
    const b = computeForeignRowDigest(UID, { 'pgg-3': PARRYGG_ENTRY, 'manual-1': MANUAL_ENTRY });
    expect(a.digest).toBe(b.digest);
    expect(foreignRowDigestsMatch(a, b)).toBe(true);
  });

  it('CHANGES when a foreign row is mutated in place — the failure a count cannot see', () => {
    const before = computeForeignRowDigest(UID, { 'manual-1': MANUAL_ENTRY });
    const after = computeForeignRowDigest(UID, {
      'manual-1': { ...MANUAL_ENTRY, setsPlayed: 99 },
    });
    expect(after.count).toBe(before.count);
    expect(after.keys).toEqual(before.keys);
    expect(after.digest).not.toBe(before.digest);
    expect(foreignRowDigestsMatch(before, after)).toBe(false);
  });

  it('CHANGES when one foreign row is swapped for another (count unchanged)', () => {
    const before = computeForeignRowDigest(UID, { 'manual-1': MANUAL_ENTRY });
    const after = computeForeignRowDigest(UID, { 'pgg-3': PARRYGG_ENTRY });
    expect(after.count).toBe(before.count);
    expect(after.digest).not.toBe(before.digest);
  });

  it('binds the uid, so two accounts can never compare equal by accident', () => {
    expect(computeForeignRowDigest('uid-a', { 'manual-1': MANUAL_ENTRY }).digest).not.toBe(
      computeForeignRowDigest('uid-b', { 'manual-1': MANUAL_ENTRY }).digest,
    );
  });

  it('treats null/undefined children as absent, not as foreign rows', () => {
    const empty = computeForeignRowDigest(UID, {});
    expect(computeForeignRowDigest(UID, { gone: null, missing: undefined }).digest).toBe(
      empty.digest,
    );
    expect(empty.count).toBe(0);
    expect(empty.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('digests non-object foreign values (a corrupt scalar is still foreign)', () => {
    const digest = computeForeignRowDigest(UID, { weird: 'not-a-row' });
    expect(digest.count).toBe(1);
    expect(digest.digest).not.toBe(computeForeignRowDigest(UID, {}).digest);
  });
});

describe('readForeignRowDigest', () => {
  it('reads tournamentEntries/{uid} and digests only its foreign children', async () => {
    const database = new FakeDatabase();
    database.seed(`tournamentEntries/${UID}/manual-1`, MANUAL_ENTRY);
    database.seed(`tournamentEntries/${UID}/histimport:100`, OWNED_ROW);

    const digest = await readForeignRowDigest(asDatabase(database), UID);
    expect(digest.count).toBe(1);
    expect(digest.keys).toEqual(['manual-1']);
    expect(digest.digest).toBe(computeForeignRowDigest(UID, { 'manual-1': MANUAL_ENTRY }).digest);
  });

  it('returns the empty digest for an account with no entries at all', async () => {
    const digest = await readForeignRowDigest(asDatabase(new FakeDatabase()), UID);
    expect(digest).toMatchObject({ count: 0, keys: [] });
  });

  it('refuses a path-unsafe uid', async () => {
    await expect(readForeignRowDigest(asDatabase(new FakeDatabase()), 'bad/uid')).rejects.toThrow(
      /Unsafe uid/,
    );
  });
});

describe('describeForeignRowDigestDelta', () => {
  it('names added and removed keys', () => {
    const before = computeForeignRowDigest(UID, { 'manual-1': MANUAL_ENTRY });
    const after = computeForeignRowDigest(UID, { 'pgg-3': PARRYGG_ENTRY });
    const description = describeForeignRowDigestDelta(before, after);
    expect(description).toMatch(/added=\[pgg-3\]/);
    expect(description).toMatch(/removed=\[manual-1\]/);
  });

  it('says CONTENT changed when the key set is identical', () => {
    const before = computeForeignRowDigest(UID, { 'manual-1': MANUAL_ENTRY });
    const after = computeForeignRowDigest(UID, {
      'manual-1': { ...MANUAL_ENTRY, setsPlayed: 99 },
    });
    expect(describeForeignRowDigestDelta(before, after)).toMatch(/CONTENT changed/);
  });
});

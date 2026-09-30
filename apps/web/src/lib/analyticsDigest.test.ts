import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestSnapshot, Match } from '@smash-tracker/shared';
import {
  ANALYTICS_DIGEST_KEY_PREFIX,
  analyticsDigestStorageKey,
  countNewEvents,
  readStoredDigest,
  writeStoredDigest,
} from './analyticsDigest';

const SNAPSHOT: DigestSnapshot = {
  lastSeenAt: 1_700_000_000_000,
  lastSeenMatchCount: 10,
  tracked: { 'opponent:mkleo': 'steady', 'stage:1': 'up' },
};

describe('analyticsDigest store', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('keys per (uid, subject) through subjectSegment', () => {
    const own = analyticsDigestStorageKey('u1', null);
    const client = analyticsDigestStorageKey('u1', 'c9');
    expect(own.startsWith(`${ANALYTICS_DIGEST_KEY_PREFIX}.u1.`)).toBe(true);
    expect(client).not.toBe(own);
    expect(analyticsDigestStorageKey('u2', null)).not.toBe(own);
    expect(client).toContain('c9');
  });

  it('round-trips a snapshot and isolates subjects', () => {
    writeStoredDigest('u1', null, SNAPSHOT);
    expect(readStoredDigest('u1', null)).toEqual(SNAPSHOT);
    expect(readStoredDigest('u1', 'c9')).toBeNull();
    expect(readStoredDigest('u2', null)).toBeNull();
  });

  it('reads absent and corrupt values as a first visit', () => {
    expect(readStoredDigest('u1', null)).toBeNull();
    window.localStorage.setItem(analyticsDigestStorageKey('u1', null), '{not json');
    expect(readStoredDigest('u1', null)).toBeNull();
    window.localStorage.setItem(analyticsDigestStorageKey('u1', null), '{"lastSeenAt":"x"}');
    expect(readStoredDigest('u1', null)).toBeNull();
  });

  it('no-ops without a uid and never throws when the store does', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    writeStoredDigest(null, null, SNAPSHOT);
    expect(set).not.toHaveBeenCalled();
    expect(readStoredDigest(null, null)).toBeNull();

    set.mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => writeStoredDigest('u1', null, SNAPSHOT)).not.toThrow();
    expect(readStoredDigest('u1', null)).toBeNull();
  });
});

function game(id: string, time: number, eventName?: string, tournamentName?: string): Match {
  return { id, time, win: true, fighter_id: 1, opponent_id: 2, eventName, tournamentName } as Match;
}

describe('countNewEvents', () => {
  it('counts distinct event keys whose first game is later than lastSeenAt', () => {
    const matches = [
      game('a1', 100, 'Old Event'),
      game('a2', 300, 'Old Event'), // a later game of an event that began before lastSeenAt
      game('b1', 250, 'New A'),
      game('b2', 260, 'New A'),
      game('c1', 400, undefined, 'New B'), // tournamentName fallback
      game('d1', 500), // no event name: belongs to no event
      game('e1', 600, '   '), // whitespace reads as no event
    ];
    expect(countNewEvents(matches, 200)).toBe(2);
    expect(countNewEvents(matches, 0)).toBe(3);
    expect(countNewEvents(matches, 1000)).toBe(0);
    expect(countNewEvents([], 0)).toBe(0);
  });
});

describe('countNewEvents event identity (39.2-REVIEW WEB-CR-01)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('three same-named weeklies a week apart, last seen between the second and third: 1 new event, not 0', () => {
    const matches = [0, 7, 14].flatMap((day, i) =>
      [0, 1, 2].map((g) =>
        game(`w${i}-${g}`, day * DAY + g * 60_000, 'Ultimate Singles', `Weekly #${i}`),
      ),
    );
    expect(countNewEvents(matches, 10 * DAY)).toBe(1);
    expect(countNewEvents(matches, -1)).toBe(3);
  });
});

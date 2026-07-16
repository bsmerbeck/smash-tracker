import { describe, expect, it } from 'vitest';
import type { MatchRecord } from '@smash-tracker/shared';
import { buildShareSnapshot } from './buildShareSnapshot.js';
import { generateShareToken } from './token.js';

function makeMatch(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    fighter_id: 1,
    opponent_id: 2,
    time: 1000,
    win: true,
    vodUrl: 'https://youtu.be/abc123',
    ...overrides,
  };
}

describe('buildShareSnapshot', () => {
  it('with all toggles ON copies every included field', () => {
    const match = makeMatch({
      map: { id: 3, name: 'Battlefield' },
      vodStartSeconds: 15,
      vodTimestamps: [
        { seconds: 10, note: 'missed punish', tags: ['punish'] },
        { seconds: 90, note: 'good edgeguard' },
      ],
      tags: ['practice-friendlies'],
    });

    const snapshot = buildShareSnapshot(
      'uid-1',
      'match-1',
      match,
      { includeNotes: true, includeTags: true, showDisplayName: true },
      'Some Player',
    );

    expect(snapshot.result).toBe('win');
    expect(snapshot.fighterId).toBe(1);
    expect(snapshot.opponentFighterId).toBe(2);
    expect(snapshot.matchDate).toBe(1000);
    expect(snapshot.vodUrl).toBe('https://youtu.be/abc123');
    expect(snapshot.vodStartSeconds).toBe(15);
    expect(snapshot.stage).toEqual({ id: 3, name: 'Battlefield' });
    expect(snapshot.timestamps).toEqual([
      { seconds: 10, note: 'missed punish', tags: ['punish'] },
      { seconds: 90, note: 'good edgeguard' },
    ]);
    expect(snapshot.tags).toEqual(['practice-friendlies']);
    expect(snapshot.ownerDisplayName).toBe('Some Player');
    expect(snapshot.redaction).toEqual({
      includedNotes: true,
      includedTags: true,
      showDisplayName: true,
    });
  });

  it('with all toggles OFF omits timestamps/tags/ownerDisplayName keys entirely', () => {
    const match = makeMatch({
      vodTimestamps: [{ seconds: 10, note: 'missed punish' }],
      tags: ['practice-friendlies'],
    });

    const snapshot = buildShareSnapshot(
      'uid-1',
      'match-1',
      match,
      { includeNotes: false, includeTags: false, showDisplayName: false },
      'Some Player',
    );

    expect('timestamps' in snapshot).toBe(false);
    expect('tags' in snapshot).toBe(false);
    expect('ownerDisplayName' in snapshot).toBe(false);
    expect(snapshot.result).toBe('win');
    expect(snapshot.fighterId).toBe(1);
    expect(snapshot.redaction).toEqual({
      includedNotes: false,
      includedTags: false,
      showDisplayName: false,
    });
  });

  it('sets reviewedMomentsCount to the vodTimestamps length even when include-notes is OFF', () => {
    const match = makeMatch({
      vodTimestamps: [
        { seconds: 10, note: 'a' },
        { seconds: 20, note: 'b' },
      ],
    });

    const snapshot = buildShareSnapshot('uid-1', 'match-1', match, {
      includeNotes: false,
      includeTags: false,
      showDisplayName: false,
    });

    expect(snapshot.reviewedMomentsCount).toBe(2);
    expect('timestamps' in snapshot).toBe(false);
  });

  it('sets reviewedMomentsCount to 0 when the match has no timestamps', () => {
    const match = makeMatch();

    const snapshot = buildShareSnapshot('uid-1', 'match-1', match, {
      includeNotes: true,
      includeTags: true,
      showDisplayName: false,
    });

    expect(snapshot.reviewedMomentsCount).toBe(0);
    expect('timestamps' in snapshot).toBe(false);
  });

  it('omits stage when match.map is absent and vodStartSeconds when unset', () => {
    const match = makeMatch();

    const snapshot = buildShareSnapshot('uid-1', 'match-1', match, {
      includeNotes: true,
      includeTags: true,
      showDisplayName: false,
    });

    expect('stage' in snapshot).toBe(false);
    expect('vodStartSeconds' in snapshot).toBe(false);
  });

  it("omits a timestamp's tags sub-array when that note has no tags", () => {
    const match = makeMatch({
      vodTimestamps: [{ seconds: 10, note: 'no tags here' }],
    });

    const snapshot = buildShareSnapshot('uid-1', 'match-1', match, {
      includeNotes: true,
      includeTags: false,
      showDisplayName: false,
    });

    expect(snapshot.timestamps).toHaveLength(1);
    expect('tags' in snapshot.timestamps![0]!).toBe(false);
  });
});

describe('generateShareToken', () => {
  it('returns a ~43-char base64url string', () => {
    const token = generateShareToken();
    expect(token.length).toBeGreaterThanOrEqual(42);
    expect(token.length).toBeLessThanOrEqual(44);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never collides across two calls', () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).not.toBe(b);
  });
});

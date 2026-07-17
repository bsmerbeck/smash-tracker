import { describe, expect, it } from 'vitest';
import {
  createShareInputSchema,
  MAX_SHARES_PER_USER,
  publicShareSnapshotSchema,
  shareSnapshotSchema,
  shareTokenSchema,
} from './shares.js';

function fullyIncludedSnapshot() {
  return {
    uid: 'uid-1',
    matchId: 'match-1',
    createdAt: 1000,
    result: 'win' as const,
    fighterId: 1,
    opponentFighterId: 2,
    stage: { id: 3, name: 'Battlefield' },
    matchDate: 500,
    vodUrl: 'https://youtu.be/abc123',
    vodStartSeconds: 42,
    reviewedMomentsCount: 2,
    timestamps: [
      { seconds: 10, note: 'missed punish', tags: ['punish'] },
      { seconds: 90, note: 'good edgeguard' },
    ],
    tags: ['practice-friendlies'],
    ownerDisplayName: 'Some Player',
    redaction: {
      includedNotes: true,
      includedTags: true,
      showDisplayName: true,
    },
  };
}

function fullyRedactedSnapshot() {
  return {
    uid: 'uid-1',
    matchId: 'match-1',
    createdAt: 1000,
    result: 'loss' as const,
    fighterId: 1,
    opponentFighterId: 2,
    matchDate: 500,
    vodUrl: 'https://youtu.be/abc123',
    reviewedMomentsCount: 2,
    redaction: {
      includedNotes: false,
      includedTags: false,
      showDisplayName: false,
    },
  };
}

describe('shareSnapshotSchema', () => {
  it('round-trips a fully-included snapshot', () => {
    const parsed = shareSnapshotSchema.parse(fullyIncludedSnapshot());
    expect(parsed.timestamps).toHaveLength(2);
    expect(parsed.tags).toEqual(['practice-friendlies']);
    expect(parsed.ownerDisplayName).toBe('Some Player');
    expect(parsed.redaction).toEqual({
      includedNotes: true,
      includedTags: true,
      showDisplayName: true,
    });
  });

  it('round-trips a fully-redacted snapshot with excluded fields ABSENT, not null/empty', () => {
    const input = fullyRedactedSnapshot();
    const parsed = shareSnapshotSchema.parse(input);

    expect('timestamps' in input).toBe(false);
    expect('tags' in input).toBe(false);
    expect('ownerDisplayName' in input).toBe(false);
    expect(parsed.timestamps).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
    expect(parsed.ownerDisplayName).toBeUndefined();

    // redaction flags are always present, even when everything is excluded.
    expect(parsed.redaction.includedNotes).toBe(false);
    expect(parsed.redaction.includedTags).toBe(false);
    expect(parsed.redaction.showDisplayName).toBe(false);
  });

  it('rejects null and empty-array sentinels for excluded fields (nullish, not just optional, is not the write contract)', () => {
    // The schema itself accepts null (nullish) — this documents that the
    // WRITE PATH (buildShareSnapshot.ts) must never produce these, not that
    // the schema forbids them; nullish is the read-tolerance, not the
    // write-time representation of "excluded".
    const withNull = shareSnapshotSchema.parse({ ...fullyRedactedSnapshot(), timestamps: null });
    expect(withNull.timestamps).toBeNull();
  });

  it('has no field for opponent notes, the human opponent name, or playlist membership (structurally absent)', () => {
    const shape = shareSnapshotSchema.shape;
    expect(shape).not.toHaveProperty('notes');
    expect(shape).not.toHaveProperty('opponent');
    expect(shape).not.toHaveProperty('opponentName');
    expect(shape).not.toHaveProperty('playlistId');
    expect(shape).not.toHaveProperty('playlistIds');
  });

  it('sets reviewedMomentsCount independent of the include-notes toggle', () => {
    const redacted = shareSnapshotSchema.parse({
      ...fullyRedactedSnapshot(),
      reviewedMomentsCount: 5,
    });
    expect(redacted.reviewedMomentsCount).toBe(5);
    expect(redacted.timestamps).toBeUndefined();
  });
});

function fullyPopulatedPublicSnapshot() {
  return {
    createdAt: 1000,
    result: 'win' as const,
    fighterId: 1,
    opponentFighterId: 2,
    stage: { id: 3, name: 'Battlefield' },
    matchDate: 500,
    vodUrl: 'https://youtu.be/abc123',
    vodStartSeconds: 42,
    reviewedMomentsCount: 2,
    timestamps: [
      { seconds: 10, note: 'missed punish', tags: ['punish'] },
      { seconds: 90, note: 'good edgeguard' },
    ],
    tags: ['practice-friendlies'],
    ownerDisplayName: 'Some Player',
    redaction: {
      includedNotes: true,
      includedTags: true,
      showDisplayName: true,
    },
  };
}

function fullyRedactedPublicSnapshot() {
  return {
    createdAt: 1000,
    result: 'loss' as const,
    fighterId: 1,
    opponentFighterId: 2,
    matchDate: 500,
    vodUrl: 'https://youtu.be/abc123',
    reviewedMomentsCount: 2,
    redaction: {
      includedNotes: false,
      includedTags: false,
      showDisplayName: false,
    },
  };
}

describe('publicShareSnapshotSchema', () => {
  it('parses a fully-populated public object and yields every field except uid/matchId', () => {
    const parsed = publicShareSnapshotSchema.parse(fullyPopulatedPublicSnapshot());
    expect(parsed.timestamps).toHaveLength(2);
    expect(parsed.tags).toEqual(['practice-friendlies']);
    expect(parsed.ownerDisplayName).toBe('Some Player');
    expect(parsed.redaction).toEqual({
      includedNotes: true,
      includedTags: true,
      showDisplayName: true,
    });
    expect('uid' in parsed).toBe(false);
    expect('matchId' in parsed).toBe(false);
  });

  it('has no field for uid or matchId (structurally absent)', () => {
    const shape = publicShareSnapshotSchema.shape;
    expect(shape).not.toHaveProperty('uid');
    expect(shape).not.toHaveProperty('matchId');
  });

  it('parses a fully-redacted public object (timestamps/tags/ownerDisplayName absent)', () => {
    const input = fullyRedactedPublicSnapshot();
    const parsed = publicShareSnapshotSchema.parse(input);

    expect('timestamps' in input).toBe(false);
    expect('tags' in input).toBe(false);
    expect('ownerDisplayName' in input).toBe(false);
    expect(parsed.timestamps).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
    expect(parsed.ownerDisplayName).toBeUndefined();
  });

  it('rejects a (non-recap) object missing vodUrl — a review snapshot always needs one', () => {
    const withoutVodUrl = { ...fullyPopulatedPublicSnapshot() } as Record<string, unknown>;
    delete withoutVodUrl.vodUrl;
    const parsed = publicShareSnapshotSchema.safeParse(withoutVodUrl);
    expect(parsed.success).toBe(false);
  });

  it('a review public snapshot with vodUrl still parses (backward compatible, kind absent)', () => {
    const parsed = publicShareSnapshotSchema.parse(fullyPopulatedPublicSnapshot());
    expect(parsed.kind).toBeUndefined();
    expect(parsed.vodUrl).toBe('https://youtu.be/abc123');
  });

  it('parses a recap public snapshot (kind recap, tournament stats, no vodUrl)', () => {
    const parsed = publicShareSnapshotSchema.parse({
      createdAt: 1000,
      kind: 'recap' as const,
      recapSource: 'startgg' as const,
      tournamentName: 'The Big House 9',
      tournamentDate: 500,
      placement: 3,
      seed: 8,
      numEntrants: 128,
      setRecordWins: 2,
      setRecordLosses: 1,
      notableWinOpponentName: 'RivalTag',
      notableWinOpponentSeed: 1,
      characterFighterIds: [1, 5],
      reviewedMomentsCount: 4,
      ownerDisplayName: 'Some Player',
    });
    expect(parsed.kind).toBe('recap');
    expect(parsed.tournamentName).toBe('The Big House 9');
    expect(parsed.setRecordWins).toBe(2);
    expect(parsed.characterFighterIds).toEqual([1, 5]);
    expect('vodUrl' in parsed).toBe(false);
  });

  it('rejects a recap snapshot missing required recap fields', () => {
    const result = publicShareSnapshotSchema.safeParse({
      createdAt: 1000,
      kind: 'recap' as const,
      reviewedMomentsCount: 0,
    });
    expect(result.success).toBe(false);
  });

  it('parses a "full" recap public snapshot (detail, tournamentUrl, and the set timeline)', () => {
    const parsed = publicShareSnapshotSchema.parse({
      createdAt: 1000,
      kind: 'recap' as const,
      recapSource: 'startgg' as const,
      tournamentName: 'The Big House 9',
      tournamentDate: 500,
      setRecordWins: 2,
      setRecordLosses: 1,
      characterFighterIds: [1, 5],
      reviewedMomentsCount: 0,
      detail: 'full' as const,
      tournamentUrl: 'https://start.gg/tournament/the-big-house-9/event/ultimate-singles',
      sets: [
        {
          roundLabel: 'Winners Round 3',
          opponentName: 'RivalTag',
          opponentPlacement: 5,
          wins: 3,
          losses: 1,
          win: true,
          stages: ['Battlefield'],
        },
      ],
    });
    expect(parsed.detail).toBe('full');
    expect(parsed.tournamentUrl).toBe(
      'https://start.gg/tournament/the-big-house-9/event/ultimate-singles',
    );
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.sets![0]!.opponentPlacement).toBe(5);
  });

  it('a "summary" recap public snapshot (no detail/tournamentUrl/sets) still parses (backward compatible)', () => {
    const parsed = publicShareSnapshotSchema.parse({
      createdAt: 1000,
      kind: 'recap' as const,
      recapSource: 'startgg' as const,
      tournamentName: 'The Big House 9',
      tournamentDate: 500,
      setRecordWins: 2,
      setRecordLosses: 1,
      characterFighterIds: [1, 5],
      reviewedMomentsCount: 0,
    });
    expect(parsed.detail).toBeUndefined();
    expect(parsed.tournamentUrl).toBeUndefined();
    expect(parsed.sets).toBeUndefined();
  });
});

describe('shareTokenSchema', () => {
  it('parses an active view share with no requiresAuth/revokedAt keys', () => {
    const parsed = shareTokenSchema.parse({
      shareId: 'share-1',
      ownerUid: 'uid-1',
      permissions: 'view',
      createdAt: 1000,
    });
    expect(parsed.permissions).toBe('view');
    expect(parsed.requiresAuth).toBeUndefined();
    expect(parsed.revokedAt).toBeUndefined();
  });

  it('parses an edit-tier share with revokedAt set (forward-compat + revoked)', () => {
    const parsed = shareTokenSchema.parse({
      shareId: 'share-1',
      ownerUid: 'uid-1',
      permissions: 'edit',
      requiresAuth: true,
      createdAt: 1000,
      revokedAt: 2000,
    });
    expect(parsed.permissions).toBe('edit');
    expect(parsed.requiresAuth).toBe(true);
    expect(parsed.revokedAt).toBe(2000);
  });

  it('rejects an unknown permissions value', () => {
    const result = shareTokenSchema.safeParse({
      shareId: 'share-1',
      ownerUid: 'uid-1',
      permissions: 'admin',
      createdAt: 1000,
    });
    expect(result.success).toBe(false);
  });
});

describe('createShareInputSchema', () => {
  it('accepts a well-formed create input (kind defaults to review)', () => {
    const parsed = createShareInputSchema.parse({
      matchId: 'match-1',
      redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
    });
    expect(parsed.matchId).toBe('match-1');
    expect(parsed.kind).toBe('review');
  });

  it('accepts an optional ownerDisplayName', () => {
    const parsed = createShareInputSchema.parse({
      matchId: 'match-1',
      redaction: { includeNotes: true, includeTags: true, showDisplayName: true },
      ownerDisplayName: 'My Tag',
    });
    expect(parsed.ownerDisplayName).toBe('My Tag');
  });

  it('rejects a missing matchId', () => {
    const result = createShareInputSchema.safeParse({
      redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
    });
    expect(result.success).toBe(false);
  });

  it('a review input with no kind field still parses (backward compatible)', () => {
    const parsed = createShareInputSchema.parse({
      matchId: 'match-1',
      redaction: { includeNotes: false, includeTags: false, showDisplayName: false },
    });
    expect(parsed.kind).toBe('review');
    expect(parsed.entryKey).toBeUndefined();
  });

  it('accepts a recap input (kind recap + entryKey)', () => {
    const parsed = createShareInputSchema.parse({
      kind: 'recap',
      entryKey: '99',
    });
    expect(parsed.kind).toBe('recap');
    expect(parsed.entryKey).toBe('99');
  });

  it('rejects a recap input missing entryKey', () => {
    const result = createShareInputSchema.safeParse({ kind: 'recap' });
    expect(result.success).toBe(false);
  });

  it('accepts a recap input with an explicit detail (summary or full)', () => {
    const full = createShareInputSchema.parse({ kind: 'recap', entryKey: '99', detail: 'full' });
    expect(full.detail).toBe('full');

    const summary = createShareInputSchema.parse({
      kind: 'recap',
      entryKey: '99',
      detail: 'summary',
    });
    expect(summary.detail).toBe('summary');
  });

  it('a recap input with no detail field still parses (detail stays undefined, not defaulted at the schema level)', () => {
    const parsed = createShareInputSchema.parse({ kind: 'recap', entryKey: '99' });
    expect(parsed.detail).toBeUndefined();
  });

  it('a review input with no detail field still parses (detail is recap-only)', () => {
    const parsed = createShareInputSchema.parse({
      matchId: 'match-1',
      redaction: { includeNotes: false, includeTags: false, showDisplayName: false },
    });
    expect(parsed.detail).toBeUndefined();
  });
});

describe('MAX_SHARES_PER_USER', () => {
  it('equals 100', () => {
    expect(MAX_SHARES_PER_USER).toBe(100);
  });
});

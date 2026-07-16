import { describe, expect, it } from 'vitest';
import {
  createShareInputSchema,
  MAX_SHARES_PER_USER,
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
  it('accepts a well-formed create input', () => {
    const parsed = createShareInputSchema.parse({
      matchId: 'match-1',
      redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
    });
    expect(parsed.matchId).toBe('match-1');
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
});

describe('MAX_SHARES_PER_USER', () => {
  it('equals 100', () => {
    expect(MAX_SHARES_PER_USER).toBe(100);
  });
});

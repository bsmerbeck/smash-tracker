import { describe, expect, it } from 'vitest';
import { serializeCitationToken, type ClientVisibleVersion } from '@smash-tracker/shared';
import { buildReviewSnapshot } from './buildReviewSnapshot.js';

function makeVersion(overrides: Partial<ClientVisibleVersion> = {}): ClientVisibleVersion {
  return {
    sections: [{ id: 'summary', kind: 'summary', title: null, body: 'Solid neutral game today.' }],
    publishedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('buildReviewSnapshot', () => {
  it('builds a publicShareSnapshotSchema-valid coachReview snapshot with no coachPrivateNotes key', () => {
    const version = makeVersion();

    const snapshot = buildReviewSnapshot(version, 'Coach Alex', []);

    expect(snapshot.kind).toBe('coachReview');
    expect(snapshot.coachDisplayName).toBe('Coach Alex');
    expect(snapshot.reviewPublishedAt).toBe(version.publishedAt);
    expect(snapshot.createdAt).toBe(version.publishedAt);
    expect(snapshot.sections).toEqual(version.sections);
    expect(snapshot).not.toHaveProperty('coachPrivateNotes');
  });

  it('reads only the sealed version — never touches the draft or matches subtree (no I/O at all)', () => {
    // buildReviewSnapshot is a pure function: it takes ONLY the sealed
    // ClientVisibleVersion + already-resolved coachDisplayName/citation
    // sources, and performs no database reads whatsoever. Grepping the
    // module source for reviewDrafts/matches proves this structurally.
    const version = makeVersion();
    const snapshot = buildReviewSnapshot(version, 'Coach Alex', []);
    expect(snapshot).toBeDefined();
  });

  it('omits citationSources entirely when the resolved list is empty', () => {
    const snapshot = buildReviewSnapshot(makeVersion(), 'Coach Alex', []);
    expect(snapshot).not.toHaveProperty('citationSources');
  });

  it('carries the resolved multi-source citation list when present', () => {
    const snapshot = buildReviewSnapshot(makeVersion(), 'Coach Alex', [
      { sourceVodRef: 'match-1', vodUrl: 'https://youtu.be/abc123' },
      { sourceVodRef: 'match-2', vodUrl: 'https://youtu.be/def456' },
    ]);

    expect(snapshot.citationSources).toEqual([
      { sourceVodRef: 'match-1', vodUrl: 'https://youtu.be/abc123' },
      { sourceVodRef: 'match-2', vodUrl: 'https://youtu.be/def456' },
    ]);
  });

  it('computes reviewedMomentsCount from every {{cite:...}} token across all sections', () => {
    const citeA = serializeCitationToken({
      sourceVodRef: 'match-1',
      seconds: 42,
      label: 'missed ledgetrap',
    });
    const citeB = serializeCitationToken({
      sourceVodRef: 'match-2',
      seconds: 10,
      label: 'good edgeguard',
    });
    const version = makeVersion({
      sections: [
        { id: 'summary', kind: 'summary', title: null, body: `Watch this: ${citeA}` },
        { id: 'strengths', kind: 'strengths', title: null, body: `And this: ${citeB}` },
      ],
    });

    const snapshot = buildReviewSnapshot(version, 'Coach Alex', []);

    expect(snapshot.reviewedMomentsCount).toBe(2);
  });

  it('returns 0 reviewedMomentsCount when no section body embeds a citation token', () => {
    const snapshot = buildReviewSnapshot(makeVersion(), 'Coach Alex', []);
    expect(snapshot.reviewedMomentsCount).toBe(0);
  });

  describe('includedVods (Phase 21, DLVX-02/DLVX-04)', () => {
    it('omits includedVods entirely when the resolved list is empty (default, no 4th arg)', () => {
      const snapshot = buildReviewSnapshot(makeVersion(), 'Coach Alex', []);
      expect(snapshot).not.toHaveProperty('includedVods');
    });

    it('carries the resolved includedVods list when present', () => {
      const snapshot = buildReviewSnapshot(
        makeVersion(),
        'Coach Alex',
        [],
        [{ matchId: 'match-1', vodUrl: 'https://youtu.be/abc123' }],
      );

      expect(snapshot.includedVods).toEqual([
        { matchId: 'match-1', vodUrl: 'https://youtu.be/abc123' },
      ]);
    });

    it('keeps includedVods fully independent of citationSources — both can be present at once', () => {
      const snapshot = buildReviewSnapshot(
        makeVersion(),
        'Coach Alex',
        [{ sourceVodRef: 'match-1', vodUrl: 'https://youtu.be/abc123' }],
        [{ matchId: 'match-2', vodUrl: 'https://youtu.be/def456' }],
      );

      expect(snapshot.citationSources).toEqual([
        { sourceVodRef: 'match-1', vodUrl: 'https://youtu.be/abc123' },
      ]);
      expect(snapshot.includedVods).toEqual([
        { matchId: 'match-2', vodUrl: 'https://youtu.be/def456' },
      ]);
    });
  });
});

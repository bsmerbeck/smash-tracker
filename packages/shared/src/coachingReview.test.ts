import { describe, expect, it } from 'vitest';
import {
  clientVisibleVersionSchema,
  createDraftPatchInputSchema,
  MAX_REVIEW_SECTIONS,
  parseCitationToken,
  reviewDraftSchema,
  reviewSectionSchema,
  serializeCitationToken,
} from './coachingReview.js';

function makeSection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'summary',
    kind: 'summary' as const,
    hidden: false,
    body: 'Great set overall.',
    ...overrides,
  };
}

describe('reviewDraftSchema', () => {
  it('accepts a valid draft', () => {
    const draft = reviewDraftSchema.parse({
      revision: 0,
      sections: [makeSection()],
      coachPrivateNotes: 'Watch out for their ledgetrap habit.',
      lastAutosavedAt: 1000,
      createdAt: 1000,
    });
    expect(draft.revision).toBe(0);
    expect(draft.sections).toHaveLength(1);
  });

  it('rejects a sections array over the MAX_REVIEW_SECTIONS cap', () => {
    const tooMany = Array.from({ length: MAX_REVIEW_SECTIONS + 1 }, (_, i) =>
      makeSection({ id: `general-${i}`, kind: 'general' }),
    );
    expect(() =>
      reviewDraftSchema.parse({
        revision: 0,
        sections: tooMany,
        lastAutosavedAt: 1000,
        createdAt: 1000,
      }),
    ).toThrow();
  });
});

describe('clientVisibleVersionSchema', () => {
  it('parse drops coachPrivateNotes even when the input object carries it (structural omission, REV-03)', () => {
    const parsed = clientVisibleVersionSchema.parse({
      sections: [{ id: 'summary', kind: 'summary', body: 'Great set overall.' }],
      publishedAt: 5000,
      // Extra field a caller might mistakenly spread in — must never survive parse.
      coachPrivateNotes: 'This must never appear in the parsed output.',
    });
    expect(parsed).not.toHaveProperty('coachPrivateNotes');
    expect(Object.keys(parsed).sort()).toEqual(['publishedAt', 'sections']);
    expect(JSON.stringify(parsed)).not.toContain('coachPrivateNotes');
  });

  it('rejects a section that still carries the coach-only hidden flag (schema has no field for it)', () => {
    // reviewSectionSchema.omit({ hidden: true }) means a `hidden` key on the
    // input is simply ignored by Zod's default (non-strict) parsing — but
    // there is structurally no field to read it back from on the output.
    const parsed = clientVisibleVersionSchema.parse({
      sections: [{ id: 'summary', kind: 'summary', body: 'text', hidden: true }],
      publishedAt: 1,
    });
    expect(parsed.sections[0]).not.toHaveProperty('hidden');
  });
});

describe('reviewSectionSchema', () => {
  it('accepts every REVIEW_SECTION_KINDS literal', () => {
    expect(() => reviewSectionSchema.parse(makeSection({ kind: 'nextGoals' }))).not.toThrow();
  });
});

describe('citation token grammar', () => {
  it('round-trips serialize -> parse', () => {
    const token = { sourceVodRef: 'match-123', seconds: 222, label: 'missed ledgetrap' };
    const serialized = serializeCitationToken(token);
    expect(serialized).toBe('{{cite:matchId=match-123;seconds=222;label=missed%20ledgetrap}}');
    expect(parseCitationToken(serialized)).toEqual(token);
  });

  it('rejects a non-numeric seconds value', () => {
    expect(
      parseCitationToken('{{cite:matchId=match-123;seconds=abc;label=missed%20ledgetrap}}'),
    ).toBeNull();
  });

  it('rejects an over-length label', () => {
    const overLong = encodeURIComponent('x'.repeat(201));
    expect(
      parseCitationToken(`{{cite:matchId=match-123;seconds=222;label=${overLong}}}`),
    ).toBeNull();
  });

  it('returns null (never throws) for text with no citation token at all', () => {
    expect(parseCitationToken('just plain body text')).toBeNull();
  });
});

describe('createDraftPatchInputSchema', () => {
  it('requires expectedRevision', () => {
    expect(() => createDraftPatchInputSchema.parse({})).toThrow();
  });

  it('allows a partial patch of just sections, or just coachPrivateNotes', () => {
    expect(() =>
      createDraftPatchInputSchema.parse({ expectedRevision: 0, sections: [makeSection()] }),
    ).not.toThrow();
    expect(() =>
      createDraftPatchInputSchema.parse({ expectedRevision: 0, coachPrivateNotes: 'private' }),
    ).not.toThrow();
    expect(() => createDraftPatchInputSchema.parse({ expectedRevision: 0 })).not.toThrow();
  });
});

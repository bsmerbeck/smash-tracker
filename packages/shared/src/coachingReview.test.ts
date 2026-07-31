import { describe, expect, it } from 'vitest';
import {
  buildCitationInsertLabel,
  CITATION_INSERT_LABEL_MAX_LENGTH,
  citationTokenSchema,
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

describe('buildCitationInsertLabel', () => {
  it('returns an empty string for an empty note', () => {
    expect(buildCitationInsertLabel('')).toBe('');
  });

  it('returns an empty string for a whitespace-only note', () => {
    expect(buildCitationInsertLabel('   \n\t  ')).toBe('');
  });

  it('round-trips a short note unchanged apart from trimming', () => {
    expect(buildCitationInsertLabel('  missed ledgetrap  ')).toBe('missed ledgetrap');
  });

  it('collapses embedded newlines/tab runs to single spaces', () => {
    expect(buildCitationInsertLabel('missed\nledgetrap\t\tagain')).toBe('missed ledgetrap again');
  });

  it('truncates a note over the cap at the last word boundary, appending a single ellipsis', () => {
    const note =
      'This is a very long timestamped note describing exactly what went wrong on that punish attempt';
    const label = buildCitationInsertLabel(note);
    expect(label.length).toBeLessThanOrEqual(CITATION_INSERT_LABEL_MAX_LENGTH + 1);
    expect(label.endsWith('…')).toBe(true);
    expect(label).not.toMatch(/\s…$/);
  });

  it('hard-slices a single unbroken long word, still ending in a single ellipsis, still at most 41 chars', () => {
    const label = buildCitationInsertLabel('x'.repeat(100));
    expect(label.length).toBeLessThanOrEqual(CITATION_INSERT_LABEL_MAX_LENGTH + 1);
    expect(label.endsWith('…')).toBe(true);
  });

  it('every returned value passes citationTokenSchema and round-trips serialize -> parse', () => {
    const notes = [
      '',
      'short',
      'x'.repeat(100),
      'a fairly long note that sits right around the truncation boundary for this cap',
    ];
    for (const note of notes) {
      const label = buildCitationInsertLabel(note);
      expect(() =>
        citationTokenSchema.parse({ sourceVodRef: 'm1', seconds: 1, label }),
      ).not.toThrow();
      const serialized = serializeCitationToken({ sourceVodRef: 'm1', seconds: 1, label });
      expect(parseCitationToken(serialized)).toEqual({ sourceVodRef: 'm1', seconds: 1, label });
    }
  });

  it('a pre-existing long-label token (over the insert cap, under the 200 storage cap) still parses unchanged — backward compatibility', () => {
    const longLabel = 'x'.repeat(150);
    const serialized = serializeCitationToken({ sourceVodRef: 'm1', seconds: 5, label: longLabel });
    expect(parseCitationToken(serialized)).toEqual({
      sourceVodRef: 'm1',
      seconds: 5,
      label: longLabel,
    });
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

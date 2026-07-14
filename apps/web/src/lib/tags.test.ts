import { describe, expect, it } from 'vitest';
import type { Match, VodTimestamp } from '@smash-tracker/shared';
// Bundled-English i18n (test setup) — tagLabel takes `t` so preset labels localize.
import i18n from '@/i18n';
import {
  MATCH_PRESET_TAGS,
  NOTE_PRESET_TAGS,
  PRESET_SLUGS,
  addTagToList,
  deriveCustomTagVocabulary,
  deriveNoteTagOptions,
  filterTimestampIndices,
  removeTagFromList,
  tagLabel,
} from './tags';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

describe('MATCH_PRESET_TAGS / NOTE_PRESET_TAGS', () => {
  it('MATCH_PRESET_TAGS has exactly the 5 fixed slugs in order', () => {
    expect(MATCH_PRESET_TAGS).toEqual([
      'tournament-set',
      'practice-friendlies',
      'bad-matchup',
      'good-read-highlight',
      'to-review',
    ]);
    expect(MATCH_PRESET_TAGS).toHaveLength(5);
  });

  it('NOTE_PRESET_TAGS has exactly the 11 fixed slugs in order', () => {
    expect(NOTE_PRESET_TAGS).toEqual([
      'neutral',
      'punish',
      'edgeguard',
      'recovery',
      'kill-confirm',
      'defense',
      'mixup',
      'matchup-note',
      'mental-game',
      'mistake',
      'highlight',
    ]);
    expect(NOTE_PRESET_TAGS).toHaveLength(11);
  });

  it('PRESET_SLUGS contains all 16 slugs', () => {
    expect(PRESET_SLUGS.size).toBe(16);
    for (const slug of [...MATCH_PRESET_TAGS, ...NOTE_PRESET_TAGS]) {
      expect(PRESET_SLUGS.has(slug)).toBe(true);
    }
  });
});

describe('tagLabel', () => {
  it('resolves a preset slug through i18n', () => {
    expect(tagLabel(i18n.t.bind(i18n), 'punish')).toBe(i18n.t('tags.preset.punish'));
    expect(tagLabel(i18n.t.bind(i18n), 'punish')).not.toBe('punish');
  });

  it('returns the raw string for a custom tag', () => {
    expect(tagLabel(i18n.t.bind(i18n), 'my custom tag')).toBe('my custom tag');
  });
});

describe('addTagToList', () => {
  it('rejects a case-insensitive duplicate', () => {
    expect(addTagToList(['punish'], 'PUNISH', 5)).toEqual(['punish']);
  });

  it('trims surrounding whitespace', () => {
    expect(addTagToList(['a'], '  spacing  ', 5)).toEqual(['a', 'spacing']);
  });

  it('rejects a blank candidate', () => {
    expect(addTagToList(['a'], '', 5)).toEqual(['a']);
    expect(addTagToList(['a'], '   ', 5)).toEqual(['a']);
  });

  it('enforces the cap, leaving the list unchanged once full', () => {
    const full = ['a', 'b', 'c', 'd', 'e'];
    expect(addTagToList(full, 'new', 5)).toBe(full);
    expect(addTagToList(full, 'new', 5)).toEqual(full);
  });

  it('never mutates the input list', () => {
    const original = ['a'];
    addTagToList(original, 'b', 5);
    expect(original).toEqual(['a']);
  });
});

describe('removeTagFromList', () => {
  it('removes the matching entry', () => {
    expect(removeTagFromList(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('never mutates the input array', () => {
    const original = ['a', 'b'];
    removeTagFromList(original, 'a');
    expect(original).toEqual(['a', 'b']);
  });
});

describe('deriveCustomTagVocabulary', () => {
  it('excludes presets and returns only sorted, deduped customs', () => {
    const matches: Match[] = [
      makeMatch({
        id: 'm1',
        time: 1,
        win: true,
        tags: ['punish', 'Zeta Custom', 'alpha custom'],
      }),
      makeMatch({
        id: 'm2',
        time: 2,
        win: false,
        vodTimestamps: [
          { seconds: 5, note: 'note', tags: ['edgeguard', 'alpha CUSTOM', 'beta custom'] },
        ],
      }),
    ];

    expect(deriveCustomTagVocabulary(matches)).toEqual([
      'alpha custom',
      'beta custom',
      'Zeta Custom',
    ]);
  });

  it('returns an empty array when no custom tags are present', () => {
    const matches: Match[] = [makeMatch({ id: 'm1', time: 1, win: true, tags: ['punish'] })];
    expect(deriveCustomTagVocabulary(matches)).toEqual([]);
  });

  it('folds in extraTags (Quick Tags panel device-local set) not yet persisted on any match/note', () => {
    const matches: Match[] = [makeMatch({ id: 'm1', time: 1, win: true, tags: ['alpha custom'] })];

    // A custom quick-tag never applied to any match/note yet — must still
    // be offered (the bug fix: previously invisible until first captured).
    expect(deriveCustomTagVocabulary(matches, ['beta custom'])).toEqual([
      'alpha custom',
      'beta custom',
    ]);
  });

  it('extraTags excludes presets and dedupes case-insensitively against matches, preferring the matches casing', () => {
    const matches: Match[] = [makeMatch({ id: 'm1', time: 1, win: true, tags: ['Alpha Custom'] })];

    expect(deriveCustomTagVocabulary(matches, ['punish', 'alpha CUSTOM', 'beta custom'])).toEqual([
      'Alpha Custom',
      'beta custom',
    ]);
  });

  it('defaults extraTags to empty when omitted', () => {
    const matches: Match[] = [makeMatch({ id: 'm1', time: 1, win: true, tags: ['zeta'] })];
    expect(deriveCustomTagVocabulary(matches)).toEqual(['zeta']);
  });
});

describe('deriveNoteTagOptions (retest fix-up #12)', () => {
  it('returns sorted, deduped tags across all notes, including presets', () => {
    const timestamps: VodTimestamp[] = [
      { seconds: 10, note: 'a', tags: ['mistake', 'zeta custom'] },
      { seconds: 20, note: 'b', tags: ['punish'] },
      { seconds: 30, note: 'c', tags: ['mistake'] },
    ];
    expect(deriveNoteTagOptions(timestamps)).toEqual(['mistake', 'punish', 'zeta custom']);
  });

  it('returns an empty array when no note has any tag', () => {
    const timestamps: VodTimestamp[] = [
      { seconds: 10, note: 'a' },
      { seconds: 20, note: 'b', tags: [] },
    ];
    expect(deriveNoteTagOptions(timestamps)).toEqual([]);
  });
});

describe('filterTimestampIndices (retest fix-up #12)', () => {
  const timestamps: VodTimestamp[] = [
    { seconds: 10, note: 'a', tags: ['mistake'] },
    { seconds: 20, note: 'b', tags: ['punish'] },
    { seconds: 30, note: 'c' },
    { seconds: 40, note: 'd', tags: ['mistake', 'punish'] },
  ];

  it('returns every index (in order) when selectedTags is empty', () => {
    expect(filterTimestampIndices(timestamps, [])).toEqual([0, 1, 2, 3]);
  });

  it('returns only indices matching ANY selected tag (OR semantics), preserving original positions', () => {
    expect(filterTimestampIndices(timestamps, ['mistake'])).toEqual([0, 3]);
    expect(filterTimestampIndices(timestamps, ['punish'])).toEqual([1, 3]);
    expect(filterTimestampIndices(timestamps, ['mistake', 'punish'])).toEqual([0, 1, 3]);
  });

  it('returns an empty array when no note matches any selected tag', () => {
    expect(filterTimestampIndices(timestamps, ['edgeguard'])).toEqual([]);
  });

  it('never re-indexes — the returned indices are positions in the ORIGINAL array', () => {
    const result = filterTimestampIndices(timestamps, ['mistake']);
    for (const i of result) {
      expect(timestamps[i]!.tags).toContain('mistake');
    }
  });
});

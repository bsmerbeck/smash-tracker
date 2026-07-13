import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
// Bundled-English i18n (test setup) — tagLabel takes `t` so preset labels localize.
import i18n from '@/i18n';
import {
  MATCH_PRESET_TAGS,
  NOTE_PRESET_TAGS,
  PRESET_SLUGS,
  addTagToList,
  deriveCustomTagVocabulary,
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
});

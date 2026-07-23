import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  clientVisibleVersionSchema,
  createGspReadingInputSchema,
  createMatchInputSchema,
  createPlaylistInputSchema,
  DEFAULT_ELITE_THRESHOLD,
  eliteThresholdGsp,
  estimateMaxGsp,
  estimateT,
  extractCitationTokens,
  reviewSectionSchema,
  SAFE_MARKDOWN_DOC_MAX_LENGTH,
  upsertGspSettingsInputSchema,
  upsertOpponentNoteInputSchema,
  vodTimestampSchema,
} from '@smash-tracker/shared';
import {
  CLIENT_VOD_TABLE,
  FIGHTER_PALUTENA,
  FIGHTER_ROY,
  FIGHTER_SORA,
  FIGHTER_STEVE,
  MATCH_PRESET_TAGS,
  NOTE_PRESET_TAGS,
  VOD_TABLE,
  buildClientMatches,
  buildClientReviewDraft,
  buildClientVodNotes,
  buildGspSeries,
  buildGspSettings,
  buildOpponentNotes,
  buildOpponents,
  buildPersonalMatches,
  buildPlaylists,
  buildVodNotes,
} from './content.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 23, 12, 0, 0);

describe('buildPersonalMatches', () => {
  const entries = buildPersonalMatches(NOW);

  it('returns ~72 matches', () => {
    expect(entries.length).toBeGreaterThanOrEqual(60);
    expect(entries.length).toBeGreaterThanOrEqual(68);
    expect(entries.length).toBeLessThanOrEqual(76);
  });

  it('splits fighters ~60/25/15 with Roy > Sora > Palutena', () => {
    const royCount = entries.filter((e) => e.input.fighter_id === FIGHTER_ROY).length;
    const soraCount = entries.filter((e) => e.input.fighter_id === FIGHTER_SORA).length;
    const palutenaCount = entries.filter((e) => e.input.fighter_id === FIGHTER_PALUTENA).length;

    expect(royCount + soraCount + palutenaCount).toBe(entries.length);
    expect(royCount).toBeGreaterThan(soraCount);
    expect(soraCount).toBeGreaterThan(palutenaCount);
    const royShare = royCount / entries.length;
    expect(royShare).toBeGreaterThanOrEqual(0.55);
    expect(royShare).toBeLessThanOrEqual(0.65);
  });

  it('overall win rate is in [0.52, 0.64]', () => {
    const wins = entries.filter((e) => e.input.win === true).length;
    const rate = wins / entries.length;
    expect(rate).toBeGreaterThanOrEqual(0.52);
    expect(rate).toBeLessThanOrEqual(0.64);
  });

  it('every timeMs is within the 92-day window and spans at least 80 days', () => {
    const min = Math.min(...entries.map((e) => e.timeMs));
    const max = Math.max(...entries.map((e) => e.timeMs));
    for (const entry of entries) {
      expect(entry.timeMs).toBeGreaterThanOrEqual(NOW - 92 * DAY_MS);
      expect(entry.timeMs).toBeLessThanOrEqual(NOW - DAY_MS);
    }
    expect(max - min).toBeGreaterThanOrEqual(80 * DAY_MS);
  });

  it('has exactly 10 VOD-coherent matches matching the curated table', () => {
    const vodEntries = entries.filter((e) => e.input.vodUrl !== undefined);
    expect(vodEntries.length).toBe(10);

    for (const entry of vodEntries) {
      const vod = VOD_TABLE.find((v) => v.vodUrl === entry.input.vodUrl);
      expect(vod).toBeDefined();
      expect(entry.input.fighter_id).toBe(vod!.ownerFighterId);
      expect(entry.input.opponent_id).toBe(vod!.opponentFighterId);
    }

    const distinctUrls = new Set(vodEntries.map((e) => e.input.vodUrl));
    expect(distinctUrls.size).toBe(10);
    for (const url of distinctUrls) {
      expect(VOD_TABLE.some((v) => v.vodUrl === url)).toBe(true);
    }
  });

  it('populates a varied opponent matchup matrix (>= 9 distinct opponent fighters)', () => {
    const distinctOpponents = new Set(entries.map((e) => e.input.opponent_id));
    expect(distinctOpponents.size).toBeGreaterThanOrEqual(9);
  });

  it('every match input validates against createMatchInputSchema', () => {
    for (const entry of entries) {
      expect(() => createMatchInputSchema.parse(entry.input)).not.toThrow();
    }
  });

  it('is a pure module with no firebase-admin or live-network GSP import', () => {
    // Static inspection guard: content.ts's IMPORT STATEMENTS must never
    // reference firebase-admin or gspLive (network-fetch) — restricted to
    // lines starting with `import` so doc-comments explaining *why* gspLive
    // is avoided don't false-positive this check.
    const source = readFileSync(new URL('./content.ts', import.meta.url), 'utf8');
    const importLines = source
      .split('\n')
      .filter((line) => line.trim().startsWith('import '))
      .join('\n');
    expect(importLines).not.toMatch(/firebase-admin/);
    expect(importLines).not.toMatch(/gspLive/);
  });
});

describe('buildOpponents / buildOpponentNotes', () => {
  it('returns 12 fictional opponent tags, each RTDB-safe lowercase and mapped to a fighter', () => {
    const opponents = buildOpponents();
    expect(opponents.length).toBe(12);
    for (const opponent of opponents) {
      expect(opponent.name).toBe(opponent.name.toLowerCase());
      expect(opponent.name).not.toMatch(/[.#$[\]/]/);
      expect(opponent.fighterId).toBeGreaterThan(0);
    }
  });

  it('returns 8 believable en-locale notes with no "lorem"', () => {
    const notes = buildOpponentNotes();
    expect(notes.length).toBe(8);
    const opponentNames = new Set(buildOpponents().map((o) => o.name));
    for (const entry of notes) {
      expect(opponentNames.has(entry.name)).toBe(true);
      expect(() => upsertOpponentNoteInputSchema.parse(entry.input)).not.toThrow();
      expect(entry.input.habits).toBeTruthy();
      expect(entry.input.habits!.toLowerCase()).not.toContain('lorem');
    }
  });
});

describe('buildGspSettings / buildGspSeries', () => {
  it('buildGspSettings computes an eliteThreshold within an order of magnitude of the default', () => {
    const settings = buildGspSettings(NOW);
    expect(() => upsertGspSettingsInputSchema.parse(settings)).not.toThrow();
    const ratio = settings.eliteThreshold / DEFAULT_ELITE_THRESHOLD;
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
  });

  it('buildGspSeries returns 12-16 generally-increasing readings per fighter, all below estimateMaxGsp', () => {
    const series = buildGspSeries(NOW);
    const fighterIds = Object.keys(series)
      .map(Number)
      .sort((a, b) => a - b);
    expect(fighterIds).toEqual([FIGHTER_ROY, FIGHTER_PALUTENA, FIGHTER_SORA].sort((a, b) => a - b));

    const t = estimateT(NOW);
    const max = estimateMaxGsp(t);
    const elite = eliteThresholdGsp(t);

    for (const fighterId of fighterIds) {
      const points = series[fighterId]!;
      expect(points.length).toBeGreaterThanOrEqual(12);
      expect(points.length).toBeLessThanOrEqual(16);

      for (const point of points) {
        expect(() => createGspReadingInputSchema.parse(point.input)).not.toThrow();
        expect(point.input.gsp).toBeLessThan(max);
        expect(point.input.fighter_id).toBe(fighterId);
      }

      const firstThird = points.slice(0, Math.ceil(points.length / 3));
      const lastThird = points.slice(-Math.ceil(points.length / 3));
      const avg = (arr: typeof points) => arr.reduce((sum, p) => sum + p.input.gsp, 0) / arr.length;
      expect(avg(lastThird)).toBeGreaterThan(avg(firstThird));
      expect(avg(lastThird)).toBeGreaterThan(elite * 0.5);
    }
  });
});

describe('buildVodNotes', () => {
  const notesByVod = buildVodNotes();

  it('returns 3-6 valid notes per VOD-match index, seconds in [30, 420]', () => {
    expect(notesByVod.length).toBe(10);
    for (const notes of notesByVod) {
      expect(notes.length).toBeGreaterThanOrEqual(3);
      expect(notes.length).toBeLessThanOrEqual(6);
      for (const note of notes) {
        expect(() => vodTimestampSchema.parse(note)).not.toThrow();
        expect(note.seconds).toBeGreaterThanOrEqual(30);
        expect(note.seconds).toBeLessThanOrEqual(420);
      }
    }
  });

  it('contains no "lorem" placeholder text', () => {
    for (const notes of notesByVod) {
      for (const note of notes) {
        expect(note.note.toLowerCase()).not.toContain('lorem');
      }
    }
  });

  it('mixes preset and custom tags at note level and match level (SHOW-07)', () => {
    const allNoteTags = notesByVod.flatMap((notes) => notes.flatMap((n) => n.tags ?? []));
    const notePresetTags = new Set<string>(NOTE_PRESET_TAGS);
    expect(allNoteTags.some((tag) => notePresetTags.has(tag))).toBe(true);
    expect(allNoteTags.some((tag) => tag === 'lab this')).toBe(true);

    // Same preset+custom coverage holds at match level (Task 1's output).
    const matches = buildPersonalMatches(NOW);
    const allMatchTags = matches.flatMap((m) => m.input.tags ?? []);
    const matchPresetTags = new Set<string>(MATCH_PRESET_TAGS);
    expect(allMatchTags.some((tag) => matchPresetTags.has(tag))).toBe(true);
    expect(
      allMatchTags.some((tag) => ['lab this', 'bracket run', 'money match'].includes(tag)),
    ).toBe(true);
  });
});

describe('buildPlaylists', () => {
  it('returns >= 2 playlist specs grouping seeded VOD-match indices', () => {
    const playlists = buildPlaylists();
    expect(playlists.length).toBeGreaterThanOrEqual(2);

    for (const playlist of playlists) {
      expect(() => createPlaylistInputSchema.parse({ name: playlist.name })).not.toThrow();
      for (const index of playlist.vodMatchIndices) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThanOrEqual(9);
      }
    }

    const royBracketRuns = playlists.find((p) => p.name === 'Roy bracket runs');
    expect(royBracketRuns).toBeDefined();
    expect(royBracketRuns!.vodMatchIndices.length).toBeGreaterThanOrEqual(3);
    for (const index of royBracketRuns!.vodMatchIndices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(4);
    }

    const second = playlists.find((p) => p.name !== 'Roy bracket runs');
    expect(second).toBeDefined();
    expect(second!.vodMatchIndices.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Phase 15 (PAND-02/PAND-03): Pandemic client-library + review-draft builders
// ---------------------------------------------------------------------------

/** Real player handles (15-CONTEXT.md coherence rule) — never a client match opponent tag. */
const REAL_PLAYER_HANDLES = ['sonix', 'acola', 'raru', 'dabuz', 'riddles', 'onin'];

describe('buildClientMatches', () => {
  const entries = buildClientMatches(NOW);

  it('returns >= 15 (target ~24) Steve matches, every input schema-valid', () => {
    expect(entries.length).toBeGreaterThanOrEqual(15);
    for (const entry of entries) {
      expect(entry.input.fighter_id).toBe(FIGHTER_STEVE);
      expect(() => createMatchInputSchema.parse(entry.input)).not.toThrow();
    }
  });

  it('overall win rate is between 0.45 and 0.65', () => {
    const wins = entries.filter((e) => e.input.win === true).length;
    const rate = wins / entries.length;
    expect(rate).toBeGreaterThanOrEqual(0.45);
    expect(rate).toBeLessThanOrEqual(0.65);
  });

  it('never uses a real player handle as the opponent tag', () => {
    for (const entry of entries) {
      expect(REAL_PLAYER_HANDLES).not.toContain(entry.input.opponent);
    }
  });

  it('has exactly 5 VOD-coherent matches, opponent_id matching CLIENT_VOD_TABLE', () => {
    const vodEntries = entries.filter((e) => e.input.vodUrl !== undefined);
    expect(vodEntries.length).toBe(5);

    for (const entry of vodEntries) {
      const vod = CLIENT_VOD_TABLE.find((v) => v.vodUrl === entry.input.vodUrl);
      expect(vod).toBeDefined();
      expect(entry.input.opponent_id).toBe(vod!.opponentFighterId);
    }

    const distinctUrls = new Set(vodEntries.map((e) => e.input.vodUrl));
    expect(distinctUrls.size).toBe(5);
  });

  it('spans at least 50 days of back-dated timestamps', () => {
    const min = Math.min(...entries.map((e) => e.timeMs));
    const max = Math.max(...entries.map((e) => e.timeMs));
    expect(max - min).toBeGreaterThanOrEqual(50 * DAY_MS);
  });
});

describe('buildClientVodNotes', () => {
  const notesByVod = buildClientVodNotes();

  it('returns 5 arrays of 4-6 notes each, seconds in [30, 420]', () => {
    expect(notesByVod.length).toBe(5);
    for (const notes of notesByVod) {
      expect(notes.length).toBeGreaterThanOrEqual(4);
      expect(notes.length).toBeLessThanOrEqual(6);
      for (const note of notes) {
        expect(() => vodTimestampSchema.parse(note)).not.toThrow();
        expect(note.seconds).toBeGreaterThanOrEqual(30);
        expect(note.seconds).toBeLessThanOrEqual(420);
      }
    }
  });

  it('contains no "lorem" placeholder text', () => {
    for (const notes of notesByVod) {
      for (const note of notes) {
        expect(note.note.toLowerCase()).not.toContain('lorem');
      }
    }
  });

  it('includes at least one custom (non-preset) tag such as "homework"/"recurring habit"', () => {
    const allTags = notesByVod.flatMap((notes) => notes.flatMap((n) => n.tags ?? []));
    const presetTags = new Set<string>(NOTE_PRESET_TAGS);
    expect(allTags.some((tag) => !presetTags.has(tag))).toBe(true);
  });
});

describe('buildClientReviewDraft', () => {
  const clientVodMatchIds = [
    'client-match-1',
    'client-match-2',
    'client-match-3',
    'client-match-4',
    'client-match-5',
  ];
  const draft = buildClientReviewDraft(clientVodMatchIds);

  it('returns 6 sections with the fixed kinds, all visible, title null, schema-valid', () => {
    expect(draft.sections.length).toBe(6);
    expect(draft.sections.map((s) => s.kind)).toEqual([
      'summary',
      'strengths',
      'priorities',
      'matchupNotes',
      'practicePlan',
      'nextGoals',
    ]);
    for (const section of draft.sections) {
      expect(section.hidden).toBe(false);
      expect(section.title).toBeNull();
      expect(() => reviewSectionSchema.parse(section)).not.toThrow();
    }
  });

  it('coachPrivateNotes is a non-empty string within SAFE_MARKDOWN_DOC_MAX_LENGTH', () => {
    expect(typeof draft.coachPrivateNotes).toBe('string');
    expect(draft.coachPrivateNotes.length).toBeGreaterThan(0);
    expect(draft.coachPrivateNotes.length).toBeLessThanOrEqual(SAFE_MARKDOWN_DOC_MAX_LENGTH);
  });

  it('embeds >= 5 citations referencing ONLY the passed match ids, across >= 2 distinct sources', () => {
    const allBodies = draft.sections.map((s) => s.body).join('\n');
    const tokens = extractCitationTokens(allBodies);
    expect(tokens.length).toBeGreaterThanOrEqual(5);

    for (const token of tokens) {
      expect(clientVodMatchIds).toContain(token.sourceVodRef);
    }
    const distinctRefs = new Set(tokens.map((t) => t.sourceVodRef));
    expect(distinctRefs.size).toBeGreaterThanOrEqual(2);
  });

  it('the sealed (hidden-filtered/omitted) sections validate against clientVisibleVersionSchema', () => {
    const sealed = {
      sections: draft.sections
        .filter((s) => !s.hidden)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `hidden` is intentionally discarded
        .map(({ hidden: _hidden, ...rest }) => rest),
      publishedAt: NOW,
    };
    expect(() => clientVisibleVersionSchema.parse(sealed)).not.toThrow();
  });
});

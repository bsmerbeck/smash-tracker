import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createGspReadingInputSchema,
  createMatchInputSchema,
  DEFAULT_ELITE_THRESHOLD,
  eliteThresholdGsp,
  estimateMaxGsp,
  estimateT,
  upsertGspSettingsInputSchema,
  upsertOpponentNoteInputSchema,
} from '@smash-tracker/shared';
import {
  FIGHTER_PALUTENA,
  FIGHTER_ROY,
  FIGHTER_SORA,
  VOD_TABLE,
  buildGspSeries,
  buildGspSettings,
  buildOpponentNotes,
  buildOpponents,
  buildPersonalMatches,
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
    // Static inspection guard: content.ts's import block must never reference
    // firebase-admin or gspLive (network-fetch) — verified by reading the
    // source text at test time so a future edit can't silently regress this.
    const source = readFileSync(new URL('./content.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/firebase-admin/);
    expect(source).not.toMatch(/gspLive/);
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

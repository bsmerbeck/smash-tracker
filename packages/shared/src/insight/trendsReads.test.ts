import { describe, expect, it } from 'vitest';
import {
  TRENDS_BACKFILL_TEMPLATE_IDS,
  TRENDS_READ_TEMPLATES,
  assembleTrendsRail,
  buildTrendsBackfillInsights,
} from './trendsReads.js';
import { assembleRail, isRailFallbackInsight } from './rail.js';
import { scoreInsight } from './salience.js';
import { ACCOUNT_SCOPE } from './types.js';
import type { HorizonKey, Insight } from './types.js';
import { generateSyntheticMatches, EIGHT_K_FIXTURE_OPTIONS } from '../testUtils/index.js';
import type { Match } from '../match.js';

/**
 * Plan 39.1-40 (D-14, D-07, UI-SPEC §7.8 rules 1-4, INS-01): the Trends reads
 * rail's one derivation — its own reads (RatingMove, TiltCost,
 * SessionFatigue) plus the account-scope FACT back-fill (Best record,
 * Toughest record, LastEventRecap), assembled so a quiet account never shows
 * the synthetic "insights aren't available" card and a thin account keeps
 * its unlock lead.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A fixed clock (2026-09-01T00:00Z) — never the wall clock. */
const FIXED_NOW_MS = Date.UTC(2026, 8, 1);

/** Mirrors what `TrendsReadsRail`'s `useTrendsInsights` computes: own reads + back-fill, salience-scored. */
function trendsInsights(matches: Match[], horizon: HorizonKey, nowMs: number): Insight[] {
  const own = TRENDS_READ_TEMPLATES.flatMap((template) =>
    template.build({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs }),
  );
  const backfill = buildTrendsBackfillInsights({ matches, horizon, nowMs });
  return [...own, ...backfill].map((insight) => ({
    ...insight,
    salience: scoreInsight(insight, nowMs),
  }));
}

function railFor(matches: Match[], horizon: HorizonKey, nowMs: number) {
  return assembleTrendsRail({ insights: trendsInsights(matches, horizon, nowMs) });
}

/** The guard:layout harness's realistic scale (guardLayoutHarness.mjs buildRealisticScale). */
function realisticFixture(): Match[] {
  return generateSyntheticMatches({
    seed: 39_120_024,
    count: 300,
    mainFighterIds: [8, 22],
    opponentFighterIds: [1, 10],
    stageIds: [1],
  });
}

function shiftToEnd(matches: Match[], endMs: number): Match[] {
  const last = matches.reduce((max, match) => Math.max(max, match.time), -Infinity);
  const delta = endMs - last;
  return matches.map((match) => ({ ...match, time: match.time + delta }));
}

/**
 * The recent-shaped fixture (the shape plan 36 gave the capture's `recent`
 * scale) against a FIXED clock: an older sparse ~30-month segment, then a
 * dense segment ending one day before `FIXED_NOW_MS`.
 */
function recentShapedFixture(): Match[] {
  const common = { mainFighterIds: [8, 22], opponentFighterIds: [1, 10], stageIds: [1] };
  const dense = shiftToEnd(
    generateSyntheticMatches({
      ...common,
      seed: 39_136_002,
      count: 1_300,
      startMs: 0,
      sessionSizeRange: [18, 30],
      sessionGapMs: 26 * HOUR_MS,
      winRate: 0.58,
    }),
    FIXED_NOW_MS - DAY_MS,
  );
  const denseStart = dense.reduce((min, match) => Math.min(min, match.time), Infinity);
  const older = shiftToEnd(
    generateSyntheticMatches({
      ...common,
      seed: 39_136_001,
      count: 420,
      startMs: 0,
      sessionSizeRange: [3, 6],
      sessionGapMs: 10 * DAY_MS,
      winRate: 0.52,
    }),
    denseStart - 7 * DAY_MS,
  );
  return [...older, ...dense].sort((a, b) => a.time - b.time);
}

/** TrendsReadsRail.test.tsx's thin account: 3 games, loss / loss / win, no event name. */
function thinFixture(): Match[] {
  const base = FIXED_NOW_MS - 60 * DAY_MS;
  const make = (id: string, time: number, win: boolean): Match => ({
    id,
    fighter_id: 1,
    opponent_id: 2,
    time,
    win,
    matchType: 'none',
  });
  return [
    make('g1', base, false),
    make('g2', base + 60_000, false),
    make('g3', base + 120_000, true),
  ];
}

function backfillCards(cards: Insight[]): Insight[] {
  return cards.filter((card) => TRENDS_BACKFILL_TEMPLATE_IDS.has(card.templateId));
}

describe('trendsReads (39.1-40)', () => {
  it('declares the Trends own reads and the back-fill set', () => {
    expect(TRENDS_READ_TEMPLATES.map((t) => t.id)).toEqual([
      'ratingMove',
      'tiltCost',
      'sessionFatigue',
    ]);
    expect([...TRENDS_BACKFILL_TEMPLATE_IDS].sort()).toEqual([
      'bestMatchup',
      'lastEventRecap',
      'worstMatchup',
    ]);
  });

  it('realistic fixture at last30: Best and Toughest record cards, at least 2 cards, no fallback', () => {
    const matches = realisticFixture();
    const nowMs = matches[matches.length - 1]!.time + HOUR_MS;
    const { cards } = railFor(matches, 'last30', nowMs);
    const ids = cards.map((card) => card.id);
    expect(ids).toContain('bestMatchup:account:last30');
    expect(ids).toContain('worstMatchup:account:last30');
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards.some((card) => isRailFallbackInsight(card))).toBe(false);
    const best = cards.find((card) => card.templateId === 'bestMatchup')!;
    const worst = cards.find((card) => card.templateId === 'worstMatchup')!;
    expect(best.copy.values.vs).not.toBe(worst.copy.values.vs);
  });

  it('8k fixture at last30: no fallback, at least 2 cards, every back-fill card a fact', () => {
    const matches = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
    const nowMs = matches[matches.length - 1]!.time + HOUR_MS;
    const { cards } = railFor(matches, 'last30', nowMs);
    expect(cards.some((card) => isRailFallbackInsight(card))).toBe(false);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const facts = backfillCards(cards);
    expect(facts.length).toBeGreaterThan(0);
    for (const card of facts) {
      expect(card.state).toBe('fact');
      expect(card.deltaPoints).toBeNull();
    }
  });

  it.each(['last30', 'last90'] as const)(
    'recent-shaped fixture (fixed clock) at %s: at least 2 cards, no fallback',
    (horizon) => {
      const { cards } = railFor(recentShapedFixture(), horizon, FIXED_NOW_MS);
      expect(cards.length).toBeGreaterThanOrEqual(2);
      expect(cards.some((card) => isRailFallbackInsight(card))).toBe(false);
    },
  );

  it('the 3-game thin account keeps its locked lead and gets no back-fill card', () => {
    const result = railFor(thinFixture(), 'lastEvent', FIXED_NOW_MS);
    expect(result.cards.some((card) => card.state === 'locked')).toBe(true);
    expect(backfillCards(result.cards)).toEqual([]);
    expect(backfillCards(result.promotionQueue)).toEqual([]);
  });

  it('buildTrendsBackfillInsights builds at account scope, never a direction, and hides LastEventRecap without an event', () => {
    const matches = realisticFixture();
    const nowMs = matches[matches.length - 1]!.time + HOUR_MS;
    const backfill = buildTrendsBackfillInsights({ matches, horizon: 'last30', nowMs });
    for (const insight of backfill) {
      expect(insight.scopeKey).toBe('account');
      expect(insight.deltaPoints).toBeNull();
    }
    const recap = backfill.find((insight) => insight.templateId === 'lastEventRecap');
    expect(recap?.state ?? 'hidden').toBe('hidden');
  });

  it('assembleTrendsRail over own reads only is deep-equal to the generic assembler', () => {
    const matches = realisticFixture();
    const nowMs = matches[matches.length - 1]!.time + HOUR_MS;
    const own = trendsInsights(matches, 'last30', nowMs).filter(
      (insight) => !TRENDS_BACKFILL_TEMPLATE_IDS.has(insight.templateId),
    );
    expect(assembleTrendsRail({ insights: own })).toEqual(assembleRail({ insights: own }));
  });
});

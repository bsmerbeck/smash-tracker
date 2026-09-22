import { describe, expect, it } from 'vitest';
import { ratingMoveTemplate, isNotableRatingMove } from './ratingMove.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Match } from '../../match.js';

const BASE_TIME_MS = 1_700_000_000_000;
const NOW_MS = BASE_TIME_MS + 365 * 24 * 60 * 60 * 1000;

function buildMatches(outcomes: boolean[], startTime = BASE_TIME_MS, gapMs = 60_000): Match[] {
  let t = startTime;
  return outcomes.map((win, i) => {
    t += gapMs;
    return {
      id: `rm-${startTime}-${i}`,
      fighter_id: 8,
      opponent_id: 23,
      time: t,
      win,
    };
  });
}

function buildInsight(matches: Match[]) {
  const result = ratingMoveTemplate.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs: NOW_MS,
  });
  return result.length > 0 ? result[0]! : null;
}

describe('isNotableRatingMove (DD-12 RD-band rule)', () => {
  it('one point below the rating deviation is not a move', () => {
    expect(isNotableRatingMove(71, 72)).toBe(false);
    expect(isNotableRatingMove(-71, 72)).toBe(false);
  });

  it('exactly at the rating deviation asserts a move', () => {
    expect(isNotableRatingMove(72, 72)).toBe(true);
    expect(isNotableRatingMove(-72, 72)).toBe(true);
  });
});

describe('ratingMoveTemplate', () => {
  it('registers exactly once in COHORT_TEMPLATES', () => {
    const matches = COHORT_TEMPLATES.filter((t) => t.id === 'ratingMove');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(ratingMoveTemplate);
  });

  it('asserts a Trend once the delta reaches the current RD, and reports steady below it (real Glicko history)', () => {
    // `last30` always takes the last 30 games; a 60-game prior block (large
    // enough that the recent 30 never trips the D-06 collapse ratio) plus a
    // 30-game recent block cleanly separates "start" (end of the prior
    // block) from "end" (after the recent 30).
    const prior = buildMatches(Array(60).fill(false));
    const priorEnd = prior[prior.length - 1]!.time;

    const steadyRecent = buildMatches(
      [...Array(6).fill(true), ...Array(24).fill(false)],
      priorEnd + 4 * 60 * 60 * 1000,
    );
    const steadyInsight = buildInsight([...prior, ...steadyRecent])!;
    expect(steadyInsight).not.toBeNull();
    expect(steadyInsight.state).toBe('steady');
    expect(steadyInsight.deltaPoints).toBeNull();

    const trendRecent = buildMatches(
      [...Array(10).fill(true), ...Array(20).fill(false)],
      priorEnd + 4 * 60 * 60 * 1000,
    );
    const trendInsight = buildInsight([...prior, ...trendRecent])!;
    expect(trendInsight).not.toBeNull();
    expect(trendInsight.state).toBe('trend');
    expect(trendInsight.deltaPoints).not.toBeNull();
  });

  it('emits the collapsed Fact variant when the recent window covers most of the baseline (D-06)', () => {
    // total=40, last30 -> recent=30, baseline(prior)=10; 30 >= 0.6*10 -> collapsed.
    const matches = buildMatches(Array(40).fill(true));
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).toBe('collapsed');
    expect(insight.deltaPoints).toBeNull();
  });

  it('emits the thin variant when the window is below TREND_MIN_RECENT_GAMES', () => {
    const matches = buildMatches(Array(5).fill(true));
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).toBe('thin');
    expect(insight.deltaPoints).toBeNull();
  });

  it('CR-A02: locked copy.values.count is games STILL NEEDED (gamesNeeded), never the games already played', () => {
    const matches = buildMatches(Array(2).fill(true));
    const insight = buildInsight(matches)!;
    expect(insight).not.toBeNull();
    expect(insight.state).toBe('locked');
    expect(insight.gamesNeeded).toBe(1);
    expect(insight.copy.values.count).toBe(1);
  });

  it('windowExpressible is true — a rating window is a contiguous scoped window the existing axes express', () => {
    expect(ratingMoveTemplate.windowExpressible).toBe(true);
  });
});

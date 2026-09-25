import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tiltCostTemplate } from './tiltCost.js';
import { formNowTemplate } from './formNow.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ACCOUNT_SCOPE } from '../types.js';
import { mulberry32 } from '../../testUtils/prng.js';
import type { Match } from '../../match.js';

const BASE_TIME_MS = 1_700_000_000_000;
const NOW_MS = BASE_TIME_MS + 365 * 24 * 60 * 60 * 1000;

/** Builds a deterministic `Match[]` from a plain win/loss outcome sequence — one game per boolean, strictly chronological, one minute apart. */
function buildMatches(outcomes: boolean[]): Match[] {
  return outcomes.map((win, index): Match => ({
    id: `tiltcost-${index}`,
    fighter_id: 8,
    opponent_id: 23,
    time: BASE_TIME_MS + index * 60_000,
    win,
  }));
}

function buildInsight(matches: Match[]) {
  const result = tiltCostTemplate.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs: NOW_MS,
  });
  return result.length > 0 ? result[0]! : null;
}

/** 8 wins then 5 losses — the first 2 losses are baseline, the trailing 3 are "spots"; each subsequent block's leading win also lands as a spot because the loss streak (5) hasn't been broken until that win fires. */
const UNDERPERFORM_BLOCK = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  false,
  false,
  false,
  false,
  false,
];

function repeat(block: boolean[], times: number): boolean[] {
  return Array.from({ length: times }, () => block).flat();
}

describe('tiltCostTemplate', () => {
  it('registers exactly once in COHORT_TEMPLATES', () => {
    const matches = COHORT_TEMPLATES.filter((t) => t.id === 'tiltCost');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(tiltCostTemplate);
  });

  it('returns [] when the account has zero two-loss-streak spots yet', () => {
    // Alternating win/loss never accumulates 2 consecutive losses.
    const outcomes = Array.from({ length: 20 }, (_, i) => i % 2 === 0);
    const insight = buildInsight(buildMatches(outcomes));
    expect(insight).toBeNull();
  });

  it('a clearly underperforming spot cohort yields a Trend with a negative deltaPoints', () => {
    // 3 blocks -> 11 spots (>= COHORT_MIN_SIDE_GAMES, < SUGGESTION_MIN_GAMES), spot rate ~18% vs baseline ~79%.
    const outcomes = repeat(UNDERPERFORM_BLOCK, 3);
    const insight = buildInsight(buildMatches(outcomes));
    expect(insight).not.toBeNull();
    expect(insight!.state).toBe('trend');
    expect(insight!.deltaPoints).not.toBeNull();
    expect(insight!.deltaPoints!).toBeLessThan(0);
    expect(insight!.window.games).toBe(11);
  });

  it('cohort A at exactly COHORT_MIN_SIDE_GAMES - 1 (7) yields locked with a positive gamesNeeded', () => {
    // 10 wins (baseline) then 9 losses: the first 2 losses are baseline, the trailing 7 are spots.
    const outcomes = [...Array(10).fill(true), ...Array(9).fill(false)];
    const insight = buildInsight(buildMatches(outcomes));
    expect(insight).not.toBeNull();
    expect(insight!.state).toBe('locked');
    expect(insight!.window.games).toBe(7);
    expect(insight!.gamesNeeded).toBe(1);
    expect(insight!.deltaPoints).toBeNull();
  });

  it('cohort A at exactly COHORT_MIN_SIDE_GAMES (8) is eligible for the notability test, not locked', () => {
    // 10 wins then 10 losses: first 2 losses baseline, trailing 8 are spots.
    const outcomes = [...Array(10).fill(true), ...Array(10).fill(false)];
    const insight = buildInsight(buildMatches(outcomes));
    expect(insight).not.toBeNull();
    expect(insight!.state).not.toBe('locked');
    expect(insight!.window.games).toBe(8);
  });

  it('a spot rate matching the baseline rate yields steady with deltaPoints null', () => {
    const rng = mulberry32(4);
    const outcomes = Array.from({ length: 200 }, () => rng() < 0.55);
    const insight = buildInsight(buildMatches(outcomes));
    expect(insight).not.toBeNull();
    expect(insight!.state).toBe('steady');
    expect(insight!.deltaPoints).toBeNull();
  });

  it('cohort A at SUGGESTION_MIN_GAMES (20) with a notable gap returns the Suggestion key; one game fewer returns Trend', () => {
    const suggestionOutcomes = [...repeat(UNDERPERFORM_BLOCK, 5), false];
    const suggestionInsight = buildInsight(buildMatches(suggestionOutcomes));
    expect(suggestionInsight).not.toBeNull();
    expect(suggestionInsight!.window.games).toBe(20);
    expect(suggestionInsight!.state).toBe('suggestion');
    expect(suggestionInsight!.copy.key).toBe('insights.tiltCost.suggestion');

    const trendOutcomes = repeat(UNDERPERFORM_BLOCK, 5);
    const trendInsight = buildInsight(buildMatches(trendOutcomes));
    expect(trendInsight).not.toBeNull();
    expect(trendInsight!.window.games).toBe(19);
    expect(trendInsight!.state).toBe('trend');
    expect(trendInsight!.copy.key).toBe('insights.tiltCost.trend');
  });

  it('windowExpressible is false — tiltCost is a non-contiguous cohort, unlike formNow', () => {
    expect(tiltCostTemplate.windowExpressible).toBe(false);
    expect(formNowTemplate.windowExpressible).toBe(true);
  });

  it('declares no bare notability literal (1.96, 8 or 20) other than the one declared geometry constant', () => {
    const sourcePath = fileURLToPath(new URL('./tiltCost.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const exemptionLine = 'const TILT_STREAK_LENGTH = 2;';
    const lines = source.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed === exemptionLine ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      ) {
        continue;
      }
      const bareNotabilityLiteral = /(?<![\w.])(1\.96|8|20)(?![\w.])/.test(trimmed);
      if (bareNotabilityLiteral) {
        expect(`"${trimmed}"`).toBe('<no bare 1.96, 8 or 20 literal>');
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { sessionFatigueTemplate } from './sessionFatigue.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Match } from '../../match.js';

const BASE_TIME_MS = 1_700_000_000_000;
const NOW_MS = BASE_TIME_MS + 365 * 24 * 60 * 60 * 1000;
const WITHIN_SESSION_GAP_MS = 60_000;
/** Comfortably above `splitIntoSessions`' 3h default gap. */
const BETWEEN_SESSION_GAP_MS = 4 * 60 * 60 * 1000;

function buildSessionMatches(
  sessionCount: number,
  sessionSize: number,
  outcomeAt: (sessionIndex: number, gameIndex: number) => boolean,
): Match[] {
  const matches: Match[] = [];
  let t = BASE_TIME_MS;
  for (let s = 0; s < sessionCount; s += 1) {
    for (let g = 0; g < sessionSize; g += 1) {
      matches.push({
        id: `s${s}g${g}`,
        fighter_id: 8,
        opponent_id: 23,
        time: t,
        win: outcomeAt(s, g),
      });
      t += WITHIN_SESSION_GAP_MS;
    }
    t += BETWEEN_SESSION_GAP_MS;
  }
  return matches;
}

function buildInsight(matches: Match[]) {
  const result = sessionFatigueTemplate.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs: NOW_MS,
  });
  return result.length > 0 ? result[0]! : null;
}

describe('sessionFatigueTemplate', () => {
  it('registers exactly once in COHORT_TEMPLATES', () => {
    const matches = COHORT_TEMPLATES.filter((t) => t.id === 'sessionFatigue');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(sessionFatigueTemplate);
  });

  it('is hidden below the declared minimum long-session count (9 long sessions of 21 games each)', () => {
    const matches = buildSessionMatches(9, 21, () => true);
    const insight = buildInsight(matches);
    expect(insight).not.toBeNull();
    expect(insight!.state).toBe('hidden');
  });

  it('is non-hidden at exactly the declared minimum long-session count (10 long sessions of 21 games each)', () => {
    // Alternating win/loss within each session -> late (index 20) and early
    // (indices 0-9) cohorts land close to the same 50% rate.
    const matches = buildSessionMatches(10, 21, (_s, g) => g % 2 === 0);
    const insight = buildInsight(matches);
    expect(insight).not.toBeNull();
    expect(insight!.state).not.toBe('hidden');
  });

  it('every non-hidden state carries the standing caveat value in copy.values', () => {
    const steady = buildInsight(buildSessionMatches(10, 21, (_s, g) => g % 2 === 0))!;
    expect(steady.state).not.toBe('hidden');
    expect(steady.copy.values.caveat).toBeTruthy();

    // Engineered clear fatigue: the first 10 games of every session are all
    // wins (the early cohort), the trailing game (index 20, the late
    // cohort) is always a loss.
    const trendMatches = buildSessionMatches(10, 21, (_s, g) => g < 10);
    const trend = buildInsight(trendMatches)!;
    expect(trend.state).toBe('trend');
    expect(trend.deltaPoints).not.toBeNull();
    expect(trend.deltaPoints!).toBeLessThan(0);
    expect(trend.copy.values.caveat).toBeTruthy();
  });

  it('windowExpressible is false — sessionFatigue is a non-contiguous, in-session cohort', () => {
    expect(sessionFatigueTemplate.windowExpressible).toBe(false);
  });

  it('scopeKind is account and assertsDirection is true', () => {
    expect(sessionFatigueTemplate.scopeKind).toBe('account');
    expect(sessionFatigueTemplate.assertsDirection).toBe(true);
  });
});

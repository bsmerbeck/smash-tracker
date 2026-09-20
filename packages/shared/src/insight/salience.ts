import type { ConfidenceTier } from '../evidence/types.js';
import { SALIENCE_WEIGHTS } from './policy.js';
import type { Insight } from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function confidenceTierRank(tier: ConfidenceTier | null): number {
  if (tier === 'high') return 3;
  if (tier === 'medium') return 2;
  if (tier === 'low') return 1;
  return 0;
}

/**
 * A pure, deterministic combination of effect size, sample size and
 * recency (`SALIENCE_WEIGHTS`, `policy.ts`) — two calls with the same
 * `insight`/`nowMs` always return the identical number. No `Math.random`,
 * no internal `Date.now()` read — the caller (`engine.ts`'s
 * `computeInsights`, the ONLY caller) passes `nowMs` explicitly.
 *
 * Exported ONLY so `computeInsights` can populate `Insight.salience` in one
 * place; nothing downstream (`rail.ts` included) should call this again —
 * `rail.ts` sorts by the ALREADY-POPULATED `Insight.salience` field. The
 * score is never exposed to a render path other than that field — the UI
 * must never display it (UI-SPEC §7.8 rule 1: "Salience is never rendered").
 */
export function scoreInsight(insight: Insight, nowMs: number): number {
  const absDelta = insight.deltaPoints === null ? 0 : Math.abs(insight.deltaPoints);
  const recentGames = insight.recent.sample.eligibleDenominator;
  const logRecentSample = Math.log(recentGames + 1);
  const tierRank = confidenceTierRank(insight.recent.sample.confidenceTier);
  const ageMs =
    insight.window.toMs === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, nowMs - insight.window.toMs);
  const recency = Number.isFinite(ageMs) ? 1 / (1 + ageMs / MS_PER_DAY) : 0;

  return (
    SALIENCE_WEIGHTS.absDelta * absDelta +
    SALIENCE_WEIGHTS.logRecentSample * logRecentSample +
    SALIENCE_WEIGHTS.confidenceTier * tierRank +
    SALIENCE_WEIGHTS.recency * recency
  );
}

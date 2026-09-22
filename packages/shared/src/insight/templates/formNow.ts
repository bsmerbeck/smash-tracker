import type { Match } from '../../match.js';
import { ABSTENTION_FLOOR_GAMES } from '../../evidence/policy.js';
import { resolveWindow, toRateValue, buildRateClaim, matchDateRange } from '../horizon.js';
import { classify } from '../ladder.js';
import { wilsonInterval } from '../wilsonInterval.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'formNow' as const;

/**
 * D-07/UI-SPEC §9.4: `FormNow`'s verdict copy key. Direction (`up`/`down`) is
 * a key SUFFIX per UI-SPEC §9.2 rule 4, never an interpolated word; horizon
 * phrasing is part of the key for the states that vary by horizon (rule 3).
 * The exact i18n key namespace ships with the Track C wiring plan that adds
 * these strings to `en.json` and its five siblings — this function only
 * needs to produce a STABLE, well-formed key path, not the final shipped
 * one.
 */
function buildCopyKey(
  state: Insight['state'],
  deltaPoints: number | null,
  horizon: HorizonKey,
): string {
  if (state === 'trend' || state === 'suggestion') {
    const direction = deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
    return `insights.${TEMPLATE_ID}.${state === 'suggestion' ? 'suggestion' : direction}.${horizon}`;
  }
  if (state === 'collapsed') {
    return `insights.${TEMPLATE_ID}.collapsed.${horizon}`;
  }
  return `insights.${TEMPLATE_ID}.${state}`;
}

function buildFormNowInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  const scopedMatches = scope.filter(matches);
  if (scopedMatches.length === 0) {
    // 0 games in scope -> no card at all (the same "never an invented tick" discipline
    // UI-SPEC §7.10's FormStrip zero-state uses) — distinct from "some games but below the
    // abstention floor", which is the `locked` state below.
    return null;
  }

  const scoped = scope.kind !== 'account';
  const { window, matches: recentMatches } = resolveWindow({
    matches: scopedMatches,
    horizon,
    scoped,
    nowMs,
  });
  const recentRate = toRateValue(recentMatches);
  const baselineRate = toRateValue(scopedMatches);

  // FormNow never carries an actionable suggestion (UI-SPEC §9.4 lists only
  // trend/steady/collapsed/thinRecent/locked for this card) — hasAction is always false.
  const { state, kind, deltaPoints } = classify({
    recent: recentRate,
    baseline: baselineRate,
    scoped,
    hasAction: false,
  });

  const recentClaim = buildRateClaim({
    rate: recentRate,
    refreshedAt: nowMs,
    dateRange: { fromMs: window.fromMs, toMs: window.toMs },
  });
  const baselineClaim = buildRateClaim({
    rate: baselineRate,
    refreshedAt: nowMs,
    dateRange: matchDateRange(scopedMatches),
  });

  const gamesNeeded =
    state === 'locked' ? Math.max(0, ABSTENTION_FLOOR_GAMES - recentRate.total) : undefined;

  // Review finding (this plan, 39.1-13): `insights.formNow.steady`
  // interpolates `{{lower}}`/`{{upper}}` (the recent window's own Wilson
  // interval, formatted as whole percents) — `classify` computes this
  // interval internally to DECIDE the steady branch but never returns it, so
  // it is recomputed here (the same inputs `classify` already used) rather
  // than adding a second return field to `ClassifyResult` for a value only
  // one state's copy needs. Harmless to compute unconditionally: no other
  // state's locale key reads `lower`/`upper`.
  const recentInterval = wilsonInterval(recentRate.wins, recentRate.total);

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;

  const insight: Insight = {
    id,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind,
    state,
    recent: recentClaim,
    baseline: baselineClaim,
    deltaPoints,
    window,
    // Placeholder until `computeInsights` (engine.ts) overwrites this with
    // `salience.ts`'s `scoreInsight(insight, nowMs)` — a template never sets
    // its own final salience (see engine.ts's doc comment).
    salience: 0,
    copy: {
      key: buildCopyKey(state, deltaPoints, horizon),
      values: {
        record: `${recentRate.wins}–${recentRate.losses}`,
        rate: `${Math.round(recentRate.rate * 100)}%`,
        // Review finding CR-A02: `insights.formNow.locked_one/_other` reads
        // `{{count}}` as "how many MORE games are needed" — must be
        // `gamesNeeded`, never the games already played (which is always
        // below the floor by construction whenever `state === 'locked'`).
        count: state === 'locked' ? gamesNeeded! : recentRate.total,
        points: deltaPoints !== null ? Math.abs(deltaPoints) : 0,
        baselineRate: `${Math.round(baselineRate.rate * 100)}%`,
        baselineGames: baselineRate.total,
        lower: `${Math.round(recentInterval.lower * 100)}%`,
        upper: `${Math.round(recentInterval.upper * 100)}%`,
        ...(window.fromMs !== null ? { from: new Date(window.fromMs).toISOString() } : {}),
        ...(window.toMs !== null ? { to: new Date(window.toMs).toISOString() } : {}),
      },
    },
    doors: [
      {
        kind: 'games',
        axes: { ...(scope.axes ?? {}) },
        count: window.games,
      },
    ],
    ...(gamesNeeded !== undefined ? { gamesNeeded } : {}),
  };

  return insight;
}

/**
 * The first real template (Task 1's tracer). One `Insight` per call — never
 * more than one, since `FormNow` states a single verdict for its scope.
 * `windowExpressible: true`: its games are the last n in scope, a contiguous
 * window the existing drill-down axes already express (UI-SPEC §13.13a).
 */
export const formNowTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: true,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildFormNowInsight(input);
    return insight === null ? [] : [insight];
  },
};

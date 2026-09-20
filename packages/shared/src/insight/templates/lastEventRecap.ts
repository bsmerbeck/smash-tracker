import type { Match } from '../../match.js';
import { buildSetTimeline } from '../../tournamentAggregation.js';
import type { TournamentRegistryRow } from '../../tournamentRegistry.js';
import { toRateValue, buildRateClaim, matchDateRange } from '../horizon.js';
import type { HorizonKey, Insight, InsightScope, RateValue } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'lastEventRecap' as const;
/** How many lost sets the sub line names before falling back to a count-only phrasing. */
const MAX_SET_LOSSES_NAMED = 3;

/**
 * Ported, not imported, from `insight/horizon.ts`'s private `eventKeyOf` — that function isn't
 * exported, and duplicating the (tiny) precedence rule here keeps this template self-contained
 * rather than reaching into another module's internals. `eventName` takes priority,
 * `tournamentName` is the fallback; an empty/whitespace name reads as "no event".
 */
function eventKeyOf(match: Match): string | null {
  const raw = match.eventName ?? match.tournamentName;
  if (raw == null) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The games belonging to whichever named event key has the most recent game in `matches`, or `null` when no game carries an event name at all. */
function mostRecentEventGames(matches: Match[]): { eventKey: string; games: Match[] } | null {
  let latestKey: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const match of matches) {
    const key = eventKeyOf(match);
    if (key === null) {
      continue;
    }
    if (match.time > latestTime) {
      latestTime = match.time;
      latestKey = key;
    }
  }
  if (latestKey === null) {
    return null;
  }
  return { eventKey: latestKey, games: matches.filter((m) => eventKeyOf(m) === latestKey) };
}

function buildHiddenInsight(scope: InsightScope, horizon: HorizonKey, nowMs: number): Insight {
  const emptyRate: RateValue = { wins: 0, losses: 0, total: 0, rate: 0 };
  const emptyClaim = buildRateClaim({
    rate: emptyRate,
    refreshedAt: nowMs,
    dateRange: { fromMs: null, toMs: null },
  });
  return {
    id: `${TEMPLATE_ID}:${scope.key}:${horizon}`,
    templateId: TEMPLATE_ID,
    scopeKey: scope.key,
    horizon,
    kind: 'fact',
    state: 'hidden',
    recent: emptyClaim,
    baseline: emptyClaim,
    deltaPoints: null,
    window: { horizon, fromMs: null, toMs: null, games: 0, scoped: false },
    salience: 0,
    copy: { key: `insights.${TEMPLATE_ID}.hidden`, values: {} },
    doors: [],
  };
}

function setLossSubLine(sets: ReturnType<typeof buildSetTimeline>['sets']): {
  key: string;
  values: Record<string, string | number>;
} {
  const losses = sets.filter((s) => !s.won);
  if (losses.length === 0) {
    return { key: `insights.${TEMPLATE_ID}.noSetLosses`, values: {} };
  }
  const named = losses.slice(0, MAX_SET_LOSSES_NAMED).map((s) => {
    const opponent = s.opponentName ?? 'unknown';
    return `${opponent} ${s.gamesWon}–${s.gamesLost}`;
  });
  return {
    key: `insights.${TEMPLATE_ID}.setLosses`,
    values: { count: losses.length, named: named.join(', ') },
  };
}

/**
 * The core, registry-independent build logic — exported separately from the standard
 * `InsightTemplate.build` interface (which carries no registry-lookup parameter in this wave;
 * `registry.ts`'s `InsightTemplate.build` signature is `{matches, scope, horizon, nowMs}` and this
 * plan does not edit that file). `registryEntry`, when supplied, is the caller's already-resolved
 * `tournamentRegistry.ts` row for this event — a later Track C wiring plan looks one up and passes
 * it here directly; `lastEventRecapTemplate.build` below calls this with `registryEntry: undefined`,
 * which is always a correct, if unenriched, result (DD-02, A-03-1).
 */
export function buildLastEventRecapInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
  registryEntry?: TournamentRegistryRow;
}): Insight {
  const { matches, scope, horizon, nowMs, registryEntry } = input;
  const scopedMatches = scope.filter(matches);
  const found = mostRecentEventGames(scopedMatches);
  if (found === null) {
    return buildHiddenInsight(scope, horizon, nowMs);
  }
  const { eventKey, games } = found;
  const gameRecord = toRateValue(games);
  const { sets } = buildSetTimeline(games);
  const hasSets = sets.length > 0;
  const setsWon = sets.filter((s) => s.won).length;
  const setsLost = sets.length - setsWon;

  const claim = buildRateClaim({
    rate: gameRecord,
    refreshedAt: nowMs,
    dateRange: matchDateRange(games),
  });

  // A-03-1: enrich only from fields the schema actually declares (`tournamentRegistry.ts`'s
  // `placement`/`numEntrants`), and only when BOTH are present — otherwise degrade to W-L only.
  const hasPlacement = registryEntry?.placement != null && registryEntry?.numEntrants != null;

  let copyKey: string;
  const values: Record<string, string | number> = {
    event: eventKey,
    gameRecord: `${gameRecord.wins}–${gameRecord.losses}`,
    gameCount: gameRecord.total,
  };
  if (hasSets) {
    values.setRecord = `${setsWon}–${setsLost}`;
    values.setCount = sets.length;
  }
  if (hasPlacement) {
    values.placement = registryEntry!.placement!;
    values.entrants = registryEntry!.numEntrants!;
    copyKey = hasSets
      ? `insights.${TEMPLATE_ID}.factPlacement`
      : `insights.${TEMPLATE_ID}.factPlacementGamesOnly`;
  } else {
    copyKey = hasSets ? `insights.${TEMPLATE_ID}.fact` : `insights.${TEMPLATE_ID}.factGamesOnly`;
  }

  if (hasSets) {
    const subLine = setLossSubLine(sets);
    values.subLineKey = subLine.key;
    Object.assign(values, subLine.values);
  }

  const insight: Insight = {
    id: `${TEMPLATE_ID}:${scope.key}:${horizon}`,
    templateId: TEMPLATE_ID,
    scopeKey: scope.key,
    horizon,
    kind: 'fact',
    state: 'fact',
    recent: claim,
    baseline: claim,
    deltaPoints: null,
    window: {
      horizon,
      fromMs: matchDateRange(games).fromMs,
      toMs: matchDateRange(games).toMs,
      games: gameRecord.total,
      scoped: false,
    },
    salience: 0,
    copy: { key: copyKey, values },
    // DD-01: no `Track` door. DD-02: no debrief door — 39.1 ships the link-less factual card only.
    doors: [
      { kind: 'event', axes: { ...(scope.axes ?? {}), event: eventKey }, count: games.length },
      { kind: 'games', axes: { ...(scope.axes ?? {}), event: eventKey }, count: gameRecord.total },
    ],
  };

  return insight;
}

/**
 * "the last event, honestly" (DD-02): a direction-free FACT card reporting the subject's most
 * recent tournament event's game and set record, degrading to W–L only when the registry has
 * nothing to add, and reporting itself `hidden` (never `locked`, never an empty card) when the
 * subject has no tournament event at all. `windowExpressible: true`: its games are exactly one
 * named event's games, reproducible from the `event` drill-down axis.
 */
export const lastEventRecapTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'character',
  assertsDirection: false,
  windowExpressible: true,
  build(input): Insight[] {
    if (input.scope.kind !== 'character') {
      return [];
    }
    return [buildLastEventRecapInsight({ ...input, registryEntry: undefined })];
  },
};

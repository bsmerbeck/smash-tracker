import type { Match } from '../../match.js';
import { buildSetTimeline } from '../../tournamentAggregation.js';
import type { TierBasis, TierWord } from '../../tournamentTier.js';
import { toRateValue, buildRateClaim, matchDateRange, countedMatchIdsOf } from '../horizon.js';
import { classify, type ClassifyResult } from '../ladder.js';
import type { HorizonKey, Insight, InsightScope, RateValue } from '../types.js';
import type { InsightTemplate } from './registry.js';
import { buildSetStripMark } from '../marks.js';

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

/**
 * The registry fields the recap reads, as a STRUCTURAL subset: a live `TournamentEntry` (the
 * `GET /api/tournaments` row) and a `TournamentRegistryRow` both satisfy it, so a caller passes
 * whichever it holds and the template never imports either schema (F10).
 */
export interface RecapRegistryFields {
  placement?: number | null;
  numEntrants?: number | null;
  tournamentName?: string | null;
}

/** The resolved tier a caller attaches so the card can name it; the engine stays locale-free. */
export interface RecapTier {
  tier: TierWord;
  basis: TierBasis;
}

/** The D-10 two-horizon read of one event: the engine's own `classify` over the event's games against all games. */
export interface EventHorizonRead extends ClassifyResult {
  /** The event's games. */
  recent: RateValue;
  /** All of the subject's games (the event's own included, as the horizon reads everywhere else). */
  baseline: RateValue;
}

/**
 * D-10: how the event compares with the player's norm, through the ONE honesty ladder
 * (`classify`) and never an ad-hoc rule. A small event reads `thin` or `locked` (no direction);
 * an event that IS most of the history reads `collapsed`. `scoped: false` and `hasAction:
 * false`: the event window is not a D-15 scoped read and the recap recommends nothing.
 */
export function buildEventHorizonRead(input: {
  eventMatches: Match[];
  baselineMatches: Match[];
}): EventHorizonRead {
  const recent = toRateValue(input.eventMatches);
  const baseline = toRateValue(input.baselineMatches);
  return { ...classify({ recent, baseline, scoped: false, hasAction: false }), recent, baseline };
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
    countedMatchIds: [],
  };
}

/** A set's opponent tag, or null when no game named one (an empty / whitespace tag reads as no name). */
function opponentNameOf(set: ReturnType<typeof buildSetTimeline>['sets'][number]): string | null {
  const trimmed = set.opponentName?.trim();
  return trimmed ? trimmed : null;
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
    const record = `${s.gamesWon}–${s.gamesLost}`;
    // Plan 39.1-40: an unnamed opponent contributes its record alone — never
    // an English fallback word inside a translated sentence.
    const opponent = opponentNameOf(s);
    return opponent === null ? record : `${opponent} ${record}`;
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
  registryEntry?: RecapRegistryFields;
  /** Plan 39.2-13: the entry's resolved tier, carried as two short strings for the card's badge. */
  tier?: RecapTier;
}): Insight {
  const { matches, scope, horizon, nowMs, registryEntry, tier } = input;
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
  if (tier !== undefined) {
    values.tier = tier.tier;
    values.tierBasis = tier.basis;
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
    // Plan 39.1-22: the one named event's own games — the same set `gameRecord.total` counts.
    countedMatchIds: countedMatchIdsOf(games),
    // Plan 39.1-40 (sketch 002-C, UI-SPEC §7.10): one SetStrip tick per set, in set order.
    ...(hasSets
      ? {
          mark: buildSetStripMark(
            sets.map((set) => ({
              setId: set.setId,
              won: set.won,
              opponentName: opponentNameOf(set),
              gamesWon: set.gamesWon,
              gamesLost: set.gamesLost,
            })),
          ),
        }
      : {}),
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

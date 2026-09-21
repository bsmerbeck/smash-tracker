import type { Match } from '../../match.js';
import { getFighterById } from '../../fighterData.js';
import { toRateValue, buildRateClaim, matchDateRange } from '../horizon.js';
import type { HorizonKey, Insight, InsightScope, RateValue } from '../types.js';
import type { InsightTemplate } from './registry.js';

const TEMPLATE_ID = 'rosterCore' as const;

/**
 * The Match Data roster model's three thresholds (UI-SPEC §8.4). Review
 * finding C1-M4: these are NOT acceptance values and NOT an owner-locked
 * decision — they are **declared engine defaults versioned under
 * `INSIGHT_POLICY_VERSION`** (`insight/policy.ts`), the same treatment
 * A-01-1 gives DD-12's constants. UI-SPEC §8.4 PROPOSES "MAIN: top-share
 * fighter established at >= 20 games" / "SECONDARIES: share >= 8% AND >= 20
 * games"; this plan ADOPTS those numbers as engineering defaults. A later
 * revision may retune any of the three; that revision bumps
 * `INSIGHT_POLICY_VERSION`. `buildRosterModel` is the SINGLE definition of
 * "main"/"secondary"/"pocket" — the Match Data card (plan 39.1-16) reads
 * these exported constants and this function rather than re-deriving its
 * own split.
 */
export const ROSTER_MAIN_MIN_GAMES = 20;
/** A fraction 0..1, never a percent — matches `RateValue.rate`'s convention. */
export const ROSTER_SECONDARY_MIN_SHARE = 0.08;
export const ROSTER_SECONDARY_MIN_GAMES = 20;

/** One fighter's share of a roster: its own game count, its share of the account's total games, and its win/loss record. */
export interface RosterFighterEntry {
  fighterId: number;
  games: number;
  /** A fraction 0..1 of `RosterModel.totalGames` — never a percent (percent formatting is the UI's job). */
  share: number;
  rate: RateValue;
}

/** The pooled "everything else" group — every fighter that is neither the main nor a secondary, combined into one record. */
export interface RosterPocketGroup {
  fighterIds: number[];
  games: number;
  rate: RateValue;
}

/** The Match Data roster model (UI-SPEC §8.4): MAIN / SECONDARIES / POCKETS, derived once from a scope's own `Match[]` — never re-derived by a component. */
export interface RosterModel {
  /** `null` when the top-share fighter has not yet reached `ROSTER_MAIN_MIN_GAMES` — "main not established yet". */
  main: RosterFighterEntry | null;
  /** Every fighter (other than `main`) at or above both `ROSTER_SECONDARY_MIN_GAMES` and `ROSTER_SECONDARY_MIN_SHARE`. Empty whenever `main` is `null` (no fighter could then have reached the game floor either, since `main` is by definition the fighter with the most games). */
  secondaries: RosterFighterEntry[];
  /** Every remaining fighter, pooled into one combined record. */
  pockets: RosterPocketGroup;
  totalGames: number;
}

function groupByFighterId(matches: Match[]): Map<number, Match[]> {
  const groups = new Map<number, Match[]>();
  for (const match of matches) {
    const existing = groups.get(match.fighter_id);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(match.fighter_id, [match]);
    }
  }
  return groups;
}

/**
 * The single definition of the Match Data roster model (UI-SPEC §8.4). Pure:
 * takes a `Match[]` already narrowed to whatever scope the caller cares
 * about (the account scope, for every template in this file) and derives
 * MAIN / SECONDARIES / POCKETS from it. `main` is the top-share (most
 * games) fighter, established only at or above `ROSTER_MAIN_MIN_GAMES`; ties
 * on games break by ascending `fighterId` for determinism. `secondaries` are
 * every OTHER fighter at or above both `ROSTER_SECONDARY_MIN_GAMES` and
 * `ROSTER_SECONDARY_MIN_SHARE`. `pockets` pools everything left over.
 */
export function buildRosterModel(input: { matches: Match[] }): RosterModel {
  const { matches } = input;
  const totalGames = matches.length;
  const groups = groupByFighterId(matches);

  const entries: RosterFighterEntry[] = [];
  for (const [fighterId, groupMatches] of groups) {
    const rate = toRateValue(groupMatches);
    entries.push({
      fighterId,
      games: rate.total,
      share: totalGames > 0 ? rate.total / totalGames : 0,
      rate,
    });
  }
  entries.sort((a, b) => b.games - a.games || a.fighterId - b.fighterId);

  const topEntry = entries[0] ?? null;
  const main: RosterFighterEntry | null =
    topEntry !== null && topEntry.games >= ROSTER_MAIN_MIN_GAMES ? topEntry : null;

  const remaining =
    main !== null ? entries.filter((entry) => entry.fighterId !== main.fighterId) : entries;

  const secondaries = remaining.filter(
    (entry) =>
      entry.games >= ROSTER_SECONDARY_MIN_GAMES && entry.share >= ROSTER_SECONDARY_MIN_SHARE,
  );
  const secondaryIds = new Set(secondaries.map((entry) => entry.fighterId));
  const pocketEntries = remaining.filter((entry) => !secondaryIds.has(entry.fighterId));
  const pocketMatches = pocketEntries.flatMap((entry) => groups.get(entry.fighterId) ?? []);

  return {
    main,
    secondaries,
    pockets: {
      fighterIds: pocketEntries.map((entry) => entry.fighterId).sort((a, b) => a - b),
      games: pocketEntries.reduce((sum, entry) => sum + entry.games, 0),
      rate: toRateValue(pocketMatches),
    },
    totalGames,
  };
}

function fighterNameFor(id: number): string {
  return getFighterById(id)?.name ?? String(id);
}

function buildRosterCoreInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
}): Insight | null {
  const { matches, scope, horizon, nowMs } = input;
  if (scope.kind !== 'account') {
    // The roster model answers "which of the WHOLE ACCOUNT's fighters is the
    // main" — it has no meaning narrowed to one already-selected fighter or
    // opponent-character pairing. `INSIGHT_TEMPLATES` is a closed registry
    // every caller iterates at whatever scope it's invoking (engine.ts's own
    // doc comment); declining every scope kind this template doesn't apply
    // to keeps it inert, mirroring `SUBJECT_TEMPLATES`' own scope-kind guard
    // (plan 39.1-03).
    return null;
  }
  const scopedMatches = scope.filter(matches);
  if (scopedMatches.length === 0) {
    return null;
  }

  const model = buildRosterModel({ matches: scopedMatches });
  const dateRange = matchDateRange(scopedMatches);
  const asserting = model.main !== null;
  const state: Insight['state'] = asserting ? 'fact' : 'thin';

  const claim = buildRateClaim({
    rate: asserting ? model.main!.rate : toRateValue(scopedMatches),
    refreshedAt: nowMs,
    dateRange,
  });

  const scopeKey = scope.key;
  const id = `${TEMPLATE_ID}:${scopeKey}:${horizon}`;

  const insight: Insight = {
    id,
    templateId: TEMPLATE_ID,
    scopeKey,
    horizon,
    kind: 'fact',
    state,
    recent: claim,
    baseline: claim,
    deltaPoints: null,
    window: {
      horizon,
      fromMs: dateRange.fromMs,
      toMs: dateRange.toMs,
      games: asserting ? model.main!.games : scopedMatches.length,
      scoped: false,
    },
    salience: 0,
    copy: {
      key: `insights.${TEMPLATE_ID}.${state}`,
      values: asserting
        ? {
            fighter: fighterNameFor(model.main!.fighterId),
            share: Math.round(model.main!.share * 100),
            secondaryCount: model.secondaries.length,
            pocketCount: model.pockets.fighterIds.length,
          }
        : {
            count: ROSTER_MAIN_MIN_GAMES,
          },
    },
    doors: asserting
      ? [
          {
            kind: 'games',
            axes: { ...(scope.axes ?? {}), fighter: model.main!.fighterId },
            count: model.main!.games,
          },
        ]
      : [],
  };

  return insight;
}

/**
 * `RosterCore` (INS-05, UI-SPEC §8.4/§9.4): a direction-free FACT naming the
 * account's main, its share of play, and the secondary/pocket counts —
 * `thin` ("main not established yet") below `ROSTER_MAIN_MIN_GAMES` on the
 * top-share fighter. `windowExpressible: true`: the main's games are the
 * whole (contiguous, no non-contiguous filtering) set of that fighter's
 * games, reproducible from the `fighter=` drill-down axis (UI-SPEC §8.4:
 * "Rows → /fighter-analysis?fighter=").
 */
export const rosterCoreTemplate: InsightTemplate = {
  id: TEMPLATE_ID,
  scopeKind: 'account',
  assertsDirection: false,
  windowExpressible: true,
  build(input): Insight[] {
    const insight = buildRosterCoreInsight(input);
    return insight === null ? [] : [insight];
  },
};

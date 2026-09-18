import {
  buildSetTimeline,
  resolveRuleset,
  legalStagesFor,
  ABSTENTION_FLOOR_GAMES,
  type Match,
  type TournamentEntry,
  type TournamentSet,
  type ResolvedRuleset,
  type SetState,
} from '@smash-tracker/shared';
import { rankStagesByEvidence, pickBanSplit, type RankedStage } from '@/lib/stats';

export type PickClassification = 'followed' | 'against' | 'neutral' | 'no-data';

/**
 * Which clause produced a game's classification (plan 37-06, D-14) — kept
 * SEPARATE from `classification` because two different clauses can land on
 * the SAME classification value. ADV-02 names exactly four classification
 * values, so a game played on a stage outside the event's ruleset is graded
 * as `'neutral'` ("no stance") rather than invented as a fifth value — but
 * its REASON ("the advisor never ranked this stage") is not the same reason
 * an ordinary in-ruleset neutral game gets ("ranked, but neither a pick nor
 * a ban"). The four values here are exactly the four cases the UI must
 * render a distinct reason line for:
 * - `'graded'` — the stage was ranked and the game is `'followed'` or `'against'`.
 * - `'no-stance'` — the stage was ranked but landed in neither the pick nor the ban slice.
 * - `'outside-ruleset'` — the played stage is not legal under the event's resolved ruleset, so it was never a candidate at all.
 * - `'no-data'` — the stage is unknown (`map.id` 0) or there wasn't enough pre-tournament pairing evidence to rank anything.
 */
export type GameReasonKind = 'graded' | 'no-stance' | 'outside-ruleset' | 'no-data';

export interface ClassifiedGame {
  match: Match;
  classification: PickClassification;
  /** Which clause produced `classification` — see `GameReasonKind`'s doc comment. */
  reasonKind: GameReasonKind;
  /** The advisor's recommended picks (stage ids) at the time this game was played, empty when no-data or outside the ruleset. */
  recommendedStageIds: number[];
  /** The advisor's ban-worthy stages (stage ids) at the time this game was played, empty when no-data or outside the ruleset. */
  banStageIds: number[];
}

export interface RetrospectiveSetRow {
  set: TournamentSet;
  games: ClassifiedGame[];
}

export interface AdherenceSummary {
  /** Count of games classified as 'followed' or 'against' (i.e. excluding neutral/no-data) — the denominator for adherence. */
  classifiable: number;
  followed: number;
  against: number;
  neutral: number;
  noData: number;
  /** followed / classifiable, as a whole-number percentage. `null` when classifiable is 0. */
  adherenceRate: number | null;
  /** Win rate (0-100) among 'followed' games. `null` when there are zero followed games. */
  followedWinRate: number | null;
  /** Win rate (0-100) among 'against' games. `null` when there are zero against games. */
  againstWinRate: number | null;
}

export interface Retrospective {
  rows: RetrospectiveSetRow[];
  /** Classified games outside any set (the "other matches" bucket), same shape as set rows' games. */
  otherGames: ClassifiedGame[];
  summary: AdherenceSummary;
  /**
   * The ruleset every game above was graded under — resolved ONCE per build
   * (D-14) so the card can disclose the exact same answer it graded with,
   * never a second `resolveRuleset` call that could disagree.
   */
  resolvedRuleset: ResolvedRuleset;
}

/**
 * D-11: per-game bans, strikes and picker role were never recorded on a
 * match, and this milestone does not add them — grading a HISTORICAL game
 * therefore can't reconstruct the exact set state that applied when it was
 * played. Rather than inventing a set state that implies knowledge the data
 * doesn't carry, grading treats every stage the event's ruleset makes legal
 * AT ALL as available: the later game phase (so starters plus counterpicks
 * are both in play) and the STRIKING role (so `legalStagesFor`'s DSR clause,
 * which only ever restricts the PICKING player, never fires), with no prior
 * stages and no bans recorded. The result is exactly "starters union
 * counterpicks, no repeat-rule removal" — and the card discloses this basis
 * honestly (`tournaments.retro.gradingBasis`) rather than silently choosing
 * a narrower set state.
 */
const GRADING_SET_STATE: SetState = {
  phase: 'game2plus',
  role: 'striking',
  priorStages: [],
  bannedStageIds: [],
  setFormat: 'bo3',
};

/**
 * Classifies one game against the advisor's recommendation for its pairing,
 * computed from ONLY matches strictly before `entry.firstSetAt` (the state
 * of knowledge a player would have had walking into the tournament), scoped
 * to the same fighter_id/opponent_id pairing as the game itself, and to the
 * event's legal stage set (D-14, EVID-05) — an illegal-but-evidenced stage
 * can never be ranked as a candidate. A stage id of 0 ("no selection"/
 * unknown) can't be graded and is treated as no-data at the call site (see
 * `buildRetrospective`), not here — this function only ever receives a
 * non-zero stage id.
 */
function classifyGame(
  game: Match,
  preMatches: Match[],
  legalStageIds: ReadonlySet<number>,
): ClassifiedGame {
  const stageId = game.map?.id ?? 0;

  if (!legalStageIds.has(stageId)) {
    return {
      match: game,
      classification: 'neutral',
      reasonKind: 'outside-ruleset',
      recommendedStageIds: [],
      banStageIds: [],
    };
  }

  const pairingPre = preMatches.filter(
    (m) => m.fighter_id === game.fighter_id && m.opponent_id === game.opponent_id,
  );
  const ranked = rankStagesByEvidence(pairingPre, ABSTENTION_FLOOR_GAMES, legalStageIds);

  if (ranked.length === 0) {
    return {
      match: game,
      classification: 'no-data',
      reasonKind: 'no-data',
      recommendedStageIds: [],
      banStageIds: [],
    };
  }

  const { picks, bans }: { picks: RankedStage[]; bans: RankedStage[] } = pickBanSplit(ranked);
  const recommendedStageIds = picks.map((s) => s.stageId);
  const banStageIds = bans.map((s) => s.stageId);

  if (recommendedStageIds.includes(stageId)) {
    return {
      match: game,
      classification: 'followed',
      reasonKind: 'graded',
      recommendedStageIds,
      banStageIds,
    };
  }
  if (banStageIds.includes(stageId)) {
    return {
      match: game,
      classification: 'against',
      reasonKind: 'graded',
      recommendedStageIds,
      banStageIds,
    };
  }
  return {
    match: game,
    classification: 'neutral',
    reasonKind: 'no-stance',
    recommendedStageIds,
    banStageIds,
  };
}

/**
 * Grades every game in the games with a known stage and known pairing
 * against what the Counterpick Advisor would have recommended using only
 * pre-tournament evidence, filtered to the event's resolved ruleset (the
 * stored per-event override when one exists, the house default otherwise —
 * D-14, EVID-04). Games with an unknown stage (`map.id === 0` or missing
 * `map`) are always 'no-data' — there's nothing to grade. Pure builder; the
 * UI (`AdvisorRetrospective.tsx`) only renders this structure.
 *
 * @param allMatches every match the user has (used to derive pre-tournament evidence).
 * @param entryMatches the matches belonging to this specific tournament entry (via `matchesForEntry`).
 * @param entry the tournament entry being graded.
 */
export function buildRetrospective(
  allMatches: Match[],
  entryMatches: Match[],
  entry: TournamentEntry,
): Retrospective {
  const preMatches = allMatches.filter((m) => m.time < entry.firstSetAt);
  const { sets, otherMatches } = buildSetTimeline(entryMatches);

  const resolvedRuleset = resolveRuleset(entry.rulesetOverride);
  const legalStageIds = new Set(legalStagesFor(resolvedRuleset.ruleset, GRADING_SET_STATE));

  const classify = (match: Match): ClassifiedGame => {
    const stageId = match.map?.id ?? 0;
    if (stageId === 0) {
      return {
        match,
        classification: 'no-data',
        reasonKind: 'no-data',
        recommendedStageIds: [],
        banStageIds: [],
      };
    }
    return classifyGame(match, preMatches, legalStageIds);
  };

  const rows: RetrospectiveSetRow[] = sets.map((set) => ({
    set,
    games: set.games.map((g) => classify(g.match)),
  }));
  const otherGames = otherMatches.map((match) => classify(match));

  const allGames = [...rows.flatMap((r) => r.games), ...otherGames];

  let followed = 0;
  let against = 0;
  let neutral = 0;
  let noData = 0;
  let followedWins = 0;
  let againstWins = 0;

  for (const g of allGames) {
    switch (g.classification) {
      case 'followed':
        followed += 1;
        if (g.match.win) {
          followedWins += 1;
        }
        break;
      case 'against':
        against += 1;
        if (g.match.win) {
          againstWins += 1;
        }
        break;
      case 'neutral':
        neutral += 1;
        break;
      case 'no-data':
        noData += 1;
        break;
    }
  }

  const classifiable = followed + against;

  const summary: AdherenceSummary = {
    classifiable,
    followed,
    against,
    neutral,
    noData,
    adherenceRate: classifiable > 0 ? Math.round((followed / classifiable) * 100) : null,
    followedWinRate: followed > 0 ? Math.round((followedWins / followed) * 100) : null,
    againstWinRate: against > 0 ? Math.round((againstWins / against) * 100) : null,
  };

  return { rows, otherGames, summary, resolvedRuleset };
}

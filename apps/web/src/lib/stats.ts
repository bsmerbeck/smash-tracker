import type { Match } from '@smash-tracker/shared';

/**
 * Client-side match aggregation, extracted from the inline math legacy
 * screens each computed themselves. Preserves legacy semantics (thresholds,
 * tie-break sort orders, rounding) exactly — see the per-function docs below
 * for their legacy source. Every function here is a pure function over a
 * `Match[]` (no fetching, no React) so Phase 4b screens (Matchups, MatchData,
 * FighterAnalysis) can reuse them.
 *
 * Matches are always sorted by `time` ascending internally before any
 * "recent" / "streak" logic runs, since callers (TanStack Query results,
 * RTDB reads) don't guarantee ordering.
 */

/** Sorts matches by `time` ascending. Does not mutate the input array. */
function byTimeAscending(matches: Match[]): Match[] {
  return [...matches].sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Win/loss totals
// ---------------------------------------------------------------------------

export interface WinLossRecord {
  wins: number;
  losses: number;
  total: number;
  /** Win rate as a whole-number percentage (0-100), rounded like legacy's `.toFixed(0)`. `100` when there are no losses (legacy WinLossTracker.js: `losses.length > 0 ? ... : 100`), including when there are zero matches at all. */
  winRate: number;
}

/**
 * Overall win/loss record across the given matches, with no fighter
 * filtering applied by this function — callers filter matches by
 * `fighter_id` first (see `filterByFighter`) to reproduce legacy's
 * per-fighter WinLossTracker (legacy/src/screens/Dashboard/components/WinLossTracker/WinLossTracker.js).
 */
export function getWinLossRecord(matches: Match[]): WinLossRecord {
  const wins = matches.filter((m) => m.win).length;
  const losses = matches.filter((m) => !m.win).length;
  const total = wins + losses;
  const winRate = losses > 0 ? Math.round((wins / total) * 100) : 100;
  return { wins, losses, total, winRate };
}

/** Filters matches down to the ones played as the given fighter id (`fighter_id`, i.e. the tracked user's own character, not the opponent's). */
export function filterByFighter(matches: Match[], fighterId: number): Match[] {
  return matches.filter((m) => m.fighter_id === fighterId);
}

// ---------------------------------------------------------------------------
// Per-fighter records (RosterBreakdown-style, generalized)
// ---------------------------------------------------------------------------

export interface FighterRecord extends WinLossRecord {
  fighterId: number;
}

/**
 * Groups matches by `fighter_id` and computes a win/loss record for each.
 * General form of legacy's RosterBreakdown
 * (legacy/src/screens/FighterAnalysis/components/RosterBreakdown/RosterBreakdown.js),
 * which did this per-opponent for a single selected fighter; here it's keyed
 * by whichever fighter field the caller wants (pass `m => m.fighter_id` or
 * `m => m.opponent_id`).
 */
export function getRecordsByFighter(
  matches: Match[],
  keyFn: (match: Match) => number = (m) => m.fighter_id,
): FighterRecord[] {
  const byId = new Map<number, Match[]>();
  for (const match of matches) {
    const id = keyFn(match);
    const group = byId.get(id);
    if (group) {
      group.push(match);
    } else {
      byId.set(id, [match]);
    }
  }
  return [...byId.entries()].map(([fighterId, fighterMatches]) => ({
    fighterId,
    ...getWinLossRecord(fighterMatches),
  }));
}

// ---------------------------------------------------------------------------
// Last-N results (for charts)
// ---------------------------------------------------------------------------

export interface RunningWinRatePoint {
  /** 1-based match index within the selected series, matching legacy MatchChart's `count` label. */
  index: number;
  /** Running win rate (0-100) through this match, matching legacy MatchChart's `winRate` (unrounded percentage, e.g. `66.66666...`). */
  winRate: number;
  match: Match;
}

/**
 * Running win-rate series in chronological order, one point per match, for
 * the "last matches" chart. Mirrors legacy MatchChart.js
 * (legacy/src/screens/Dashboard/components/LastMatchesChart/components/MatchChart/MatchChart.js):
 * `winRate = (winCount / count) * 100.0` accumulated match-by-match,
 * intentionally NOT rounded here (legacy rounds only in the tooltip, not the
 * plotted value).
 */
export function getRunningWinRateSeries(matches: Match[]): RunningWinRatePoint[] {
  const sorted = byTimeAscending(matches);
  let winCount = 0;
  return sorted.map((match, i) => {
    if (match.win) {
      winCount += 1;
    }
    const index = i + 1;
    return { index, winRate: (winCount / index) * 100, match };
  });
}

/**
 * The most recent `limit` matches, newest first. Mirrors legacy
 * PreviousMatches.js: `entries.slice(-1 * limit).reverse()` after sorting by
 * key/time ascending — i.e. take the last `limit` chronologically, then
 * reverse to show newest-first.
 */
export function getLastNMatches(matches: Match[], limit: number): Match[] {
  const sorted = byTimeAscending(matches);
  return sorted.slice(-limit).reverse();
}

// ---------------------------------------------------------------------------
// Best/worst matchup (legacy BestWorstMatchup.js)
// ---------------------------------------------------------------------------

export interface MatchupStats {
  /** The opponent's fighter id (`opponent_id`). */
  opponentFighterId: number;
  wins: number;
  losses: number;
  totalMatches: number;
  /** Win rate as a whole-number percentage; `100` when there are no losses. */
  ratio: number;
}

/**
 * Per-opponent-fighter win/loss/ratio breakdown, sorted best-ratio-first with
 * the tie-break from legacy BestWorstMatchup.js:
 * `b.ratio === a.ratio ? (b.wins + b.losses) - (a.wins - a.losses) : b.ratio - a.ratio`.
 * Only matchups meeting `minMatches` (legacy's "Minimum Match Threshold",
 * default `5`) are included.
 *
 * `matches` should already be filtered to the fighter/context of interest
 * (legacy filtered to `fighter_id === context.fighter.id` before calling
 * this); this function itself only groups by `opponent_id`.
 */
export function getMatchupStats(matches: Match[], minMatches = 5): MatchupStats[] {
  const byOpponent = new Map<number, Match[]>();
  for (const match of matches) {
    const group = byOpponent.get(match.opponent_id);
    if (group) {
      group.push(match);
    } else {
      byOpponent.set(match.opponent_id, [match]);
    }
  }

  const stats: MatchupStats[] = [...byOpponent.entries()].map(([opponentFighterId, ms]) => {
    const wins = ms.filter((m) => m.win).length;
    const losses = ms.filter((m) => !m.win).length;
    const totalMatches = wins + losses;
    const ratio = losses ? Math.round((wins / (wins + losses)) * 100) : 100;
    return { opponentFighterId, wins, losses, totalMatches, ratio };
  });

  return stats
    .filter((m) => m.totalMatches >= minMatches)
    .sort((a, b) => {
      if (b.ratio === a.ratio) {
        return b.wins + b.losses - (a.wins - a.losses);
      }
      return b.ratio - a.ratio;
    });
}

export interface BestWorstMatchup {
  best: MatchupStats[];
  worst: MatchupStats[];
}

/**
 * Splits `getMatchupStats`'s sorted list into "best" (top) and "worst"
 * (bottom) entries, matching legacy BestWorstMatchup.js's `bwCount`
 * calculation: half the qualifying matchups, capped at 3, floored, with a
 * minimum of 1 when there's at least one qualifying matchup. `worst` is in
 * ascending-badness order taken from the tail of the sorted list (index
 * `length - 1`, `length - 2`, ...), i.e. NOT reversed to worst-first — this
 * matches legacy's `twList` construction order.
 */
export function getBestWorstMatchup(matches: Match[], minMatches = 5): BestWorstMatchup {
  const sorted = getMatchupStats(matches, minMatches);
  if (sorted.length === 0) {
    return { best: [], worst: [] };
  }

  const half = sorted.length / 2;
  const count = half >= 1 ? Math.min(3, Math.floor(half)) : 1;

  const best: MatchupStats[] = [];
  const worst: MatchupStats[] = [];
  for (let i = 0; i < count; i++) {
    const bestEntry = sorted[i];
    const worstEntry = sorted[sorted.length - 1 - i];
    if (bestEntry) {
      best.push(bestEntry);
    }
    if (worstEntry) {
      worst.push(worstEntry);
    }
  }
  return { best, worst };
}

// ---------------------------------------------------------------------------
// Win/loss streaks (legacy StreakCard.js)
// ---------------------------------------------------------------------------

export interface StreakSummary {
  /** Longest consecutive run of wins anywhere in the (chronologically sorted) series. */
  bestWinStreak: number;
  /** Longest consecutive run of losses anywhere in the series. */
  worstLossStreak: number;
  /** Length of the active streak as of the most recent match. */
  currentStreak: number;
  /** Whether the current/active streak is a win streak (`true`) or loss streak (`false`). `true` when there are no matches, matching legacy's `lastStreak([])` default. */
  currentStreakIsWin: boolean;
}

/**
 * Longest win streak, longest loss streak, and the current (most recent)
 * streak, chronologically. Ports legacy StreakCard.js's `winStreak` /
 * `loseStreak` / `lastStreak` helpers
 * (legacy/src/screens/FighterAnalysis/components/StreakCard/StreakCard.js)
 * verbatim in behavior, including that a single win (or loss) counts as a
 * streak of 1.
 */
export function getStreakSummary(matches: Match[]): StreakSummary {
  const sorted = byTimeAscending(matches);

  if (sorted.length === 0) {
    return { bestWinStreak: 0, worstLossStreak: 0, currentStreak: 0, currentStreakIsWin: true };
  }

  let bestWinStreak = 0;
  let winRun = 0;
  let worstLossStreak = 0;
  let lossRun = 0;
  for (const match of sorted) {
    if (match.win) {
      winRun += 1;
      lossRun = 0;
    } else {
      lossRun += 1;
      winRun = 0;
    }
    bestWinStreak = Math.max(bestWinStreak, winRun);
    worstLossStreak = Math.max(worstLossStreak, lossRun);
  }

  const lastValue = sorted[sorted.length - 1]?.win ?? true;
  let currentStreak = 1;
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i]?.win !== lastValue) {
      break;
    }
    currentStreak += 1;
  }

  return { bestWinStreak, worstLossStreak, currentStreak, currentStreakIsWin: lastValue };
}

// ---------------------------------------------------------------------------
// Per-stage breakdowns (legacy StageBreakdown.js)
// ---------------------------------------------------------------------------

export interface StageRecord extends WinLossRecord {
  /** The stage's `map.id` (0 = "no selection"/unknown). */
  stageId: number;
}

/**
 * Win/loss record per stage (`map.id`), for the given matches. Ports legacy
 * StageBreakdown.js's per-stage win/loss/rate math
 * (legacy/src/screens/MatchData/components/StageBreakdown/StageBreakdown.js).
 * Legacy defaulted a missing `map` to `{ id: 0, name: "no selection" }`
 * before grouping — this function does the same for matches missing `map`.
 */
export function getStageRecords(matches: Match[]): StageRecord[] {
  const byStage = new Map<number, Match[]>();
  for (const match of matches) {
    const stageId = match.map?.id ?? 0;
    const group = byStage.get(stageId);
    if (group) {
      group.push(match);
    } else {
      byStage.set(stageId, [match]);
    }
  }
  return [...byStage.entries()].map(([stageId, stageMatches]) => ({
    stageId,
    ...getWinLossRecord(stageMatches),
  }));
}

// ---------------------------------------------------------------------------
// Threshold-based best/worst stages (v2 analytics — correct math, not the
// preserved legacy RosterBreakdown quirks)
// ---------------------------------------------------------------------------

export interface BestWorstStages {
  best: StageRecord | null;
  worst: StageRecord | null;
}

/**
 * Best and worst stage among the given matches, considering only stages with
 * at least `minMatches` recorded matches. The unknown-stage sentinel
 * (`map.id` 0) never qualifies — it isn't an actionable recommendation.
 * Best = highest win rate, worst = lowest; ties broken by larger sample
 * size. When exactly one stage qualifies it is reported as `best` only —
 * a single stage can't be both the recommendation and the warning.
 */
export function getBestWorstStages(matches: Match[], minMatches = 3): BestWorstStages {
  const qualifying = getStageRecords(matches).filter(
    (record) => record.stageId !== 0 && record.total >= minMatches,
  );
  if (qualifying.length === 0) {
    return { best: null, worst: null };
  }

  const sorted = [...qualifying].sort((a, b) =>
    b.winRate === a.winRate ? b.total - a.total : b.winRate - a.winRate,
  );
  const best = sorted[0] ?? null;
  const worst = sorted.length > 1 ? (sorted[sorted.length - 1] ?? null) : null;
  return { best, worst };
}

// ---------------------------------------------------------------------------
// Matchup stage guide (v2 analytics)
// ---------------------------------------------------------------------------

export interface MatchupStageGuideRow {
  /** The opponent's fighter id (`opponent_id`). */
  opponentFighterId: number;
  record: WinLossRecord;
  bestStage: StageRecord | null;
  worstStage: StageRecord | null;
}

/**
 * For each opponent fighter actually faced in the given matches: the
 * win/loss record for that matchup plus the best and worst stage to fight
 * that opponent on, using `getBestWorstStages` with `minStageMatches` as the
 * per-stage qualification threshold. Rows are sorted by sample size (total
 * matches) descending, then win rate descending, so the most-informed
 * matchups lead.
 */
export function getMatchupStageGuide(
  matches: Match[],
  minStageMatches = 3,
): MatchupStageGuideRow[] {
  const byOpponent = new Map<number, Match[]>();
  for (const match of matches) {
    const group = byOpponent.get(match.opponent_id);
    if (group) {
      group.push(match);
    } else {
      byOpponent.set(match.opponent_id, [match]);
    }
  }

  return [...byOpponent.entries()]
    .map(([opponentFighterId, opponentMatches]) => ({
      opponentFighterId,
      record: getWinLossRecord(opponentMatches),
      ...getBestWorstStages(opponentMatches, minStageMatches),
    }))
    .map(({ opponentFighterId, record, best, worst }) => ({
      opponentFighterId,
      record,
      bestStage: best,
      worstStage: worst,
    }))
    .sort((a, b) =>
      b.record.total === a.record.total
        ? b.record.winRate - a.record.winRate
        : b.record.total - a.record.total,
    );
}

// ---------------------------------------------------------------------------
// Match-type splits (v2 analytics)
// ---------------------------------------------------------------------------

export interface MatchTypeRecord extends WinLossRecord {
  /** The stored `matchType` literal; missing/empty values group under 'unspecified'. */
  matchType: string;
}

/**
 * Win/loss record per match type ('quickplay', 'online-tourney', ...).
 * Matches with no `matchType` (older records, or the '' / 'none' literals)
 * group under 'unspecified'. Sorted by sample size descending.
 */
export function getMatchTypeRecords(matches: Match[]): MatchTypeRecord[] {
  const byType = new Map<string, Match[]>();
  for (const match of matches) {
    const raw = match.matchType ?? '';
    const key = raw === '' || raw === 'none' ? 'unspecified' : raw;
    const group = byType.get(key);
    if (group) {
      group.push(match);
    } else {
      byType.set(key, [match]);
    }
  }
  return [...byType.entries()]
    .map(([matchType, typeMatches]) => ({
      matchType,
      ...getWinLossRecord(typeMatches),
    }))
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// Per-opponent (human) records (legacy OpponentTable.js)
// ---------------------------------------------------------------------------

export interface OpponentRecord extends WinLossRecord {
  /** The lowercased free-text opponent name (`match.opponent`). */
  opponent: string;
}

/**
 * Win/loss record per human opponent name (`match.opponent`), ignoring
 * matches with no opponent name recorded. Ports legacy OpponentTable.js
 * (legacy/src/screens/FighterAnalysis/components/OpponentTable/OpponentTable.js),
 * which filtered to `m.opponent && m.opponent.length > 0` before grouping.
 */
export function getOpponentRecords(matches: Match[]): OpponentRecord[] {
  const named = matches.filter((m) => m.opponent && m.opponent.length > 0);
  const byOpponent = new Map<string, Match[]>();
  for (const match of named) {
    // Safe: filtered to truthy, non-empty `opponent` above.
    const name = match.opponent as string;
    const group = byOpponent.get(name);
    if (group) {
      group.push(match);
    } else {
      byOpponent.set(name, [match]);
    }
  }
  return [...byOpponent.entries()].map(([opponent, opponentMatches]) => ({
    opponent,
    ...getWinLossRecord(opponentMatches),
  }));
}

// ---------------------------------------------------------------------------
// Stage usage (for "most played" ordering in stage pickers)
// ---------------------------------------------------------------------------

/**
 * Counts how many times each stage (`map.id`) appears across the given
 * matches. The unknown-stage sentinel (`map.id` 0 / missing `map`) is
 * included like `getStageRecords` — callers that build "most played"
 * pickers should exclude id 0 themselves, since it isn't a real stage
 * option to promote.
 */
export function getStageUsage(matches: Match[]): Map<number, number> {
  const usage = new Map<number, number>();
  for (const match of matches) {
    const stageId = match.map?.id ?? 0;
    usage.set(stageId, (usage.get(stageId) ?? 0) + 1);
  }
  return usage;
}

import { splitIntoSessions, type Match } from '@smash-tracker/shared';

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

// ---------------------------------------------------------------------------
// V3 stats engine: evidence-aware rankings (docs/analytics-vision.md)
// ---------------------------------------------------------------------------

/**
 * Lower bound of the Wilson score interval (default z = 1.96 ≈ 95%): a
 * pessimistic-but-fair estimate of the true win rate given the sample size.
 * Ranking by this instead of the raw rate keeps a lucky 1-0 from outranking
 * a proven 12-3. Returns 0 for an empty sample.
 */
export function wilsonLowerBound(wins: number, total: number, z = 1.96): number {
  if (total === 0) {
    return 0;
  }
  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - spread) / denominator);
}

export interface RankedMatchup extends MatchupStats {
  /** Wilson lower bound (0-1) for this matchup's win rate. */
  wilson: number;
}

/**
 * Per-opponent-fighter records ranked by Wilson lower bound (best first),
 * ties broken by sample size. Unlike the legacy-faithful `getMatchupStats`,
 * this is the v3 evidence-aware ranking; `minMatches` merely hides noise
 * rows and defaults to 1 because the ranking itself is sample-aware.
 */
export function rankMatchupsByEvidence(matches: Match[], minMatches = 1): RankedMatchup[] {
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
    .map(([opponentFighterId, ms]) => {
      const wins = ms.filter((m) => m.win).length;
      const losses = ms.length - wins;
      const totalMatches = ms.length;
      const ratio = losses ? Math.round((wins / totalMatches) * 100) : 100;
      return {
        opponentFighterId,
        wins,
        losses,
        totalMatches,
        ratio,
        wilson: wilsonLowerBound(wins, totalMatches),
      };
    })
    .filter((entry) => entry.totalMatches >= minMatches)
    .sort((a, b) =>
      b.wilson === a.wilson ? b.totalMatches - a.totalMatches : b.wilson - a.wilson,
    );
}

export interface RankedStage extends StageRecord {
  /** Wilson lower bound (0-1) for this stage's win rate. */
  wilson: number;
}

/**
 * Stage records ranked by Wilson lower bound (best first). The unknown-stage
 * sentinel (id 0) never appears — it isn't an actionable pick.
 */
export function rankStagesByEvidence(matches: Match[], minMatches = 1): RankedStage[] {
  return getStageRecords(matches)
    .filter((record) => record.stageId !== 0 && record.total >= minMatches)
    .map((record) => ({ ...record, wilson: wilsonLowerBound(record.wins, record.total) }))
    .sort((a, b) => (b.wilson === a.wilson ? b.total - a.total : b.wilson - a.wilson));
}

// ---------------------------------------------------------------------------
// V3 stats engine: form and time
// ---------------------------------------------------------------------------

export interface RollingWinRatePoint {
  /** 1-based match index within the series. */
  index: number;
  /** Win rate (0-100) over the trailing `window` matches ending here. */
  winRate: number;
  match: Match;
}

/**
 * Trailing-window win rate per match, chronologically — the "form curve".
 * Early points use however many matches exist so the curve starts at match 1.
 */
export function getRollingWinRate(matches: Match[], window = 10): RollingWinRatePoint[] {
  const sorted = [...matches].sort((a, b) => a.time - b.time);
  return sorted.map((match, i) => {
    const slice = sorted.slice(Math.max(0, i - window + 1), i + 1);
    const wins = slice.filter((m) => m.win).length;
    return { index: i + 1, winRate: (wins / slice.length) * 100, match };
  });
}

export interface MonthlyRecord extends WinLossRecord {
  /** Calendar month key, e.g. '2021-01' (UTC). */
  month: string;
}

/** Win/loss record per calendar month (UTC), chronologically ascending. */
export function getMonthlyRecords(matches: Match[]): MonthlyRecord[] {
  const byMonth = new Map<string, Match[]>();
  for (const match of matches) {
    const d = new Date(match.time);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const group = byMonth.get(key);
    if (group) {
      group.push(match);
    } else {
      byMonth.set(key, [match]);
    }
  }
  return [...byMonth.entries()]
    .map(([month, ms]) => ({ month, ...getWinLossRecord(ms) }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export interface OnlineOfflineSplit {
  online: WinLossRecord;
  offline: WinLossRecord;
  /** Matches whose type doesn't identify a setting ('none', '', missing). */
  unspecified: WinLossRecord;
}

/**
 * Record split by setting. 'quickplay', 'online-friendly', 'online-tourney'
 * count as online; 'offline-friendly'/'offline-tourney' as offline.
 */
export function getOnlineOfflineSplit(matches: Match[]): OnlineOfflineSplit {
  const online: Match[] = [];
  const offline: Match[] = [];
  const unspecified: Match[] = [];
  for (const match of matches) {
    const type = match.matchType ?? '';
    if (type === 'quickplay' || type.startsWith('online')) {
      online.push(match);
    } else if (type.startsWith('offline')) {
      offline.push(match);
    } else {
      unspecified.push(match);
    }
  }
  return {
    online: getWinLossRecord(online),
    offline: getWinLossRecord(offline),
    unspecified: getWinLossRecord(unspecified),
  };
}

// ---------------------------------------------------------------------------
// V3 stats engine: sessions
// ---------------------------------------------------------------------------

export interface SessionStats extends WinLossRecord {
  /** Epoch ms of the session's first and last match. */
  start: number;
  end: number;
  /** Longest consecutive loss run inside this session (tilt indicator). */
  longestLossRun: number;
}

const DEFAULT_SESSION_GAP_MS = 3 * 60 * 60 * 1000;

/**
 * Groups matches into play sessions: a gap of more than `gapMs` (default 3h)
 * between consecutive matches starts a new session. Chronological order.
 * Delegates the actual grouping to `@smash-tracker/shared`'s
 * `splitIntoSessions` (also used by the shared Glicko rating-history model)
 * so there's exactly one session-splitting implementation; this function
 * only adds the richer `SessionStats` aggregates (win/loss, longest loss
 * run) on top of each group.
 */
export function getSessions(matches: Match[], gapMs = DEFAULT_SESSION_GAP_MS): SessionStats[] {
  const groups = splitIntoSessions(matches, gapMs);
  return groups.map((group) => {
    let run = 0;
    let longestLossRun = 0;
    for (const match of group) {
      run = match.win ? 0 : run + 1;
      longestLossRun = Math.max(longestLossRun, run);
    }
    return {
      start: group[0]!.time,
      end: group[group.length - 1]!.time,
      longestLossRun,
      ...getWinLossRecord(group),
    };
  });
}

// ---------------------------------------------------------------------------
// V3 stats engine: opponent scouting
// ---------------------------------------------------------------------------

export interface OpponentProfile {
  /** The lowercased opponent tag. */
  opponent: string;
  record: WinLossRecord;
  firstPlayedAt: number;
  lastPlayedAt: number;
  /** Their characters against you, evidence-ranked from YOUR perspective. */
  byTheirFighter: RankedMatchup[];
  byStage: StageRecord[];
  /** Most recent matches first. */
  recent: Match[];
}

/** Head-to-head profile vs one human opponent, or null when never played. */
export function getOpponentProfile(
  matches: Match[],
  opponentTag: string,
  recentLimit = 10,
): OpponentProfile | null {
  const versus = matches.filter((m) => m.opponent === opponentTag);
  if (versus.length === 0) {
    return null;
  }
  const sorted = [...versus].sort((a, b) => a.time - b.time);
  return {
    opponent: opponentTag,
    record: getWinLossRecord(versus),
    firstPlayedAt: sorted[0]!.time,
    lastPlayedAt: sorted[sorted.length - 1]!.time,
    byTheirFighter: rankMatchupsByEvidence(versus),
    byStage: getStageRecords(versus).sort((a, b) => b.total - a.total),
    recent: sorted.slice(-recentLimit).reverse(),
  };
}

// ---------------------------------------------------------------------------
// V3 stats engine: matchup matrix
// ---------------------------------------------------------------------------

export interface MatchupMatrixCell extends WinLossRecord {
  fighterId: number;
  opponentFighterId: number;
  /** Wilson lower bound (0-1). */
  wilson: number;
}

export interface MatchupMatrix {
  /** Your fighters, ordered by games played descending. */
  fighterIds: number[];
  /** Opponent fighters faced, ordered by games played descending. */
  opponentFighterIds: number[];
  /** One cell per (fighter, opponent) pairing that has at least one match. */
  cells: MatchupMatrixCell[];
}

/** Your-fighters × opponent-fighters grid for the Matchup Lab heatmap. */
export function getMatchupMatrix(matches: Match[]): MatchupMatrix {
  const usage = (keyFn: (m: Match) => number) => {
    const counts = new Map<number, number>();
    for (const match of matches) {
      const key = keyFn(match);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  };

  const byPair = new Map<string, Match[]>();
  for (const match of matches) {
    const key = `${match.fighter_id}:${match.opponent_id}`;
    const group = byPair.get(key);
    if (group) {
      group.push(match);
    } else {
      byPair.set(key, [match]);
    }
  }

  return {
    fighterIds: usage((m) => m.fighter_id),
    opponentFighterIds: usage((m) => m.opponent_id),
    cells: [...byPair.entries()].map(([key, ms]) => {
      const [fighterId, opponentFighterId] = key.split(':').map(Number) as [number, number];
      const record = getWinLossRecord(ms);
      return {
        fighterId,
        opponentFighterId,
        ...record,
        wilson: wilsonLowerBound(record.wins, record.total),
      };
    }),
  };
}

import type { Match } from '../match.js';

/**
 * Relocated verbatim from `apps/web/src/lib/stats.ts` (V7-D promotion,
 * EVID-10): the raw win/loss record shapes and per-stage grouping the rest
 * of the evidence engine (`gate.ts`, `rank.ts`, `stageEvidence.ts`,
 * `matchupEvidence.ts`) is built on top of. Bodies and doc comments are
 * unchanged from their web origin — the promotion moves WHERE this code
 * lives, not WHAT it computes. `apps/web/src/lib/stats.ts` re-exports these
 * names so no existing call site changes.
 */

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
 * `fighter_id` first to reproduce legacy's per-fighter WinLossTracker
 * (legacy/src/screens/Dashboard/components/WinLossTracker/WinLossTracker.js).
 */
export function getWinLossRecord(matches: Match[]): WinLossRecord {
  const wins = matches.filter((m) => m.win).length;
  const losses = matches.filter((m) => !m.win).length;
  const total = wins + losses;
  const winRate = losses > 0 ? Math.round((wins / total) * 100) : 100;
  return { wins, losses, total, winRate };
}

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

export interface MatchupStats {
  /** The opponent's fighter id (`opponent_id`). */
  opponentFighterId: number;
  wins: number;
  losses: number;
  totalMatches: number;
  /** Win rate as a whole-number percentage; `100` when there are no losses. */
  ratio: number;
}

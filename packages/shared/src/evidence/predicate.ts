import type { Match } from '../match.js';
import { SpriteList } from '../fighterData.js';

/** The stage sentinel used throughout the engine for "no selection"/absent `map` — matches `match.map?.id ?? 0`. */
export const UNKNOWN_STAGE_ID = 0;

/** A match's stage bucket id, defaulting an absent `map` to `UNKNOWN_STAGE_ID` — the single definition every stage-keyed grouping in this package uses. */
export function stageBucketId(match: Match): number {
  return match.map?.id ?? UNKNOWN_STAGE_ID;
}

/** True when a match's stage is the unknown sentinel (absent `map`, or `map.id` 0). */
export function isUnknownStage(match: Match): boolean {
  return stageBucketId(match) === UNKNOWN_STAGE_ID;
}

const KNOWN_FIGHTER_IDS = new Set(SpriteList.map((fighter) => fighter.id));

/**
 * True when either side's character id is not a positive integer present in
 * the fighter roster (`packages/shared/src/fighterData.ts`). D-25: this
 * branch has NO live ingestion path today — `startgg/sync.ts` and
 * `parrygg/sync.ts` both drop a game whose character doesn't map to a known
 * fighter id BEFORE it ever reaches a `Match[]` — so it is exercised only by
 * synthetic fixtures. Do not read a passing test here as evidence of
 * production coverage.
 */
export function isUnknownCharacter(match: Match): boolean {
  return !KNOWN_FIGHTER_IDS.has(match.fighter_id) || !KNOWN_FIGHTER_IDS.has(match.opponent_id);
}

/**
 * True for every row of a `Match[]` that has already reached this engine —
 * DQs, byes, walkovers and no-game-detail sets are excluded UPSTREAM at
 * sync time (see `COUNTABLE_GAME_UPSTREAM_RULES` below), so a match this
 * engine ever sees is, by construction, countable. This function exists so
 * that predicate is stated and testable rather than assumed; it is not a
 * second filter layer.
 */
export function isCountableGame(match: Match): boolean {
  void match; // the parameter documents the predicate's shape; every upstream exclusion has already run by the time a Match reaches this function.
  return true;
}

/**
 * D-17/D-25: documents, rather than re-implements, the five upstream
 * exclusion rules that make `isCountableGame` trivially true for anything
 * reaching a `Match[]`. Each `where` names the exact file/line of the real
 * sync-time check; `predicate.test.ts` asserts every path exists on disk so
 * this documentation cannot silently rot as the sync code moves.
 */
export const COUNTABLE_GAME_UPSTREAM_RULES: ReadonlyArray<{
  id: string;
  where: string;
  why: string;
}> = Object.freeze([
  {
    id: 'R-BYE',
    where: 'apps/api/src/startgg/sync.ts:77',
    why: 'A set with no opposing entrant (a bracket bye) is skipped before any game is produced.',
  },
  {
    id: 'R-DQ-FLAG',
    where: 'apps/api/src/startgg/sync.ts:64',
    why: "A set whose displayScore is the literal 'DQ' carries no meaningful game data and is skipped entirely.",
  },
  {
    id: 'R-DQ-DISPLAY',
    where: 'apps/api/src/parrygg/sync.ts:115',
    why: 'A parry.gg match whose state is not MATCH_STATE_COMPLETED is counted as dqOrIncomplete and skipped.',
  },
  {
    id: 'R-WALKOVER-EXPLICIT',
    where: 'apps/api/src/parrygg/sync.ts:114',
    why: 'A two-slot match where both sides scored 0 (no games actually played) is skipped as a walkover.',
  },
  {
    id: 'R-NO-GAME-DETAIL',
    where: 'apps/api/src/startgg/sync.ts:77',
    why: 'A set with zero games, a missing completedAt, or a missing entrant carries nothing importable and is skipped.',
  },
]);

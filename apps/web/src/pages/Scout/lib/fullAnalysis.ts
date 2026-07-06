import type { Match, ScoutGame } from '@smash-tracker/shared';

/**
 * V9-D: adapts a scouted player's per-game records (`ScoutReportData.games`,
 * always from THEIR own perspective — see scoutGameSchema's doc) into the
 * same `Match[]` shape `apps/web/src/lib/stats.ts` operates on, so the Scout
 * page's "Full analysis" section can reuse the exact stats engine and
 * Fighter Analysis components the tracked user's own analysis uses, just
 * pointed at the scouted player's own history instead.
 *
 * This is a client-side, in-memory-only adapter: the resulting `Match[]` is
 * never sent through `matchSchema.parse` or persisted, so the synthetic `id`
 * and any `fighter_id`/`opponent_id` of `0` (the unknown-character/opponent
 * sentinel — see scoutGameSchema) are fine even though `matchSchema` itself
 * requires positive ids for STORED records; nothing here writes to RTDB.
 *
 * Field mapping:
 * - `fighterId` -> `fighter_id`, `opponentFighterId` -> `opponent_id`.
 * - `stageId`/`stageName` -> `map` (present only when the game's stage
 *   resolved to one — omitted otherwise, matching how `getStageRecords`
 *   already treats a missing `map` as "unknown stage").
 * - `opponentTag` -> `opponent`.
 * - `matchType` is a constant sentinel ('none') — scouted games have no
 *   online/offline signal to carry over, and the stats engine only reads
 *   `matchType` for the (unused here) online/offline split.
 */
export function scoutGamesToMatches(games: ScoutGame[]): Match[] {
  return games.map((game, index) => ({
    id: `scout-game-${index}`,
    fighter_id: game.fighterId,
    opponent_id: game.opponentFighterId,
    time: game.time,
    win: game.win,
    opponent: game.opponentTag,
    matchType: 'none',
    ...(game.stageId != null ? { map: { id: game.stageId, name: game.stageName ?? '' } } : {}),
    ...(game.eventName ? { eventName: game.eventName } : {}),
  }));
}

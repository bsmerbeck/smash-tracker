import {
  binEventSeries,
  buildPlayerEventSeries,
  type EventAnchor,
  type EventBin,
  type EventBinGrain,
  type EventDisplaySeries,
  type Match,
  type ScoutGame,
} from '@smash-tracker/shared';

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
    ...(game.tournamentName ? { tournamentName: game.tournamentName } : {}),
  }));
}

/** What the Recent Form card plots: the event anchors themselves, or the calendar grain they were binned to. */
export type ScoutFormGrain = 'event' | EventBinGrain;

/**
 * Plan 41-12 (SC1 / SC2, PD-12-2): the Recent Form card's display series — the
 * scouted player's whole sampled history as ONE event-anchored cumulative
 * series (`buildPlayerEventSeries`, the same private anchoring the opponent hub
 * and the stage page use), binned by the engine to at most 60 points
 * (`binEventSeries`, identity at or under the bound). The chart never bins and
 * no trailing window is computed. `refreshedAt` is the latest game time (0 for
 * none), never a clock read in render. `grain` is `'event'` when the display
 * array is the unbinned anchors, else the first bin's calendar grain.
 */
export function buildScoutFormSeries(matches: Match[]): {
  display: EventDisplaySeries;
  grain: ScoutFormGrain;
} {
  const refreshedAt = matches.reduce((latest, match) => Math.max(latest, match.time), 0);
  const series = buildPlayerEventSeries({ matches, refreshedAt });
  const display = binEventSeries(series);
  const first = display[0];
  const grain: ScoutFormGrain = first && first.kind === 'bin' ? first.grain : 'event';
  return { display, grain };
}

/**
 * The games behind one plotted point, oldest first (ties by id). Identity
 * rule: a point's games are its `matchIds`, never its `[startMs, endMs]`
 * window (the CR-02 lesson — a window can swallow a neighbouring anchor's
 * games). An empty `matchIds` yields no games.
 */
export function gamesBehindPoint(point: EventAnchor | EventBin, matches: Match[]): Match[] {
  const ids = new Set(point.matchIds);
  return matches
    .filter((match) => ids.has(match.id))
    .sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

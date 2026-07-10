import {
  isParryggIdentity,
  isStartggIdentity,
  type ScoutCharacterUsage,
  type ScoutCommonOpponent,
  type ScoutGame,
  type ScoutPlayerIdentity,
  type ScoutRecentEvent,
  type ScoutReportData,
  type ScoutStageUsage,
} from './startgg.js';

/**
 * V13 — combine start.gg + parry.gg scouting.
 *
 * `mergeScoutReports` folds two single-source `ScoutReportData`s (one scouted
 * from start.gg, one from parry.gg, for a player the user has asserted is the
 * same person) into ONE combined report. This is a PURE function — no I/O — and
 * relies on the fact that both scout engines (`apps/api/src/startgg/scout.ts`
 * and `apps/api/src/parrygg/scout.ts`) already emit the exact same
 * `ScoutReportData` shape using THIS app's own roster fighter ids and stage
 * ids, so their per-character / per-stage aggregates add together directly.
 *
 * Everything downstream (the Scout page cards, `assembleReportPayload`'s
 * `vsTopCharacters` / `matchupAdvisor`, the AI report payload) consumes the
 * merged result unchanged — it's just a `ScoutReportData` with a `'combined'`
 * identity.
 */

// Same caps both single-source scout engines apply in their own `toReport`.
const MAX_RECENT_EVENTS = 10;
const MAX_COMMON_OPPONENTS = 10;

/** Sum two arrays of `{ <idKey>, games, wins }` rows by their id, most games first. */
function mergeUsage<T extends { games: number; wins: number }>(
  a: readonly T[],
  b: readonly T[],
  idOf: (row: T) => number,
): T[] {
  const byId = new Map<number, T>();
  for (const row of [...a, ...b]) {
    const key = idOf(row);
    const existing = byId.get(key);
    if (existing) {
      existing.games += row.games;
      existing.wins += row.wins;
    } else {
      // Clone so we never mutate the caller's input rows.
      byId.set(key, { ...row });
    }
  }
  return [...byId.values()].sort((x, y) => y.games - x.games);
}

/**
 * Builds the `'combined'` identity from whichever input is the start.gg scout
 * and whichever is the parry.gg scout. Prefers the start.gg display gamerTag
 * (the two sites can spell a tag differently; start.gg is this app's original
 * canonical source). Conditional-spreads `userSlug` so the merged identity
 * carries no `undefined`/null fields (production-gap #3 — nulls corrupt RTDB
 * reads once this identity is stored on a report record).
 */
function combineIdentity(
  startgg: ScoutPlayerIdentity | undefined,
  parry: ScoutPlayerIdentity | undefined,
  fallback: ScoutPlayerIdentity,
): ScoutPlayerIdentity {
  const id = startgg?.id ?? fallback.id;
  const parryUserId = parry?.parryUserId ?? fallback.parryUserId;
  const userSlug = startgg?.userSlug;
  const gamerTag = startgg?.gamerTag ?? parry?.gamerTag ?? fallback.gamerTag;
  return {
    source: 'combined',
    ...(id !== undefined ? { id } : {}),
    ...(parryUserId !== undefined ? { parryUserId } : {}),
    ...(userSlug ? { userSlug } : {}),
    gamerTag,
  };
}

/**
 * Merges two single-source scout reports into one combined report. Order
 * independent — `a`/`b` may be passed start.gg-first or parry.gg-first; the
 * identity is assembled by inspecting each report's `player.source`. The caller
 * (the API's combined resolver) guarantees one start.gg + one parry.gg report.
 */
export function mergeScoutReports(a: ScoutReportData, b: ScoutReportData): ScoutReportData {
  const startggReport = [a, b].find((r) => isStartggIdentity(r.player));
  const parryReport = [a, b].find((r) => isParryggIdentity(r.player));

  const characters: ScoutCharacterUsage[] = mergeUsage(
    a.characters,
    b.characters,
    (c) => c.fighterId,
  );
  const stages: ScoutStageUsage[] = mergeUsage(a.stages, b.stages, (s) => s.stageId);

  // Recent events: each event keeps its own `source`/`slug`, so provenance
  // survives the merge — just re-sort the combined set newest-first and re-cap.
  const recentEvents: ScoutRecentEvent[] = [...a.recentEvents, ...b.recentEvents]
    .sort((x, y) => y.lastSetAt - x.lastSetAt)
    .slice(0, MAX_RECENT_EVENTS);

  // Common opponents: the same person can appear on both sites spelled with
  // different casing, so merge case-insensitively while keeping the first-seen
  // display casing.
  const opponentsByKey = new Map<string, ScoutCommonOpponent>();
  for (const opponent of [...a.commonOpponents, ...b.commonOpponents]) {
    const key = opponent.gamerTag.toLowerCase();
    const existing = opponentsByKey.get(key);
    if (existing) {
      existing.sets += opponent.sets;
    } else {
      opponentsByKey.set(key, { ...opponent });
    }
  }
  const commonOpponents: ScoutCommonOpponent[] = [...opponentsByKey.values()]
    .sort((x, y) => y.sets - x.sets)
    .slice(0, MAX_COMMON_OPPONENTS);

  // Per-game records (web "Full analysis"): concat — the client stats engine
  // tolerates any ordering. Only present when at least one side had games.
  const games: ScoutGame[] = [...(a.games ?? []), ...(b.games ?? [])];

  return {
    player: combineIdentity(startggReport?.player, parryReport?.player, a.player),
    sampledSets: a.sampledSets + b.sampledSets,
    sampledGames: a.sampledGames + b.sampledGames,
    characters,
    stages,
    recentEvents,
    commonOpponents,
    ...(games.length > 0 ? { games } : {}),
  };
}

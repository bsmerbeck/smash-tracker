import type { ActionTarget } from '@smash-tracker/shared';
import { buildDrillDownSearch } from '@/lib/drillDownParams';
import { buildOpponentHubPath } from '@/lib/analyzeOpponent';

/**
 * Phase 39 (plan 39-11, RPT-09 / D-12): the ONE door builder for a
 * recommended action. It turns an engine `ActionTarget` (axes only — the
 * shared engine never carries a route string) into the PERSONAL path of the
 * evidence behind the action. The card then passes that path through
 * `useSubjectPath`, so a coach or workspace render stays inside its own
 * prefix, and the card itself never spells a route.
 *
 * Every filter axis is written through Phase 38's `buildDrillDownSearch`, and
 * every opponent path through `buildOpponentHubPath` — never a hand-built
 * query string.
 *
 * Returns `null` when the axes cannot name a destination. The engine never
 * emits such a candidate (every claim it cites carries a fighter, stage or
 * opponent axis), but if one arrives the card renders the row WITHOUT a door
 * rather than with a dead one.
 */

const MATCHUPS_PATH = '/matchups';
const STAGE_PATH_PREFIX = '/stages/';
const VOD_PATH = '/vod';
const VOD_MATCH_PARAM = 'match';

/** A known stage id (0 is the unknown-stage bucket, never an addressable stage page). */
function isAddressableStage(stageId: number | null): stageId is number {
  return stageId !== null && Number.isInteger(stageId) && stageId > 0;
}

/** `path` plus `?search` when the search is non-empty. */
function withSearch(path: string, search: URLSearchParams): string {
  const query = search.toString();
  return query === '' ? path : `${path}?${query}`;
}

/** The matchup destination: both character axes plus the stage axis when there is one. */
function matchupPath(target: ActionTarget): string | null {
  if (target.myFighterId === null && target.opponentFighterId === null) {
    return null;
  }
  return withSearch(
    MATCHUPS_PATH,
    buildDrillDownSearch({
      fighterId: target.myFighterId ?? undefined,
      vsFighterId: target.opponentFighterId ?? undefined,
      stageId: isAddressableStage(target.stageId) ? target.stageId : undefined,
    }),
  );
}

/** The stage destination, narrowed to the character axes the claim carries. */
function stagePath(target: ActionTarget): string | null {
  if (!isAddressableStage(target.stageId)) {
    return null;
  }
  return withSearch(
    `${STAGE_PATH_PREFIX}${target.stageId}`,
    buildDrillDownSearch({
      fighterId: target.myFighterId ?? undefined,
      vsFighterId: target.opponentFighterId ?? undefined,
    }),
  );
}

/**
 * The VOD destination: one match when the engine resolved exactly one,
 * otherwise the filtered game list — the opponent hub (which hosts the
 * `FilteredMatchList` terminus) when the claim names an opponent, else the
 * matchup page's list for the character axes.
 */
function vodPath(target: ActionTarget): string | null {
  if (target.matchId !== null && target.matchId !== '') {
    const search = new URLSearchParams();
    search.set(VOD_MATCH_PARAM, target.matchId);
    return withSearch(VOD_PATH, search);
  }
  const axes = buildDrillDownSearch({
    fighterId: target.myFighterId ?? undefined,
    vsFighterId: target.opponentFighterId ?? undefined,
    stageId: isAddressableStage(target.stageId) ? target.stageId : undefined,
  });
  if (target.opponentTag !== null && target.opponentTag !== '') {
    return withSearch(buildOpponentHubPath(target.opponentTag), axes);
  }
  return matchupPath(target);
}

/** The personal path of an action's evidence, or `null` when its axes name nothing. */
export function personalPathForActionTarget(target: ActionTarget): string | null {
  switch (target.kind) {
    case 'matchup':
      return (
        matchupPath(target) ??
        (target.opponentTag ? buildOpponentHubPath(target.opponentTag) : null)
      );
    case 'stage':
      return stagePath(target);
    case 'vod':
      return vodPath(target);
  }
}

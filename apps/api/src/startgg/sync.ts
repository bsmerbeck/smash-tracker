import type { Database } from 'firebase-admin/database';
import type { MatchRecord, StartggSyncSummary } from '@smash-tracker/shared';
import { fetchPlayerSetsPage, SSBU_VIDEOGAME_ID, type StartggSet } from './client.js';
import { startggCharacterToFighterId } from './characterMap.js';
import { resolveStageByName } from './stageMap.js';

/** Hard cap on pages per sync — 40 pages x 10 sets stays well inside the 80 req/60s rate limit. */
const MAX_PAGES = 40;

// eslint-disable-next-line no-control-regex -- control chars are exactly what RTDB keys forbid
const RTDB_ILLEGAL = /[.#$[\]/\u0000-\u001f]/g;

/**
 * Entrant names arrive as "Sponsor | GamerTag"; matches store the lowercased
 * tag alone (matching manual entry, where legacy always lowercased). The
 * result is also used as an RTDB key under opponents/{uid}/, so reserved
 * characters are stripped.
 */
export function normalizeOpponentTag(name: string | null | undefined): string {
  if (!name) {
    return 'unknown';
  }
  const tag = name.includes('|') ? (name.split('|').pop() ?? name) : name;
  const cleaned = tag.trim().toLowerCase().replace(RTDB_ILLEGAL, '');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

interface ImportableGame {
  key: string;
  record: MatchRecord;
  opponentTag: string;
}

/**
 * Transforms one start.gg set into importable match records (one per game
 * with full detail), mutating the summary counters for everything skipped.
 * Exported for tests.
 */
export function gamesFromSet(
  set: StartggSet,
  playerId: number,
  summary: StartggSyncSummary,
): ImportableGame[] {
  if (set.event?.videogame?.id !== SSBU_VIDEOGAME_ID) {
    return [];
  }
  summary.sets += 1;

  const games = set.games ?? [];
  const completedAt = set.completedAt;
  const slots = (set.slots ?? []).flatMap((slot) => (slot?.entrant ? [slot.entrant] : []));
  const userEntrant = slots.find((entrant) =>
    (entrant.participants ?? []).some((p) => p?.player?.id === playerId),
  );
  const opponentEntrant = slots.find((entrant) => entrant.id !== userEntrant?.id);

  if (games.length === 0 || completedAt == null || !userEntrant || !opponentEntrant) {
    summary.setsWithoutGames += 1;
    return [];
  }

  const opponentTag = normalizeOpponentTag(opponentEntrant.name);
  const matchType = set.event?.isOnline ? 'online-tourney' : 'offline-tourney';
  // RTDB rejects undefined values — these keys must be OMITTED when absent.
  const eventName = set.event?.name?.trim();
  const tournamentName = set.event?.tournament?.name?.trim();
  const results: ImportableGame[] = [];

  games.forEach((game, index) => {
    const selections = game.selections ?? [];
    const userSelection = selections.find((s) => s.entrant?.id === userEntrant.id);
    const opponentSelection = selections.find((s) => s.entrant?.id === opponentEntrant.id);

    if (
      game.winnerId == null ||
      userSelection?.character?.id == null ||
      opponentSelection?.character?.id == null
    ) {
      summary.gamesMissingSelections += 1;
      return;
    }

    const fighterId = startggCharacterToFighterId.get(userSelection.character.id);
    const opponentFighterId = startggCharacterToFighterId.get(opponentSelection.character.id);
    if (fighterId === undefined || opponentFighterId === undefined) {
      summary.gamesUnmappedCharacter += 1;
      return;
    }

    const resolvedStage = game.stage?.name ? resolveStageByName(game.stage.name) : null;
    if (!resolvedStage) {
      summary.gamesUnknownStage += 1;
    }

    const externalId = `sgg:${set.id}:g${index + 1}`;
    results.push({
      key: `sgg-${set.id}-g${index + 1}`,
      opponentTag,
      record: {
        fighter_id: fighterId,
        opponent_id: opponentFighterId,
        time: completedAt * 1000,
        map: resolvedStage
          ? { id: resolvedStage.id, name: resolvedStage.name }
          : { id: 0, name: 'unknown' },
        opponent: opponentTag,
        notes: '',
        matchType,
        win: game.winnerId === userEntrant.id,
        source: 'startgg',
        externalId,
        ...(eventName ? { eventName } : {}),
        ...(tournamentName ? { tournamentName } : {}),
      },
    });
  });

  return results;
}

/**
 * Imports all of a player's SSBU tournament games as matches under
 * matches/{uid}. Idempotent: records use stable child keys derived from the
 * set id + game number, so re-syncs overwrite in place. Manual matches
 * (push-keyed) are never touched. Opponent tags are added to
 * opponents/{uid} exactly like manual entry does.
 */
export async function importPlayerMatches(
  database: Database,
  uid: string,
  playerId: number,
  serverToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StartggSyncSummary> {
  const summary: StartggSyncSummary = {
    sets: 0,
    imported: 0,
    setsWithoutGames: 0,
    gamesUnmappedCharacter: 0,
    gamesMissingSelections: 0,
    gamesUnknownStage: 0,
  };

  const matchUpdates: Record<string, MatchRecord> = {};
  const opponentUpdates: Record<string, true> = {};

  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= MAX_PAGES) {
    const result = await fetchPlayerSetsPage(serverToken, playerId, page, 10, fetchImpl);
    totalPages = result.totalPages;
    for (const set of result.sets) {
      for (const game of gamesFromSet(set, playerId, summary)) {
        // `imported` counts unique keys: pagination can return overlapping
        // sets across pages (e.g. a set moving in the bracket between
        // requests), so only count a game the first time its stable key is
        // seen, not once per page it happens to appear on.
        if (!(game.key in matchUpdates)) {
          summary.imported += 1;
        }
        matchUpdates[game.key] = game.record;
        opponentUpdates[game.opponentTag] = true;
      }
    }
    page += 1;
  }

  if (Object.keys(matchUpdates).length > 0) {
    await database.ref(`matches/${uid}`).update(matchUpdates);
    await database.ref(`opponents/${uid}`).update(opponentUpdates);
  }
  await database.ref(`startggLinks/${uid}/lastSyncAt`).set(Date.now());

  return summary;
}

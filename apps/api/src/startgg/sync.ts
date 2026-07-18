import type { Database } from 'firebase-admin/database';
import type { MatchRecord, StartggSyncSummary, TournamentEntry } from '@smash-tracker/shared';
import {
  fetchEventDetails,
  fetchPlayerSetsPage,
  SSBU_VIDEOGAME_ID,
  type StartggSet,
} from './client.js';
import { startggCharacterToFighterId } from './characterMap.js';
import { resolveStage } from './stageMap.js';

/** Hard cap on pages per sync — 40 pages x 10 sets stays well inside the 80 req/60s rate limit. */
const MAX_PAGES = 40;

/**
 * Hard cap on per-event detail fetches (slug + standings) per sync. Combined
 * with `MAX_PAGES` sets pages, worst case is 40 + 20 = 60 requests — still
 * comfortably under the 80 req/60s start.gg rate limit.
 */
const MAX_EVENT_DETAIL_FETCHES = 20;

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

  // DQ sets carry no meaningful game data — skip entirely, before the
  // games/completedAt checks below, and don't count them as setsWithoutGames.
  if (set.displayScore === 'DQ') {
    summary.dqSets += 1;
    return [];
  }

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
  const roundText = set.fullRoundText?.trim();
  const bracketRound = typeof set.round === 'number' ? set.round : undefined;
  // `Set.vodUrl` is TO-curated and near-always null in practice (see the
  // V6-W1b probe notes on client.ts's `vodUrl` schema field), but when
  // present it applies to every game of the set.
  const vodUrl = set.vodUrl ?? undefined;
  // Per-event facts about the human opponent, duplicated per game by design
  // (RTDB read simplicity beats normalization here).
  const opponentSeed = opponentEntrant.seeds?.find((s) => typeof s?.seedNum === 'number')?.seedNum;
  const opponentPlacement = opponentEntrant.standing?.placement ?? undefined;
  const opponentUserSlug = (opponentEntrant.participants ?? []).find((p) => p?.user?.slug != null)
    ?.user?.slug;
  // `game.entrant1Score`/`entrant2Score` correspond positionally to
  // `slots[0]`/`slots[1]` (verified during the V6-W1b probe against live
  // start.gg data — never by entrant id, which the API doesn't expose per
  // score). `slots` here is the same entrant-only, order-preserving array
  // used to find userEntrant/opponentEntrant above.
  const userSlotIndex = slots.findIndex((entrant) => entrant.id === userEntrant.id);
  const opponentSlotIndex = slots.findIndex((entrant) => entrant.id === opponentEntrant.id);
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

    // Numeric start.gg stage id first (stable/global — see stageMap.ts),
    // falling back to name resolution when the id isn't in the curated
    // table (or is absent) — same "unknown sentinel" outcome either way.
    const rawStageId = game.stage?.id;
    const stageId =
      typeof rawStageId === 'number'
        ? rawStageId
        : typeof rawStageId === 'string'
          ? Number(rawStageId)
          : null;
    const resolvedStage = resolveStage(
      stageId != null && Number.isFinite(stageId) ? stageId : null,
      game.stage?.name,
    );
    if (!resolvedStage) {
      summary.gamesUnknownStage += 1;
    }

    // Winner's remaining-stock count for this individual game (start.gg:
    // "Score of entrant 1/2 ... equivalent to stocks remaining" — see
    // client.ts). Read from whichever slot the winner occupies, never via
    // max(), since one side can be null while the other is a meaningless 0
    // (see sync.test.ts for the exact case this guards against). Clamped to
    // matchRecordSchema's 0-3 range (standard 4-stock games only — every
    // sampled value during the V6-W1b probe fell in this range, but a
    // non-standard stock count ruleset could in principle report higher).
    const winnerScore =
      game.winnerId === userEntrant.id
        ? userSlotIndex === 0
          ? game.entrant1Score
          : game.entrant2Score
        : game.winnerId === opponentEntrant.id
          ? opponentSlotIndex === 0
            ? game.entrant1Score
            : game.entrant2Score
          : null;
    const stocksLeft =
      typeof winnerScore === 'number' && winnerScore >= 0 && winnerScore <= 3
        ? winnerScore
        : undefined;

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
        ...(roundText ? { roundText } : {}),
        ...(bracketRound !== undefined ? { bracketRound } : {}),
        ...(opponentSeed != null ? { opponentSeed } : {}),
        ...(opponentPlacement != null ? { opponentPlacement } : {}),
        ...(opponentUserSlug ? { opponentUserSlug } : {}),
        ...(stocksLeft !== undefined ? { stocksLeft } : {}),
        ...(vodUrl ? { vodUrl } : {}),
      },
    });
  });

  return results;
}

/**
 * Mutable accumulator for one event's tournament registry entry while
 * paginating; converted to a `TournamentEntry` (with optional fields
 * omitted, per the RTDB undefined rule) once accumulation is complete.
 */
interface RegistryAccumulator {
  eventId: number;
  eventName: string;
  tournamentName?: string;
  numEntrants?: number;
  seed?: number;
  placement?: number;
  firstSetAt: number;
  lastSetAt: number;
  setsPlayed: number;
}

/**
 * Folds one non-DQ SSBU set into the per-event registry accumulator map.
 * Exported for tests. A set only contributes when it belongs to a
 * recognizable event (`event.id` present) — sets without an event id can't
 * be grouped into a tournament entry.
 */
export function accumulateRegistry(
  accumulators: Map<number, RegistryAccumulator>,
  set: StartggSet,
  playerId: number,
): void {
  if (set.event?.videogame?.id !== SSBU_VIDEOGAME_ID || set.displayScore === 'DQ') {
    return;
  }
  const eventId = set.event?.id;
  const eventName = set.event?.name?.trim();
  if (eventId == null || !eventName) {
    return;
  }

  const slots = (set.slots ?? []).flatMap((slot) => (slot?.entrant ? [slot.entrant] : []));
  const userEntrant = slots.find((entrant) =>
    (entrant.participants ?? []).some((p) => p?.player?.id === playerId),
  );
  const seed = userEntrant?.seeds?.find((s) => typeof s?.seedNum === 'number')?.seedNum;
  const placement = userEntrant?.standing?.placement;
  const tournamentName = set.event?.tournament?.name?.trim();
  const numEntrants = set.event?.numEntrants;
  const completedAt = set.completedAt != null ? set.completedAt * 1000 : undefined;

  const existing = accumulators.get(eventId);
  if (!existing) {
    accumulators.set(eventId, {
      eventId,
      eventName,
      ...(tournamentName ? { tournamentName } : {}),
      ...(numEntrants != null ? { numEntrants } : {}),
      ...(seed != null ? { seed } : {}),
      ...(placement != null ? { placement } : {}),
      firstSetAt: completedAt ?? 0,
      lastSetAt: completedAt ?? 0,
      setsPlayed: 1,
    });
    return;
  }

  existing.setsPlayed += 1;
  if (tournamentName) {
    existing.tournamentName = tournamentName;
  }
  if (numEntrants != null) {
    existing.numEntrants = numEntrants;
  }
  if (seed != null) {
    existing.seed = seed;
  }
  if (placement != null) {
    existing.placement = placement;
  }
  if (completedAt != null) {
    existing.firstSetAt =
      existing.firstSetAt === 0 ? completedAt : Math.min(existing.firstSetAt, completedAt);
    existing.lastSetAt = Math.max(existing.lastSetAt, completedAt);
  }
}

/**
 * Imports all of a player's SSBU tournament games as matches under
 * matches/{uid}. Idempotent: records use stable child keys derived from the
 * set id + game number, so re-syncs overwrite in place. Manual matches
 * (push-keyed) are never touched. Opponent tags are added to
 * opponents/{uid} exactly like manual entry does. Also accumulates a
 * per-event tournament registry under tournamentEntries/{uid}, keyed by
 * event id, idempotent the same way (re-syncs overwrite in place).
 *
 * After pagination, the most-recently-active events (capped at
 * `MAX_EVENT_DETAIL_FETCHES`) are enriched with their start.gg slug and top
 * standings via one `fetchEventDetails` call each. Enrichment failures are
 * logged (via the optional `logger`) and skipped per-event — they never
 * fail the sync as a whole.
 */
export async function importPlayerMatches(
  database: Database,
  uid: string,
  playerId: number,
  serverToken: string,
  fetchImpl: typeof fetch = fetch,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): Promise<StartggSyncSummary> {
  const summary: StartggSyncSummary = {
    sets: 0,
    imported: 0,
    setsWithoutGames: 0,
    gamesUnmappedCharacter: 0,
    gamesMissingSelections: 0,
    gamesUnknownStage: 0,
    dqSets: 0,
  };

  const matchUpdates: Record<string, MatchRecord> = {};
  const opponentUpdates: Record<string, true> = {};
  const registry = new Map<number, RegistryAccumulator>();

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
      accumulateRegistry(registry, set, playerId);
    }
    page += 1;
  }

  if (Object.keys(matchUpdates).length > 0) {
    await database.ref(`matches/${uid}`).update(matchUpdates);
    await database.ref(`opponents/${uid}`).update(opponentUpdates);
  }
  if (registry.size > 0) {
    // Walkthrough amendment (07-10): read the CURRENT registry first so
    // previously-fetched enrichment fields (slug/eventSlug/topStandings) can
    // be carried forward as a baseline below. Every sync re-derives
    // registryUpdates from scratch off THIS run's own paginated sets (not an
    // incremental diff), and the closing `.update()` REPLACES each event's
    // whole node — without this read-and-merge step, an event that drops out
    // of this run's `MAX_EVENT_DETAIL_FETCHES` most-recently-active window
    // (or whose `fetchEventDetails` call transiently fails) would have its
    // ALREADY-FETCHED slug/eventSlug/topStandings silently wiped by this
    // sync, permanently breaking a recap's "View bracket on start.gg" link
    // for that tournament until it happens to re-enter the top N and
    // re-fetch successfully again.
    const existingRegistrySnapshot = await database.ref(`tournamentEntries/${uid}`).get();
    const existingRegistry = (existingRegistrySnapshot.val() ?? {}) as Record<
      string,
      TournamentEntry | undefined
    >;

    const registryUpdates: Record<string, TournamentEntry> = {};
    for (const [eventId, acc] of registry) {
      const existingEntry = existingRegistry[String(eventId)];
      registryUpdates[String(eventId)] = {
        eventId: acc.eventId,
        eventName: acc.eventName,
        ...(acc.tournamentName ? { tournamentName: acc.tournamentName } : {}),
        ...(acc.numEntrants != null ? { numEntrants: acc.numEntrants } : {}),
        ...(acc.seed != null ? { seed: acc.seed } : {}),
        ...(acc.placement != null ? { placement: acc.placement } : {}),
        firstSetAt: acc.firstSetAt,
        lastSetAt: acc.lastSetAt,
        setsPlayed: acc.setsPlayed,
        // Baseline carried forward from the existing stored entry — the
        // enrichment loop below overwrites these with fresh values for any
        // event it successfully re-fetches this sync.
        ...(existingEntry?.slug ? { slug: existingEntry.slug } : {}),
        ...(existingEntry?.eventSlug ? { eventSlug: existingEntry.eventSlug } : {}),
        ...(existingEntry?.topStandings && existingEntry.topStandings.length > 0
          ? { topStandings: existingEntry.topStandings }
          : {}),
      };
    }

    // Enrich with slug/standings, most-recently-active events first, capped
    // at MAX_EVENT_DETAIL_FETCHES to respect the rate limit. A per-event
    // fetch/parse failure is logged and skipped — it must never fail the
    // whole sync, since the registry write above already succeeded.
    const eventIdsByRecency = [...registry.values()]
      .sort((a, b) => b.lastSetAt - a.lastSetAt)
      .slice(0, MAX_EVENT_DETAIL_FETCHES)
      .map((acc) => acc.eventId);

    for (const eventId of eventIdsByRecency) {
      try {
        const details = await fetchEventDetails(serverToken, eventId, fetchImpl);
        const entry = registryUpdates[String(eventId)];
        if (!entry) {
          continue;
        }
        registryUpdates[String(eventId)] = {
          ...entry,
          ...(details.slug ? { eventSlug: details.slug } : {}),
          ...(details.tournamentSlug ? { slug: details.tournamentSlug } : {}),
          ...(details.topStandings.length > 0 ? { topStandings: details.topStandings } : {}),
        };
      } catch (err) {
        logger?.warn(
          { err, eventId },
          'start.gg event detail enrichment failed; skipping for this event',
        );
      }
    }

    await database.ref(`tournamentEntries/${uid}`).update(registryUpdates);
  }
  await database.ref(`startggLinks/${uid}/lastSyncAt`).set(Date.now());

  return summary;
}

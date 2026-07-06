import type { ScoutGame, ScoutReportData } from '@smash-tracker/shared';
import {
  fetchPlayerSetsPage,
  resolvePlayerById,
  resolvePlayerBySlug,
  SSBU_VIDEOGAME_ID,
  type StartggSet,
} from './client.js';
import { startggCharacterToFighterId } from './characterMap.js';
import { resolveStage } from './stageMap.js';

/**
 * Hard cap on pages sampled per scout, perPage 10 -> 150 sets worst case.
 * Comfortably inside the 80 req/60s rate limit even for a cache miss, and
 * plenty of signal for "who am I about to play" scouting (recency-ordered by
 * start.gg's default sort, so the sample skews toward their current form).
 */
const MAX_SCOUT_PAGES = 15;

const MAX_RECENT_EVENTS = 10;
const MAX_COMMON_OPPONENTS = 10;

/** Unmapped-character sentinel, matching the sync pipeline's convention. */
const UNMAPPED_FIGHTER_ID = 0;
/** Unknown-stage sentinel, matching match records' `map.id === 0` convention. */
const UNKNOWN_STAGE_ID = 0;

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export type ScoutInput = { kind: 'slug'; slug: string } | { kind: 'playerId'; playerId: number };

/** Thrown for input that isn't a recognizable start.gg profile reference. */
export class ScoutInputError extends Error {}

function parseUrl(value: string): URL | null {
  try {
    return new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}

/**
 * Parses a scouting query into either a start.gg profile slug or a bare
 * numeric player id. Accepts:
 * - A full profile URL: "https://start.gg/user/07dc2239" (with or without
 *   protocol, trailing slash, or query/hash).
 * - A bare slug: "user/07dc2239".
 * - A bare numeric id: "1802316" (start.gg player id, not a user id).
 */
export function parseScoutInput(rawQuery: string): ScoutInput {
  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) {
    throw new ScoutInputError('query must not be empty');
  }

  // Bare numeric id, e.g. "1802316".
  if (/^\d+$/.test(trimmed)) {
    return { kind: 'playerId', playerId: Number(trimmed) };
  }

  // Bare slug, e.g. "user/07dc2239".
  const bareSlugMatch = /^user\/[^/\s]+$/i.exec(trimmed);
  if (bareSlugMatch) {
    return { kind: 'slug', slug: trimmed };
  }

  // Full URL, e.g. "https://start.gg/user/07dc2239" or "start.gg/user/07dc2239/...".
  const url = parseUrl(trimmed);
  if (url) {
    const pathMatch = /^\/?(user\/[^/]+)/i.exec(url.pathname);
    if (pathMatch?.[1]) {
      return { kind: 'slug', slug: pathMatch[1] };
    }
  }

  throw new ScoutInputError(
    'query must be a start.gg profile URL, a "user/<slug>" reference, or a numeric player id',
  );
}

// ---------------------------------------------------------------------------
// Resolution (with a shared in-memory cache — see ScoutCache below)
// ---------------------------------------------------------------------------

export interface ResolvedScoutPlayer {
  id: number;
  gamerTag: string;
  userSlug?: string;
}

/** Resolves a parsed `ScoutInput` to a player identity, or null if start.gg can't find one. */
export async function resolveScoutPlayer(
  serverToken: string,
  input: ScoutInput,
  fetchImpl: typeof fetch,
): Promise<ResolvedScoutPlayer | null> {
  if (input.kind === 'slug') {
    return resolvePlayerBySlug(serverToken, input.slug, fetchImpl);
  }
  return resolvePlayerById(serverToken, input.playerId, fetchImpl);
}

// ---------------------------------------------------------------------------
// Aggregation (server-side, from the scouted player's own perspective)
// ---------------------------------------------------------------------------

interface Accumulators {
  sampledSets: number;
  sampledGames: number;
  characters: Map<number, { games: number; wins: number }>;
  stages: Map<number, { games: number; wins: number }>;
  /** eventId -> accumulated recent-event facts, folded to the report shape after pagination. */
  events: Map<
    number,
    {
      eventName: string;
      tournamentName?: string;
      placement?: number;
      numEntrants?: number;
      lastSetAt: number;
      /** start.gg event slug, e.g. "tournament/the-big-house-9/event/ultimate-singles" — used to deep-link (V9-B Feature 2). */
      slug?: string;
    }
  >;
  opponents: Map<string, number>;
  /** V9-D: per-game records for the web "Full analysis" section — see `scoutGameSchema`. */
  games: ScoutGame[];
}

function emptyAccumulators(): Accumulators {
  return {
    sampledSets: 0,
    sampledGames: 0,
    characters: new Map(),
    stages: new Map(),
    events: new Map(),
    opponents: new Map(),
    games: [],
  };
}

function bump(map: Map<number, { games: number; wins: number }>, key: number, won: boolean): void {
  const existing = map.get(key);
  if (existing) {
    existing.games += 1;
    if (won) {
      existing.wins += 1;
    }
  } else {
    map.set(key, { games: 1, wins: won ? 1 : 0 });
  }
}

/**
 * Folds one SSBU, non-DQ set into the accumulators, entirely from the
 * scouted player's perspective (`playerId` identifies THEM, not the caller).
 * Mirrors `sync.ts`'s `gamesFromSet`/`accumulateRegistry` shape-handling
 * (nullish-tolerant slots/games/selections) but aggregates in memory instead
 * of writing match records.
 */
export function accumulateScoutSet(acc: Accumulators, set: StartggSet, playerId: number): void {
  if (set.event?.videogame?.id !== SSBU_VIDEOGAME_ID || set.displayScore === 'DQ') {
    return;
  }

  const games = set.games ?? [];
  const completedAt = set.completedAt;
  const slots = (set.slots ?? []).flatMap((slot) => (slot?.entrant ? [slot.entrant] : []));
  const playerEntrant = slots.find((entrant) =>
    (entrant.participants ?? []).some((p) => p?.player?.id === playerId),
  );
  const opponentEntrant = slots.find((entrant) => entrant.id !== playerEntrant?.id);

  if (games.length === 0 || completedAt == null || !playerEntrant) {
    return;
  }

  acc.sampledSets += 1;

  // Common opponents: one tally per set (not per game), keyed the same way
  // sync.ts derives opponent tags, so scouting stays consistent with how the
  // rest of the app names people.
  const opponentName = opponentEntrant?.name?.trim();
  const opponentTag = opponentName
    ? opponentName.includes('|')
      ? (opponentName.split('|').pop() ?? opponentName).trim()
      : opponentName
    : undefined;
  if (opponentTag) {
    acc.opponents.set(opponentTag, (acc.opponents.get(opponentTag) ?? 0) + 1);
  }

  // Recent events: keep the freshest facts per event id (numEntrants/placement
  // can differ across sampled sets from the same event, e.g. placement only
  // resolves once the bracket concludes — last-write-wins, most-recent set
  // wins since sets iterate in the order start.gg returns them).
  const eventId = set.event?.id;
  const eventName = set.event?.name?.trim();
  if (eventId != null && eventName) {
    const tournamentName = set.event?.tournament?.name?.trim();
    const placement = playerEntrant.standing?.placement ?? undefined;
    const numEntrants = set.event?.numEntrants ?? undefined;
    const slug = set.event?.slug?.trim() || undefined;
    const lastSetAtMs = completedAt * 1000;
    const existing = acc.events.get(eventId);
    if (!existing || lastSetAtMs > existing.lastSetAt) {
      acc.events.set(eventId, {
        eventName,
        ...(tournamentName ? { tournamentName } : {}),
        ...(placement != null ? { placement } : {}),
        ...(numEntrants != null ? { numEntrants } : {}),
        ...(slug ? { slug } : {}),
        lastSetAt: lastSetAtMs,
      });
    } else {
      // Still merge in any newly-available fact (e.g. final placement)
      // without regressing lastSetAt.
      if (placement != null) {
        existing.placement = placement;
      }
      if (numEntrants != null) {
        existing.numEntrants = numEntrants;
      }
      if (tournamentName) {
        existing.tournamentName = tournamentName;
      }
      if (slug) {
        existing.slug = slug;
      }
    }
  }

  games.forEach((game) => {
    const selections = game.selections ?? [];
    const playerSelection = selections.find((s) => s.entrant?.id === playerEntrant.id);
    const opponentSelection = opponentEntrant
      ? selections.find((s) => s.entrant?.id === opponentEntrant.id)
      : undefined;
    const won = game.winnerId === playerEntrant.id;

    acc.sampledGames += 1;

    const characterId = playerSelection?.character?.id;
    const fighterId =
      characterId != null
        ? (startggCharacterToFighterId.get(characterId) ?? UNMAPPED_FIGHTER_ID)
        : UNMAPPED_FIGHTER_ID;
    bump(acc.characters, fighterId, won);

    const rawStageId = game.stage?.id;
    const stageIdCandidate =
      typeof rawStageId === 'number'
        ? rawStageId
        : typeof rawStageId === 'string'
          ? Number(rawStageId)
          : null;
    const resolvedStage = resolveStage(
      stageIdCandidate != null && Number.isFinite(stageIdCandidate) ? stageIdCandidate : null,
      game.stage?.name,
    );
    bump(acc.stages, resolvedStage?.id ?? UNKNOWN_STAGE_ID, won);

    // V9-D: per-game record for the web "Full analysis" section. Games whose
    // OWN character can't be mapped are skipped entirely (mirroring the
    // per-character usage-aggregation rule above, but as an omission rather
    // than a fighterId-0 row — see scoutGameSchema's doc) — an unmapped-
    // character game has nothing meaningful to attribute a per-character
    // stat to on the client. The opponent's character, by contrast, still
    // uses the fighterId-0 sentinel (matching `characters` above) since it
    // isn't the subject of the scouted player's own stats.
    if (opponentTag && fighterId !== UNMAPPED_FIGHTER_ID) {
      const opponentCharacterId = opponentSelection?.character?.id;
      const opponentFighterId =
        opponentCharacterId != null
          ? (startggCharacterToFighterId.get(opponentCharacterId) ?? UNMAPPED_FIGHTER_ID)
          : UNMAPPED_FIGHTER_ID;
      acc.games.push({
        time: completedAt * 1000,
        win: won,
        fighterId,
        opponentFighterId,
        ...(resolvedStage ? { stageId: resolvedStage.id, stageName: resolvedStage.name } : {}),
        opponentTag,
        ...(eventName ? { eventName } : {}),
      });
    }
  });
}

function toReport(acc: Accumulators, player: ResolvedScoutPlayer): ScoutReportData {
  const characters = [...acc.characters.entries()]
    .map(([fighterId, { games, wins }]) => ({ fighterId, games, wins }))
    .sort((a, b) => b.games - a.games);

  const stages = [...acc.stages.entries()]
    .map(([stageId, { games, wins }]) => ({ stageId, games, wins }))
    .sort((a, b) => b.games - a.games);

  const recentEvents = [...acc.events.values()]
    .sort((a, b) => b.lastSetAt - a.lastSetAt)
    .slice(0, MAX_RECENT_EVENTS)
    .map((event) => ({
      eventName: event.eventName,
      ...(event.tournamentName ? { tournamentName: event.tournamentName } : {}),
      ...(event.placement != null ? { placement: event.placement } : {}),
      ...(event.numEntrants != null ? { numEntrants: event.numEntrants } : {}),
      ...(event.slug ? { slug: event.slug, source: 'startgg' as const } : {}),
      lastSetAt: event.lastSetAt,
    }));

  const commonOpponents = [...acc.opponents.entries()]
    .map(([gamerTag, sets]) => ({ gamerTag, sets }))
    .sort((a, b) => b.sets - a.sets)
    .slice(0, MAX_COMMON_OPPONENTS);

  return {
    player: {
      id: player.id,
      gamerTag: player.gamerTag,
      ...(player.userSlug ? { userSlug: player.userSlug } : {}),
    },
    sampledSets: acc.sampledSets,
    sampledGames: acc.sampledGames,
    characters,
    stages,
    recentEvents,
    commonOpponents,
    ...(acc.games.length > 0 ? { games: acc.games } : {}),
  };
}

/**
 * Fetches and aggregates a player's public SSBU set history into a
 * `ScoutReportData`, capped at `MAX_SCOUT_PAGES` pages (perPage 10 -> up to
 * 150 sets). Exported for tests; `scoutPlayer` below wraps this with the
 * cache.
 */
export async function buildScoutReport(
  serverToken: string,
  player: ResolvedScoutPlayer,
  fetchImpl: typeof fetch,
): Promise<ScoutReportData> {
  const acc = emptyAccumulators();

  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= MAX_SCOUT_PAGES) {
    const result = await fetchPlayerSetsPage(serverToken, player.id, page, 10, fetchImpl);
    totalPages = result.totalPages;
    for (const set of result.sets) {
      accumulateScoutSet(acc, set, player.id);
    }
    page += 1;
  }

  return toReport(acc, player);
}

// ---------------------------------------------------------------------------
// Caching — in-memory, per-instance
// ---------------------------------------------------------------------------

const CACHE_MAX_ENTRIES = 50;
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  report: ScoutReportData;
  expiresAt: number;
}

/**
 * Tiny in-memory LRU cache keyed by start.gg player id, so re-scouting the
 * same player during a bracket (a very likely workflow — "who do I have
 * next") doesn't re-burn the shared 80 req/60s rate limit on every request.
 *
 * Deliberately per-instance, not shared across API replicas: this app runs
 * on Cloud Run with scale-to-zero and typically a single warm instance under
 * normal load, so an in-memory `Map` is a pragmatic fit — worst case on a
 * cache miss (new instance, or evicted entry) is simply one full re-fetch,
 * never staleness beyond `CACHE_TTL_MS` or a wrong answer. A distributed
 * cache (Redis, RTDB) would be the next step if this ever runs with
 * sustained multi-instance concurrency.
 *
 * `Map` iteration order is insertion order, so "delete then re-set" on a hit
 * cheaply implements LRU recency without a separate linked list.
 */
export class ScoutCache {
  private readonly entries = new Map<number, CacheEntry>();

  constructor(
    private readonly maxEntries = CACHE_MAX_ENTRIES,
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(playerId: number): ScoutReportData | null {
    const entry = this.entries.get(playerId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(playerId);
      return null;
    }
    // Refresh recency: delete + re-insert moves this key to the end of
    // iteration order (most-recently-used).
    this.entries.delete(playerId);
    this.entries.set(playerId, entry);
    return entry.report;
  }

  set(playerId: number, report: ScoutReportData): void {
    this.entries.delete(playerId);
    this.entries.set(playerId, { report, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Resolves + aggregates a scout report for `input`, using `cache` to skip re-fetching. */
export async function scoutPlayer(
  serverToken: string,
  input: ScoutInput,
  fetchImpl: typeof fetch,
  cache: ScoutCache,
): Promise<ScoutReportData | null> {
  const player = await resolveScoutPlayer(serverToken, input, fetchImpl);
  if (!player) {
    return null;
  }

  const cached = cache.get(player.id);
  if (cached) {
    return cached;
  }

  const report = await buildScoutReport(serverToken, player, fetchImpl);
  cache.set(player.id, report);
  return report;
}

import { MatchState } from '@parry-gg/client';
import type { ScoutGame, ScoutReportData } from '@smash-tracker/shared';
import {
  getUser,
  getUserMatches,
  searchUsers,
  type ParryggClients,
  type ParryggMatchContext,
} from './client.js';
import {
  findSeeds,
  PARRYGG_SSBU_SLUG,
  PATH_TYPE_EVENT,
  PATH_TYPE_TOURNAMENT,
  pathNameByType,
  pathSlugByType,
  type Seed,
} from './sync.js';
import { parryggCharacterSlugToFighterId } from './characters.js';
import { resolveParryggStage } from './stages.js';

/**
 * V9-B Feature 4: scout ANY parry.gg player, mirroring the shape/conventions
 * of ../startgg/scout.ts closely enough that both feed the exact same
 * `ScoutReportData` shape — everything downstream (the Scout page, the AI
 * report payload assembly) is source-agnostic once it has a `ScoutReportData`.
 *
 * Key structural difference from start.gg: there is no separate "sets"
 * concept to paginate — `getUserMatches` returns the user's full match
 * history in one gRPC call (parry.gg is young; nobody has thousands of
 * matches yet), so there's no page cap to enforce here the way start.gg's
 * `MAX_SCOUT_PAGES` exists for its per-page GraphQL query.
 */

const MAX_RECENT_EVENTS = 10;
const MAX_COMMON_OPPONENTS = 10;
const UNMAPPED_FIGHTER_ID = 0;
const UNKNOWN_STAGE_ID = 0;

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function parseUrl(value: string): URL | null {
  try {
    return new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}

/**
 * A UUID v7 (parry.gg's user id format — verified live against the API, see
 * ../parrygg/client.ts and the V8-A/V8-B PR notes). Version nibble '7',
 * variant nibble one of 8/9/a/b per RFC 9562.
 */
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Parses a parry.gg profile URL into a bare user id, or null when `rawQuery`
 * doesn't look like one. Verified profile URL shape (WebSearch + WebFetch
 * against live parry.gg profile pages, 2026-07-06):
 * `https://parry.gg/profile/{uuid-v7}` — no gamer tag ever appears in the
 * URL, only the UUID, e.g.
 * "https://parry.gg/profile/019ce9ba-debd-7e11-84a2-77258f52644e".
 *
 * Accepts the URL with or without protocol/trailing slash/query/hash, same
 * tolerance as start.gg's `parseScoutInput`. Returns null (not a throw) so
 * callers can fall through to bare-tag search — a parry.gg URL is a strong,
 * unambiguous signal, but anything else must not be assumed to be one.
 */
export function parseParryProfileUrl(rawQuery: string): string | null {
  const trimmed = rawQuery.trim();
  const url = parseUrl(trimmed);
  if (!url || !/(^|\.)parry\.gg$/i.test(url.hostname)) {
    return null;
  }
  const match = /^\/profile\/([0-9a-f-]+)\/?$/i.exec(url.pathname);
  const candidate = match?.[1];
  if (candidate && UUID_V7_PATTERN.test(candidate)) {
    return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedParryScoutPlayer {
  parryUserId: string;
  gamerTag: string;
}

/**
 * Resolves a parry.gg scouting query to a player identity:
 * - A parry.gg profile URL resolves directly via `getUser`.
 * - A bare user id (already a UUID v7) resolves directly via `getUser`.
 * - Anything else is treated as a gamer tag: `searchUsers` fuzzy-matches,
 *   and the best EXACT (case-insensitive) tag match wins; no exact match
 *   means "not found" (null) rather than guessing at a fuzzy result.
 */
export async function resolveParryScoutPlayer(
  apiKey: string,
  rawQuery: string,
  clients?: ParryggClients,
): Promise<ResolvedParryScoutPlayer | null> {
  const trimmed = rawQuery.trim();
  const profileUserId = parseParryProfileUrl(trimmed);
  const directUserId = profileUserId ?? (UUID_V7_PATTERN.test(trimmed) ? trimmed : null);

  if (directUserId) {
    const user = await getUser(apiKey, directUserId, clients);
    return user ? { parryUserId: user.id, gamerTag: user.gamerTag } : null;
  }

  const candidates = await searchUsers(apiKey, trimmed, 10, clients);
  const exact = candidates.find((c) => c.gamerTag.toLowerCase() === trimmed.toLowerCase());
  return exact ? { parryUserId: exact.id, gamerTag: exact.gamerTag } : null;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Accumulators {
  sampledSets: number;
  sampledGames: number;
  characters: Map<number, { games: number; wins: number }>;
  stages: Map<number, { games: number; wins: number }>;
  events: Map<
    string,
    {
      eventName: string;
      tournamentName?: string;
      placement?: number;
      slug?: string;
      lastSetAt: number;
    }
  >;
  opponents: Map<string, number>;
  /** V9-D: per-game records for the web "Full analysis" section — see `scoutGameSchema`. Only ever populated from real `matchGamesList` detail — see the doc on the `games.length === 0` branch below for why synthesized-from-score sets never contribute here. */
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
 * Folds one parry.gg MatchContext into the accumulators, from the scouted
 * player's own perspective. Mirrors `sync.ts`'s `gamesFromMatchContext`
 * filtering/shape-handling (completed-only, SSBU-only, singles-only,
 * sparse-data tolerance) but aggregates in memory instead of writing match
 * records — same relationship `startgg/scout.ts`'s `accumulateScoutSet` has
 * to `startgg/sync.ts`'s `gamesFromSet`. Exported for tests.
 */
export function accumulateParryMatchContext(
  acc: Accumulators,
  context: ParryggMatchContext,
  parryUserId: string,
): void {
  const match = context.match;
  if (!match) {
    return;
  }

  const slots = match.slotsList;
  const bothScoresZero = slots.length === 2 && slots.every((s) => s.score === 0);
  if (match.state !== MatchState.MATCH_STATE_COMPLETED || bothScoresZero) {
    return;
  }

  // SSBU filter: same "never assume" convention as sync.ts — no `game` at
  // all, or a `game` that isn't SSBU, both mean "skip".
  if (!context.game || context.game.slug !== PARRYGG_SSBU_SLUG) {
    return;
  }

  const seedResult = findSeeds(context.seedsList, parryUserId);
  if (seedResult === 'team' || !seedResult) {
    return;
  }
  const { mine, opponent } = seedResult;

  acc.sampledSets += 1;

  const opponentUser = opponent.eventEntrant?.entrant?.usersList[0];
  const opponentTag = opponentUser?.gamerTag?.trim() || opponent.eventEntrant?.name?.trim();
  if (opponentTag) {
    acc.opponents.set(opponentTag, (acc.opponents.get(opponentTag) ?? 0) + 1);
  }

  const paths = context.hierarchy?.pathsList ?? [];
  const eventName = pathNameByType(paths, PATH_TYPE_EVENT);
  const tournamentName = pathNameByType(paths, PATH_TYPE_TOURNAMENT);
  const tournamentSlug = pathSlugByType(paths, PATH_TYPE_TOURNAMENT);
  const eventSlugPart = pathSlugByType(paths, PATH_TYPE_EVENT);
  // parry.gg's public event URL is `{tournamentSlug}/{eventSlug}` (verified
  // live, 2026-07-06: a tournament page like "/my-tournament-01931d1c" links
  // its events at "/my-tournament-01931d1c/test", confirmed via the site's
  // own bracket/standings sub-pages) — both halves are required, so a slug
  // is only recorded when both path types are present.
  const slug = tournamentSlug && eventSlugPart ? `${tournamentSlug}/${eventSlugPart}` : undefined;

  // "Placement where meaningful" — Match.winnersPlacement/losersPlacement
  // are only nonzero on the match that actually decided a final bracket
  // placement (e.g. the true Grand Finals), not on every match a player
  // plays. Attribute whichever side's placement applies to ME.
  const placement = myWonMatch(match, mine)
    ? match.winnersPlacement || undefined
    : match.losersPlacement || undefined;

  const eventKey = eventName ? `${tournamentName ?? ''}::${eventName}` : undefined;
  if (eventKey) {
    const endedAtSeconds = match.endedAt?.seconds ?? match.stateUpdatedAt?.seconds;
    const lastSetAtMs =
      typeof endedAtSeconds === 'number'
        ? endedAtSeconds * 1000
        : (context.eventStartDate?.seconds ?? 0) * 1000;
    const existing = acc.events.get(eventKey);
    if (!existing || lastSetAtMs > existing.lastSetAt) {
      acc.events.set(eventKey, {
        eventName: eventName!,
        ...(tournamentName ? { tournamentName } : {}),
        ...(placement != null ? { placement } : {}),
        ...(slug ? { slug } : {}),
        lastSetAt: lastSetAtMs,
      });
    } else {
      if (placement != null) {
        existing.placement = placement;
      }
      if (slug) {
        existing.slug = slug;
      }
    }
  }

  const games = match.matchGamesList;
  // "mine" drives character/stage aggregation (the scout accumulator only
  // ever tracks the scouted player's OWN picks, their own perspective).
  // "opponent" is ALSO looked up (V9-D), same shared-slot-number matching
  // `sync.ts`'s `gamesFromMatchContext` uses, purely to populate each
  // per-game record's `opponentFighterId` for the client stats engine — it
  // does not otherwise change what this function aggregates.
  const mySlotEntry = slots.find((s) => s.seedId === mine.id);
  const opponentSlotEntry = slots.find((s) => s.seedId === opponent.id);

  if (games.length === 0) {
    // No per-game detail — same "sparse young data" tolerance as sync.ts:
    // still counted as a sampled set, but contributes no character/stage
    // rows (there is nothing to attribute a character pick to).
    return;
  }

  games.forEach((game) => {
    const myGameSlot =
      mySlotEntry != null ? game.slotsList.find((s) => s.slot === mySlotEntry.slot) : undefined;
    if (!myGameSlot) {
      return;
    }
    acc.sampledGames += 1;

    const myParticipant =
      myGameSlot.participantsList.find((p) => p.userId === parryUserId) ??
      myGameSlot.participantsList[0];
    const myCharacterSlug = myParticipant?.charactersList[0]?.slug;
    const fighterId = parryggCharacterSlugToFighterId(myCharacterSlug) ?? UNMAPPED_FIGHTER_ID;
    const won = (myGameSlot.placement ?? 0) === 1;
    bump(acc.characters, fighterId, won);

    const stageSlug = game.stagesList[0]?.slug;
    const resolvedStage = resolveParryggStage(stageSlug);
    bump(acc.stages, resolvedStage?.id ?? UNKNOWN_STAGE_ID, won);

    // V9-D: per-game record for the web "Full analysis" section. Skipped
    // entirely when MY character can't be mapped (mirrors start.gg scout's
    // rule — see scoutGameSchema's doc); the opponent's character falls back
    // to the fighterId-0 sentinel like `characters` above, since it isn't
    // the subject of the scouted player's own stats.
    if (opponentTag && fighterId !== UNMAPPED_FIGHTER_ID) {
      const opponentGameSlot =
        opponentSlotEntry != null
          ? game.slotsList.find((s) => s.slot === opponentSlotEntry.slot)
          : undefined;
      const opponentParticipant =
        opponentGameSlot?.participantsList.find((p) => p.userId === opponentUser?.id) ??
        opponentGameSlot?.participantsList[0];
      const opponentCharacterSlug = opponentParticipant?.charactersList[0]?.slug;
      const opponentFighterId =
        parryggCharacterSlugToFighterId(opponentCharacterSlug) ?? UNMAPPED_FIGHTER_ID;

      const endedAtSeconds = match.endedAt?.seconds ?? match.stateUpdatedAt?.seconds;
      const time =
        typeof endedAtSeconds === 'number'
          ? endedAtSeconds * 1000
          : (context.eventStartDate?.seconds ?? 0) * 1000;

      acc.games.push({
        time,
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

/** Whether the seed identified as "mine" won the overall match (by final slot score). */
function myWonMatch(match: NonNullable<ParryggMatchContext['match']>, mine: Seed): boolean {
  const mySlot = match.slotsList.find((s) => s.seedId === mine.id);
  const otherSlot = match.slotsList.find((s) => s.seedId !== mine.id);
  return (mySlot?.score ?? 0) > (otherSlot?.score ?? 0);
}

function toReport(acc: Accumulators, player: ResolvedParryScoutPlayer): ScoutReportData {
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
      // parry.gg events are deliberately left WITHOUT a rendered deep link
      // for now even though a slug is captured here — see the code comment
      // in ScoutRecentEventsCard.tsx for why (no verified parry.gg EVENT
      // page URL, only the profile URL). The slug/source are still recorded
      // so a future verification only needs a web-side change.
      ...(event.slug ? { slug: event.slug, source: 'parrygg' as const } : {}),
      lastSetAt: event.lastSetAt,
    }));

  const commonOpponents = [...acc.opponents.entries()]
    .map(([gamerTag, sets]) => ({ gamerTag, sets }))
    .sort((a, b) => b.sets - a.sets)
    .slice(0, MAX_COMMON_OPPONENTS);

  return {
    player: {
      source: 'parrygg',
      parryUserId: player.parryUserId,
      gamerTag: player.gamerTag,
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
 * Fetches and aggregates a parry.gg player's full completed-match history
 * into a `ScoutReportData`. Exported for tests; `scoutParryPlayer` below
 * wraps this with the cache.
 */
export async function buildParryScoutReport(
  apiKey: string,
  player: ResolvedParryScoutPlayer,
  clients?: ParryggClients,
): Promise<ScoutReportData> {
  const acc = emptyAccumulators();
  const contexts = await getUserMatches(apiKey, player.parryUserId, clients);
  for (const context of contexts) {
    accumulateParryMatchContext(acc, context, player.parryUserId);
  }
  return toReport(acc, player);
}

// ---------------------------------------------------------------------------
// Caching — own instance, source-prefixed keys not needed since this cache
// is entirely separate from the start.gg one (see startgg/scout.ts for the
// rationale on why an in-memory, per-instance cache is a pragmatic fit here).
// ---------------------------------------------------------------------------

const CACHE_MAX_ENTRIES = 50;
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  report: ScoutReportData;
  expiresAt: number;
}

export class ParryScoutCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly maxEntries = CACHE_MAX_ENTRIES,
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(parryUserId: string): ScoutReportData | null {
    const entry = this.entries.get(parryUserId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(parryUserId);
      return null;
    }
    this.entries.delete(parryUserId);
    this.entries.set(parryUserId, entry);
    return entry.report;
  }

  set(parryUserId: string, report: ScoutReportData): void {
    this.entries.delete(parryUserId);
    this.entries.set(parryUserId, { report, expiresAt: this.now() + this.ttlMs });
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

/** Resolves + aggregates a parry.gg scout report for `rawQuery`, using `cache` to skip re-fetching. */
export async function scoutParryPlayer(
  apiKey: string,
  rawQuery: string,
  cache: ParryScoutCache,
  clients?: ParryggClients,
): Promise<ScoutReportData | null> {
  const player = await resolveParryScoutPlayer(apiKey, rawQuery, clients);
  if (!player) {
    return null;
  }

  const cached = cache.get(player.parryUserId);
  if (cached) {
    return cached;
  }

  const report = await buildParryScoutReport(apiKey, player, clients);
  cache.set(player.parryUserId, report);
  return report;
}

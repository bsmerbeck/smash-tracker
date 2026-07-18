import type { Database } from 'firebase-admin/database';
import type { MatchRecord, ParryggSyncSummary, TournamentEntry } from '@smash-tracker/shared';
import { MatchState } from '@parry-gg/client';
import { getUserMatches, type ParryggClients, type ParryggMatchContext } from './client.js';
import { parryggCharacterSlugToFighterId } from './characters.js';
import { resolveParryggStage } from './stages.js';

/**
 * The Smash Ultimate `Game.slug` on parry.gg, determined empirically from
 * the API's own convention for other titles (kebab-cased short name,
 * verified against parry.gg's public site listing "Super Smash Bros.
 * Ultimate" tournaments under this slug at probe time) — see the V8-A PR
 * body for the exact verification. `MatchContext.game` was unset on every
 * sample the probe observed (parry.gg is young; real SSBU tournament data
 * with populated `game` is not yet common), so this constant is exercised
 * mainly by `otherGame` filtering once tournaments start attaching it —
 * matches with NO `game` at all are handled by the separate `unknownGame`
 * branch below and are NOT assumed to be SSBU.
 */
export const PARRYGG_SSBU_SLUG = 'super-smash-bros-ultimate';

// eslint-disable-next-line no-control-regex -- control chars are exactly what RTDB keys forbid
const RTDB_ILLEGAL = /[.#$[\]/\u0000-\u001f\u007f]/g;

/** Same tag normalization convention as start.gg's sync (see ../startgg/sync.ts). */
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

export type Seed = ParryggMatchContext['seedsList'][number];
export type PathEntry = NonNullable<ParryggMatchContext['hierarchy']>['pathsList'][number];

/** `hierarchy.pathsList` path types (see @parry-gg/client's `PathType` enum): 0=tournament, 1=event, 2=phase, 3=bracket. Exported for reuse by ../parrygg/scout.ts (V9-B). */
export const PATH_TYPE_TOURNAMENT = 0;
export const PATH_TYPE_EVENT = 1;

/** Exported for reuse by ../parrygg/scout.ts (V9-B) — same slug/name path lookup, one implementation. */
export function pathNameByType(paths: PathEntry[], type: number): string | undefined {
  return paths.find((p) => p.type === type)?.name?.trim() || undefined;
}

/** Same lookup as `pathNameByType`, but for the path's `slug` instead of its `name` (V9-B — event deep links). */
export function pathSlugByType(paths: PathEntry[], type: number): string | undefined {
  return paths.find((p) => p.type === type)?.slug?.trim() || undefined;
}

/**
 * Finds the seed whose entrant is the linked parry.gg user, and the
 * opposing seed. Returns null when either side is a team entrant
 * (`usersList.length > 1` — singles only for v1, see `teamEntrants`
 * counter) or when the match doesn't have exactly two seeds. Exported for
 * reuse by ../parrygg/scout.ts (V9-B) — same "who am I in this match" logic
 * that sync uses for a linked account applies unchanged to any parry.gg
 * user id being scouted.
 */
export function findSeeds(
  seeds: Seed[],
  parryUserId: string,
): { mine: Seed; opponent: Seed } | 'team' | null {
  if (seeds.length !== 2) {
    return null;
  }
  const usersListOf = (seed: Seed) => seed.eventEntrant?.entrant?.usersList ?? [];
  const mineIndex = seeds.findIndex((seed) => usersListOf(seed).some((u) => u.id === parryUserId));
  if (mineIndex === -1) {
    return null;
  }
  const mine = seeds[mineIndex]!;
  const opponent = seeds[mineIndex === 0 ? 1 : 0]!;
  if (usersListOf(mine).length > 1 || usersListOf(opponent).length > 1) {
    return 'team';
  }
  return { mine, opponent };
}

/**
 * Transforms one parry.gg MatchContext into importable match records,
 * mutating the summary counters for everything skipped. Exported for tests.
 * Mirrors start.gg's `gamesFromSet` structure/conventions closely — see
 * ../startgg/sync.ts.
 *
 * Walkthrough round 3 (07-11): also persists `opponentParryUserId` (the
 * opponent's parry.gg user id, a UUID) onto every produced record, when the
 * opponent's user is resolvable — the parry.gg parity for start.gg's
 * `opponentUserSlug`, read by `buildRecapOpponentUrl` to build the
 * opponent's `https://parry.gg/profile/{id}` link on a recap card.
 */
export function gamesFromMatchContext(
  context: ParryggMatchContext,
  parryUserId: string,
  summary: ParryggSyncSummary,
): ImportableGame[] {
  const match = context.match;
  if (!match) {
    return [];
  }

  // Only completed matches carry a meaningful result; anything else (or a
  // 0-0 walkover — no games were actually played) is skipped and counted
  // together as "not a real result to import".
  const slots = match.slotsList;
  const bothScoresZero = slots.length === 2 && slots.every((s) => s.score === 0);
  if (match.state !== MatchState.MATCH_STATE_COMPLETED || bothScoresZero) {
    summary.dqOrIncomplete += 1;
    return [];
  }

  // SSBU filter: `game` absent means we can't identify the title at all
  // (parry.gg test data suggests this means legacy/test tournaments) —
  // never assume it's SSBU. `game` present but not matching the SSBU slug
  // means it's a real, identified, non-SSBU game. Both are skipped, but
  // counted separately so the two situations stay distinguishable in the
  // sync summary.
  if (!context.game) {
    summary.unknownGame += 1;
    return [];
  }
  if (context.game.slug !== PARRYGG_SSBU_SLUG) {
    summary.otherGame += 1;
    return [];
  }

  summary.matches += 1;

  const seedResult = findSeeds(context.seedsList, parryUserId);
  if (seedResult === 'team') {
    summary.teamEntrants += 1;
    return [];
  }
  if (!seedResult) {
    // Can't identify my seed at all — nothing to attribute a result to.
    summary.dqOrIncomplete += 1;
    return [];
  }
  const { mine, opponent } = seedResult;

  const opponentUser = opponent.eventEntrant?.entrant?.usersList[0];
  const opponentTag = normalizeOpponentTag(opponentUser?.gamerTag ?? opponent.eventEntrant?.name);

  const paths = context.hierarchy?.pathsList ?? [];
  const eventName = pathNameByType(paths, PATH_TYPE_EVENT);
  const tournamentName = pathNameByType(paths, PATH_TYPE_TOURNAMENT);
  const roundText = match.grandFinals
    ? 'Grand Finals'
    : `${match.winnersSide ? 'Winners' : 'Losers'} Round ${match.round}`;
  const bracketRound = match.winnersSide ? match.round : -match.round;
  const opponentSeed =
    typeof opponent.seed === 'number' && opponent.seed > 0 ? opponent.seed : undefined;

  const endedAtSeconds = match.endedAt?.seconds ?? match.stateUpdatedAt?.seconds;
  const time =
    typeof endedAtSeconds === 'number'
      ? endedAtSeconds * 1000
      : (context.eventStartDate?.seconds ?? 0) * 1000;

  const results: ImportableGame[] = [];
  const games = match.matchGamesList;

  // `Slot.seedId` ties a top-level match slot to its `Seed.id`; `Slot.slot`
  // is the slot's numeric position (0/1), which is the SAME numbering
  // `MatchGameSlot.slot` uses per-game — that shared slot-number space is
  // how a game's per-slot detail is matched back to "mine" vs "opponent"
  // below (matching by `id` would be wrong: `MatchGameSlot.id` is a
  // per-game-slot id, not the same id space as the top-level `Slot.id`).
  const mySlotEntry = slots.find((s) => s.seedId === mine.id);
  const opponentSlotEntry = slots.find((s) => s.seedId === opponent.id);

  if (games.length === 0) {
    // No per-game detail (common on parry.gg test data per the V8-A probe
    // notes) — synthesize one record per game from the two slots' `score`
    // fields (mirrors start.gg sync's fallback when a set has no game
    // detail: attribute wins/losses to match the final score totals, since
    // per-game order/attribution isn't knowable). No character/stage.
    summary.setsWithoutGameData += 1;
    const myScore = Math.max(mySlotEntry?.score ?? 0, 0);
    const opponentScore = Math.max(opponentSlotEntry?.score ?? 0, 0);
    const totalGames = myScore + opponentScore;
    for (let i = 0; i < totalGames; i += 1) {
      const win = i < myScore;
      const key = `pgg-${match.id}-g${i + 1}`;
      results.push({
        key,
        opponentTag,
        record: {
          fighter_id: 0,
          opponent_id: 0,
          time,
          map: { id: 0, name: 'unknown' },
          opponent: opponentTag,
          notes: '',
          win,
          source: 'parrygg',
          externalId: key,
          ...(eventName ? { eventName } : {}),
          ...(tournamentName ? { tournamentName } : {}),
          ...(roundText ? { roundText } : {}),
          ...(bracketRound !== undefined ? { bracketRound } : {}),
          ...(opponentSeed != null ? { opponentSeed } : {}),
          ...(opponentUser?.id ? { opponentParryUserId: opponentUser.id } : {}),
        },
      });
    }
    return results;
  }

  games.forEach((game, index) => {
    const myGameSlot =
      mySlotEntry != null ? game.slotsList.find((s) => s.slot === mySlotEntry.slot) : undefined;
    const opponentGameSlot =
      opponentSlotEntry != null
        ? game.slotsList.find((s) => s.slot === opponentSlotEntry.slot)
        : undefined;

    if (!myGameSlot || !opponentGameSlot) {
      summary.unmappedCharacters += 1;
      return;
    }

    // `MatchGameParticipant.charactersList` is a list of full `Character`
    // messages (from models/game.proto), which carry a `slug` — NOT the
    // similarly-named `CharacterSelection.characterSlug` (a different,
    // mutation-only message; see bracket_pb.d.ts). Participants are matched
    // by `userId` (more robust than positional indexing when a slot ever
    // carries more than one participant).
    const myParticipant =
      myGameSlot.participantsList.find((p) => p.userId === parryUserId) ??
      myGameSlot.participantsList[0];
    const opponentParticipant =
      opponentGameSlot.participantsList.find((p) => p.userId === opponentUser?.id) ??
      opponentGameSlot.participantsList[0];
    const myCharacterSlug = myParticipant?.charactersList[0]?.slug;
    const opponentCharacterSlug = opponentParticipant?.charactersList[0]?.slug;

    const fighterId = parryggCharacterSlugToFighterId(myCharacterSlug);
    const opponentFighterId = parryggCharacterSlugToFighterId(opponentCharacterSlug);
    if (fighterId === undefined || opponentFighterId === undefined) {
      summary.unmappedCharacters += 1;
      return;
    }

    const stageSlug = game.stagesList[0]?.slug;
    const resolvedStage = resolveParryggStage(stageSlug);
    if (!resolvedStage) {
      summary.unmappedStages += 1;
    }

    const win = (myGameSlot?.placement ?? 0) === 1;
    const key = `pgg-${match.id}-g${index + 1}`;
    results.push({
      key,
      opponentTag,
      record: {
        fighter_id: fighterId,
        opponent_id: opponentFighterId,
        time,
        map: resolvedStage
          ? { id: resolvedStage.id, name: resolvedStage.name }
          : { id: 0, name: 'unknown' },
        opponent: opponentTag,
        notes: '',
        win,
        source: 'parrygg',
        externalId: key,
        ...(eventName ? { eventName } : {}),
        ...(tournamentName ? { tournamentName } : {}),
        ...(roundText ? { roundText } : {}),
        ...(bracketRound !== undefined ? { bracketRound } : {}),
        ...(opponentSeed != null ? { opponentSeed } : {}),
        ...(opponentUser?.id ? { opponentParryUserId: opponentUser.id } : {}),
      },
    });
  });

  return results;
}

/**
 * Mutable accumulator for one parry.gg event's tournament registry entry
 * while iterating match contexts; converted to a `TournamentEntry` (with
 * optional fields omitted, per the RTDB undefined rule) once accumulation is
 * complete. Mirrors start.gg's `RegistryAccumulator` (../startgg/sync.ts),
 * minus the fields parry.gg doesn't expose (numEntrants, placement,
 * top standings) — see Pitfall 1/Assumption A5 in 07-RESEARCH.md.
 *
 * Walkthrough round 3 (07-11): `slug`/`eventSlug` capture parry.gg's own
 * tournament-level/event-level path slugs directly during sync (unlike
 * start.gg, which fetches these in a separate post-sync enrichment step) —
 * feeds `buildRecapTournamentUrl`'s parry.gg bracket-link branch.
 */
interface ParryggRegistryAccumulator {
  eventName: string;
  tournamentName?: string;
  seed?: number;
  firstSetAt: number;
  lastSetAt: number;
  setsPlayed: number;
  slug?: string;
  eventSlug?: string;
}

/**
 * Derives a stable, RTDB-safe registry key for a parry.gg event: `pgg-` plus
 * the sanitized event slug when parry.gg provides one, falling back to a
 * sanitized `eventName|tournamentName` composite when it doesn't (parry.gg
 * events don't always carry a slug). Reuses the same `RTDB_ILLEGAL` regex
 * already used to sanitize opponent tags — this also strips `/`, so a
 * multi-segment slug (`tournament/foo/event/bar`) collapses into one legal
 * RTDB key segment. NEVER a numeric id (parry.gg has none) — see
 * tournamentEntrySchema's doc in packages/shared/src/startgg.ts.
 */
function deriveParryggEntryKey(
  paths: PathEntry[],
  eventName: string,
  tournamentName: string | undefined,
): string {
  const eventSlug = pathSlugByType(paths, PATH_TYPE_EVENT);
  const raw = eventSlug ?? `${eventName}|${tournamentName ?? ''}`;
  return `pgg-${raw.replace(RTDB_ILLEGAL, '')}`;
}

/**
 * Folds one parry.gg match context into the per-event registry accumulator
 * map, independently re-checking the same completed/singles/SSBU gating
 * `gamesFromMatchContext` applies (mirrors start.gg's `accumulateRegistry`
 * running its own independent gate alongside `gamesFromSet` — see
 * ../startgg/sync.ts). Exported for tests. A context only contributes when
 * an event name is resolvable (no event path → nothing to group by) and the
 * user's own seed is identifiable (team entrants / unidentifiable seed are
 * skipped, same as the match-import path).
 */
export function accumulateParryggRegistry(
  accumulators: Map<string, ParryggRegistryAccumulator>,
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
  if (!context.game || context.game.slug !== PARRYGG_SSBU_SLUG) {
    return;
  }

  const seedResult = findSeeds(context.seedsList, parryUserId);
  if (seedResult === 'team' || !seedResult) {
    return;
  }
  const { mine } = seedResult;

  const paths = context.hierarchy?.pathsList ?? [];
  const eventName = pathNameByType(paths, PATH_TYPE_EVENT);
  if (!eventName) {
    return;
  }
  const tournamentName = pathNameByType(paths, PATH_TYPE_TOURNAMENT);
  const seed = typeof mine.seed === 'number' && mine.seed > 0 ? mine.seed : undefined;
  const slug = pathSlugByType(paths, PATH_TYPE_TOURNAMENT);
  const eventSlug = pathSlugByType(paths, PATH_TYPE_EVENT);

  const endedAtSeconds = match.endedAt?.seconds ?? match.stateUpdatedAt?.seconds;
  const time =
    typeof endedAtSeconds === 'number'
      ? endedAtSeconds * 1000
      : (context.eventStartDate?.seconds ?? 0) * 1000;

  const entryKey = deriveParryggEntryKey(paths, eventName, tournamentName);

  const existing = accumulators.get(entryKey);
  if (!existing) {
    accumulators.set(entryKey, {
      eventName,
      ...(tournamentName ? { tournamentName } : {}),
      ...(seed != null ? { seed } : {}),
      ...(slug ? { slug } : {}),
      ...(eventSlug ? { eventSlug } : {}),
      firstSetAt: time,
      lastSetAt: time,
      setsPlayed: 1,
    });
    return;
  }

  existing.setsPlayed += 1;
  if (tournamentName) {
    existing.tournamentName = tournamentName;
  }
  if (seed != null) {
    existing.seed = seed;
  }
  if (slug) {
    existing.slug = slug;
  }
  if (eventSlug) {
    existing.eventSlug = eventSlug;
  }
  existing.firstSetAt = Math.min(existing.firstSetAt, time);
  existing.lastSetAt = Math.max(existing.lastSetAt, time);
}

/**
 * Imports every completed, singles SSBU match for the linked parry.gg user
 * into `matches/{uid}`, idempotently (stable keys `pgg-{matchId}-g{n}`, same
 * re-sync-overwrites-in-place convention as start.gg's `importPlayerMatches`
 * — see ../startgg/sync.ts). Also accumulates a per-event tournament
 * registry under tournamentEntries/{uid}, keyed by a derived, sanitized
 * `entryKey` (parry.gg has no numeric event id — see
 * `deriveParryggEntryKey`), idempotent the same way (re-syncs overwrite in
 * place — this IS the backfill path for RECAP-01's parry.gg parity). Always
 * user-initiated; there is no background scheduler for this sync.
 */
export async function importParryggMatches(
  database: Database,
  uid: string,
  parryUserId: string,
  apiKey: string,
  clients?: ParryggClients,
): Promise<ParryggSyncSummary> {
  const summary: ParryggSyncSummary = {
    matches: 0,
    imported: 0,
    dqOrIncomplete: 0,
    otherGame: 0,
    unknownGame: 0,
    teamEntrants: 0,
    unmappedCharacters: 0,
    unmappedStages: 0,
    setsWithoutGameData: 0,
  };

  const contexts = await getUserMatches(apiKey, parryUserId, clients);

  const matchUpdates: Record<string, MatchRecord> = {};
  const opponentUpdates: Record<string, true> = {};
  const registry = new Map<string, ParryggRegistryAccumulator>();

  for (const context of contexts) {
    const games = gamesFromMatchContext(context, parryUserId, summary);
    for (const game of games) {
      if (!(game.key in matchUpdates)) {
        summary.imported += 1;
      }
      matchUpdates[game.key] = game.record;
      opponentUpdates[game.opponentTag] = true;
    }
    // Accumulate registry stats for EVERY context, unconditionally —
    // `accumulateParryggRegistry` applies its own completed/singles/SSBU
    // gate internally, mirroring start.gg's accumulateRegistry/gamesFromSet
    // pair (review WR-07: gating on `games.length > 0` here dropped
    // completed sets whose every game was skipped for unmapped characters —
    // undercounting setsPlayed and shrinking the firstSetAt/lastSetAt window
    // `matchesForEntry` attributes matches by).
    accumulateParryggRegistry(registry, context, parryUserId);
  }

  if (Object.keys(matchUpdates).length > 0) {
    await database.ref(`matches/${uid}`).update(matchUpdates);
    await database.ref(`opponents/${uid}`).update(opponentUpdates);
  }
  if (registry.size > 0) {
    const registryUpdates: Record<string, TournamentEntry> = {};
    for (const [entryKey, acc] of registry) {
      registryUpdates[entryKey] = {
        eventName: acc.eventName,
        ...(acc.tournamentName ? { tournamentName: acc.tournamentName } : {}),
        ...(acc.seed != null ? { seed: acc.seed } : {}),
        ...(acc.slug ? { slug: acc.slug } : {}),
        ...(acc.eventSlug ? { eventSlug: acc.eventSlug } : {}),
        firstSetAt: acc.firstSetAt,
        lastSetAt: acc.lastSetAt,
        setsPlayed: acc.setsPlayed,
        source: 'parrygg',
        entryKey,
      };
    }
    await database.ref(`tournamentEntries/${uid}`).update(registryUpdates);
  }
  await database.ref(`parryggLinks/${uid}/lastSyncAt`).set(Date.now());

  return summary;
}

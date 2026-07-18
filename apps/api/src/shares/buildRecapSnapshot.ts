import {
  buildRecapOpponentUrl,
  buildRecapSetUrl,
  buildRecapTournamentUrl,
  buildSetTimeline,
  matchesForEntry,
  type Match,
  type RecapGame,
  type RecapSet,
  type RecapSnapshot,
  type TournamentEntry,
  type TournamentSet,
} from '@smash-tracker/shared';

/** `recapSetSchema.games`'s own array cap (mirrors `stages`'s identical cap/rationale). */
const MAX_RECAP_GAMES_PER_SET = 10;

/** `recapSetSchema.sets`'s own array cap — `buildFullDetailSets` keeps the MOST RECENT sets (the bracket climax) when a run exceeds this. */
const MAX_RECAP_SETS_STORED = 20;

/** Free-text fallback when a set's opponent tag was never captured by the source sync (parry.gg's synthetic no-game-detail path, or a pre-opponent-tag legacy import). */
const UNKNOWN_OPPONENT_LABEL = 'Unknown opponent';

/**
 * The won set representing the "notable win" — the best-seeded opponent
 * defeated (lowest `opponentSeed` among won sets). Ties (two won sets
 * against the same seed) resolve to the LATER set by `TournamentSet.time`
 * (chronological, side-agnostic — see 07-RESEARCH.md Open Question 4).
 * Returns `undefined` when there are zero won sets, or no won set's
 * opponent has a known seed — the caller must omit the field entirely
 * rather than write a fabricated/empty notableWin.
 */
function findNotableWin(sets: TournamentSet[]): TournamentSet | undefined {
  const wins = sets.filter((set) => set.won && set.opponentSeed != null);
  if (wins.length === 0) {
    return undefined;
  }
  return wins.reduce((best, set) => {
    if (set.opponentSeed! < best.opponentSeed!) {
      return set;
    }
    if (set.opponentSeed! === best.opponentSeed! && set.time > best.time) {
      return set;
    }
    return best;
  });
}

/**
 * Distinct fighter ids the user played across `sets`, first-seen order
 * (chronological, since `buildSetTimeline` already sorts sets by time).
 */
function distinctCharacterFighterIds(sets: TournamentSet[]): number[] {
  const ids: number[] = [];
  for (const set of sets) {
    for (const fighterId of set.userFighterIds) {
      if (!ids.includes(fighterId)) {
        ids.push(fighterId);
      }
    }
  }
  return ids;
}

/**
 * Walkthrough amendment (07-09): the opponent's final event placement for
 * one set's recap row. Prefers the set's OWN `opponentPlacement` (start.gg
 * Phase B sync duplicates this per-game onto the match record, so it's
 * already the correct per-opponent value when present). Falls back to a
 * case-insensitive tag lookup against the tournament entry's `topStandings`
 * (start.gg's post-sync top-finishers enrichment) for sets whose own
 * per-match field is absent — e.g. an entry synced before Phase B ran.
 * parry.gg entries never carry `topStandings` (07-RESEARCH.md Pitfall 1/
 * Assumption A5) and parry.gg matches never carry `opponentPlacement`
 * either, so this gracefully returns `undefined` for every parry.gg set,
 * exactly as CONTEXT.md's "graceful omission" rule requires.
 */
function lookupOpponentPlacement(set: TournamentSet, entry: TournamentEntry): number | undefined {
  if (set.opponentPlacement != null) {
    return set.opponentPlacement;
  }
  if (!set.opponentName || !entry.topStandings || entry.topStandings.length === 0) {
    return undefined;
  }
  const tag = set.opponentName.trim().toLowerCase();
  const standing = entry.topStandings.find(
    (candidate) =>
      candidate.gamerTag?.trim().toLowerCase() === tag ||
      candidate.name.trim().toLowerCase() === tag,
  );
  return standing?.placement;
}

/**
 * Distinct stage NAMES played across one set's games, first-seen
 * (game-order) — stage id `0` ("no selection") is never included, matching
 * the "unknown sentinel omitted" convention used everywhere else a stage is
 * rendered from a match record. Capped at `recapSetSchema.stages`'s own
 * array max (10) — a set legitimately playing more than 10 distinct stages
 * is not a realistic case, but the cap keeps this function's output always
 * schema-valid without relying on the caller to re-check.
 */
function distinctStageNames(set: TournamentSet): string[] {
  const names: string[] = [];
  for (const game of set.games) {
    const stage = game.match.map;
    if (stage && stage.id !== 0 && !names.includes(stage.name)) {
      names.push(stage.name);
    }
  }
  return names.slice(0, 10);
}

/**
 * Walkthrough amendment round 2 (07-10): per-game character+stage detail for
 * one set — one `RecapGame` per game, in game-number order (already sorted
 * by `buildSetTimeline`). `fighter_id`/`opponent_id`/`win` are always present
 * on a `Match` record (schema-required), so only `stageName` is
 * conditionally spread — stage id `0` ("no selection") is omitted, matching
 * `distinctStageNames`'s identical sentinel-omission convention. Capped at
 * `MAX_RECAP_GAMES_PER_SET` so this always produces a schema-valid array
 * without relying on the caller to re-check.
 */
function buildGames(set: TournamentSet): RecapGame[] {
  return set.games.slice(0, MAX_RECAP_GAMES_PER_SET).map((game): RecapGame => {
    const stage = game.match.map;
    const stageName = stage && stage.id !== 0 ? stage.name : undefined;
    return {
      fighterId: game.match.fighter_id,
      opponentFighterId: game.match.opponent_id,
      ...(stageName ? { stageName } : {}),
      win: game.match.win,
    };
  });
}

/**
 * Walkthrough amendment (07-09): builds the `detail: 'full'` set timeline —
 * one `RecapSet` per chronological `TournamentSet`, capped to the most
 * recent `MAX_RECAP_SETS_STORED` (the bracket climax, not the earliest pool
 * sets) when a run has more. `roundLabel` prefers the source site's own
 * round text, falling back to a positional "Set N" (1-based, in the ORIGINAL
 * chronological order, so the label stays stable even after the cap slices
 * off earlier sets).
 *
 * Walkthrough amendment round 2 (07-10): each set also carries `games`
 * (`buildGames`) — the per-game character matchup + stage, so a viewer sees
 * exactly what was played on which stage, not just an aggregate score.
 *
 * Walkthrough round 3 (07-11): each set also carries `opponentUrl`
 * (`buildRecapOpponentUrl`) and `setUrl` (`buildRecapSetUrl`, start.gg
 * only) — external provider links built server-side from stored registry/
 * match fields against verified, fixed URL shapes, omitted whenever the
 * backing field isn't on record.
 */
function buildFullDetailSets(sets: TournamentSet[], entry: TournamentEntry): RecapSet[] {
  const recapSets: RecapSet[] = sets.map((set, index) => {
    const opponentPlacement = lookupOpponentPlacement(set, entry);
    const stages = distinctStageNames(set);
    const games = buildGames(set);
    const opponentUrl = buildRecapOpponentUrl(entry, set);
    const setUrl = buildRecapSetUrl(entry, set);
    return {
      roundLabel: set.roundText ?? `Set ${index + 1}`,
      opponentName: set.opponentName ?? UNKNOWN_OPPONENT_LABEL,
      ...(opponentPlacement != null ? { opponentPlacement } : {}),
      wins: set.gamesWon,
      losses: set.gamesLost,
      win: set.won,
      ...(stages.length > 0 ? { stages } : {}),
      ...(games.length > 0 ? { games } : {}),
      ...(opponentUrl ? { opponentUrl } : {}),
      ...(setUrl ? { setUrl } : {}),
    };
  });
  return recapSets.length > MAX_RECAP_SETS_STORED
    ? recapSets.slice(-MAX_RECAP_SETS_STORED)
    : recapSets;
}

/**
 * Builds a `RecapSnapshot` from a tournament entry + the user's FULL match
 * list — called once, at share-creation time, never again (same
 * SHARE-01-style immutability rule as `buildShareSnapshot`: a later re-sync
 * or match edit must never change an issued recap link). Pure function, no
 * I/O — the caller (`RtdbService`) is responsible for reading
 * `tournamentEntries/{uid}/{entryKey}` and `matches/{uid}` beforehand.
 *
 * Uses the promoted `matchesForEntry`/`buildSetTimeline` (packages/shared)
 * to scope + group the entry's matches into sets, then derives:
 * - `setRecordWins`/`setRecordLosses` from `TournamentSet.won`.
 * - `notableWin` via `findNotableWin` (omitted entirely on zero wins or no
 *   known opponent seed).
 * - `characterFighterIds` via `distinctCharacterFighterIds`.
 * - `placement`/`seed`/`numEntrants` conditionally spread from the entry
 *   (never `null`) when the source site didn't provide them.
 * - `reviewedMomentsCount` summed across every match `matchesForEntry`
 *   attributes to this entry (not just the ones grouped into sets), always
 *   written even when `0`.
 *
 * `entry.entryKey` MUST be stamped by the caller before this is invoked —
 * `TournamentEntry.entryKey` is `.nullish()` only to keep legacy stored
 * records (written before the field existed) parseable; `RtdbService`
 * already knows the routing key it read the entry BY (the request body's
 * `entryKey`) and must merge it onto the raw stored entry first, the same
 * convention `GET /api/tournaments` uses when stamping it from the RTDB
 * child key on read.
 *
 * Walkthrough amendment (07-09): `detail` (defaulted to `'full'` by the
 * caller — `RtdbService.createShare` — when the request omitted it) governs
 * whether the full chronological set timeline (`sets`) is built and stored
 * at all; a `'summary'` generation never computes `buildFullDetailSets`,
 * matching CONTEXT.md's snapshot-immutability rule (nothing is silently
 * upgradeable after creation). `tournamentUrl` is computed regardless of
 * `detail` — it's a fixed fact about the tournament entry, not a
 * detail-level toggle.
 */
export function buildRecapSnapshot(
  uid: string,
  entry: TournamentEntry,
  matches: Match[],
  ownerDisplayName?: string,
  detail: 'summary' | 'full' = 'full',
): RecapSnapshot {
  const entryMatches = matchesForEntry(matches, entry);
  const { sets } = buildSetTimeline(entryMatches);

  const setRecordWins = sets.filter((set) => set.won).length;
  const setRecordLosses = sets.filter((set) => !set.won).length;
  const notableWin = findNotableWin(sets);
  const characterFighterIds = distinctCharacterFighterIds(sets);
  const reviewedMomentsCount = entryMatches.reduce(
    (total, match) => total + (match.vodTimestamps?.length ?? 0),
    0,
  );
  const tournamentUrl = buildRecapTournamentUrl(entry);

  return {
    uid,
    // Caller must stamp entry.entryKey before calling this — see doc above.
    entryKey: entry.entryKey!,
    createdAt: Date.now(),
    kind: 'recap',
    source: entry.source ?? 'startgg',
    tournamentName: entry.tournamentName ?? entry.eventName,
    tournamentDate: entry.firstSetAt,
    ...(entry.placement != null ? { placement: entry.placement } : {}),
    ...(entry.seed != null ? { seed: entry.seed } : {}),
    ...(entry.numEntrants != null ? { numEntrants: entry.numEntrants } : {}),
    setRecordWins,
    setRecordLosses,
    ...(notableWin
      ? {
          notableWin: {
            ...(notableWin.opponentName ? { opponentName: notableWin.opponentName } : {}),
            opponentSeed: notableWin.opponentSeed!,
          },
        }
      : {}),
    characterFighterIds,
    reviewedMomentsCount,
    ...(ownerDisplayName ? { ownerDisplayName } : {}),
    ...(tournamentUrl ? { tournamentUrl } : {}),
    ...(detail === 'full'
      ? { detail: 'full' as const, sets: buildFullDetailSets(sets, entry) }
      : {}),
  };
}

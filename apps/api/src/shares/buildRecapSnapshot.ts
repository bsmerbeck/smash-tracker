import {
  buildSetTimeline,
  matchesForEntry,
  type Match,
  type RecapSnapshot,
  type TournamentEntry,
  type TournamentSet,
} from '@smash-tracker/shared';

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
 */
export function buildRecapSnapshot(
  uid: string,
  entry: TournamentEntry,
  matches: Match[],
  ownerDisplayName?: string,
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
  };
}

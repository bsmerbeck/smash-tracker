import type { Match } from '@smash-tracker/shared';

/**
 * Parses the `sgg:{setId}:g{n}` externalId convention (see
 * apps/api/src/startgg/sync.ts `gamesFromSet`) into its set id and game
 * number. Returns `null` for manually-entered matches (no `externalId`) or
 * any externalId that doesn't match the expected shape.
 */
export function parseExternalId(
  externalId: string | undefined,
): { setId: string; game: number } | null {
  if (!externalId) {
    return null;
  }
  const match = /^sgg:(.+):g(\d+)$/.exec(externalId);
  if (!match) {
    return null;
  }
  const [, setId, gameStr] = match;
  const game = Number(gameStr);
  if (!setId || !Number.isFinite(game)) {
    return null;
  }
  return { setId, game };
}

export interface SetGame {
  match: Match;
  gameNumber: number;
}

export interface TournamentSet {
  setId: string;
  /** Chronologically first game's time — used to order sets. */
  time: number;
  /** start.gg's human round label, when available. */
  roundText: string | undefined;
  /** start.gg's signed round integer; negative = losers side. */
  bracketRound: number | undefined;
  /** The tracked user's fighter id(s) played across this set's games, in first-seen order. */
  userFighterIds: number[];
  /** The opponent's fighter id(s) faced across this set's games, in first-seen order. */
  opponentFighterIds: number[];
  /** The human opponent's free-text tag for this set, when any game carries one. */
  opponentName: string | undefined;
  /** The human opponent's seed in this event, when start.gg provided it (Phase B sync). */
  opponentSeed: number | undefined;
  /** The human opponent's final placement in this event, when start.gg provided it (Phase B sync). */
  opponentPlacement: number | undefined;
  /** The human opponent's start.gg profile slug, when start.gg provided it (Phase B sync). */
  opponentUserSlug: string | undefined;
  /** Games in the set, ordered by game number. */
  games: SetGame[];
  /** Games won by the tracked user within this set. */
  gamesWon: number;
  /** Games lost by the tracked user within this set. */
  gamesLost: number;
  /** Whether the tracked user won the set overall (more games won than lost). */
  won: boolean;
}

/**
 * Groups an entry's matches into sets (parsed from `externalId`), ordered
 * chronologically, plus a separate list of matches that don't belong to any
 * parseable set (manual entries, or imports predating the externalId
 * convention). `roundText`/`bracketRound`/`opponentName`/`opponentSeed`/
 * `opponentPlacement`/`opponentUserSlug` are read off the first game that
 * carries them (imports before the relevant resync lack these fields
 * entirely — every consumer must tolerate `undefined`).
 */
export interface SetTimeline {
  sets: TournamentSet[];
  /** Matches during the event that couldn't be grouped into a set (no parseable externalId). */
  otherMatches: Match[];
}

export function buildSetTimeline(entryMatches: Match[]): SetTimeline {
  const bySet = new Map<string, SetGame[]>();
  const otherMatches: Match[] = [];

  for (const match of entryMatches) {
    const parsed = parseExternalId(match.externalId);
    if (!parsed) {
      otherMatches.push(match);
      continue;
    }
    const group = bySet.get(parsed.setId);
    const game: SetGame = { match, gameNumber: parsed.game };
    if (group) {
      group.push(game);
    } else {
      bySet.set(parsed.setId, [game]);
    }
  }

  const sets: TournamentSet[] = [...bySet.entries()].map(([setId, games]) => {
    const ordered = [...games].sort((a, b) => a.gameNumber - b.gameNumber);
    const gamesWon = ordered.filter((g) => g.match.win).length;
    const gamesLost = ordered.length - gamesWon;

    const userFighterIds: number[] = [];
    const opponentFighterIds: number[] = [];
    for (const g of ordered) {
      if (!userFighterIds.includes(g.match.fighter_id)) {
        userFighterIds.push(g.match.fighter_id);
      }
      if (!opponentFighterIds.includes(g.match.opponent_id)) {
        opponentFighterIds.push(g.match.opponent_id);
      }
    }

    return {
      setId,
      time: Math.min(...ordered.map((g) => g.match.time)),
      roundText: ordered.map((g) => g.match.roundText).find((r) => r != null),
      bracketRound: ordered.map((g) => g.match.bracketRound).find((r) => r != null),
      userFighterIds,
      opponentFighterIds,
      opponentName: ordered.map((g) => g.match.opponent).find((r) => r != null),
      opponentSeed: ordered.map((g) => g.match.opponentSeed).find((r) => r != null),
      opponentPlacement: ordered.map((g) => g.match.opponentPlacement).find((r) => r != null),
      opponentUserSlug: ordered.map((g) => g.match.opponentUserSlug).find((r) => r != null),
      games: ordered,
      gamesWon,
      gamesLost,
      won: gamesWon > gamesLost,
    };
  });

  sets.sort((a, b) => a.time - b.time);

  otherMatches.sort((a, b) => a.time - b.time);

  return { sets, otherMatches };
}

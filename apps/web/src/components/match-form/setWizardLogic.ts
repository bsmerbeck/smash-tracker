import type { CreateMatchInput, MatchType } from '@smash-tracker/shared';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { stageOptions } from '@/lib/stageOptions';
import { parseFlexibleTimestamp } from '@/lib/vod';

/** The two set lengths the wizard supports — best of 3 or best of 5. */
export const setFormatValues = ['bo3', 'bo5'] as const;
export type SetFormat = (typeof setFormatValues)[number];

/** Games needed to clinch a set of the given format (2 of 3, 3 of 5). */
export function winsNeededFor(format: SetFormat): number {
  return format === 'bo3' ? 2 : 3;
}

/** The maximum number of games a set of this format could possibly go to. */
export function maxGamesFor(format: SetFormat): number {
  return format === 'bo3' ? 3 : 5;
}

/** Per-game input collected by the set wizard — one row per game played. */
export interface SetGameValues {
  result: 'win' | 'loss';
  stageId: number;
  /** Winner's remaining stocks for this game, if tracked. */
  stocksLeft?: number;
  /**
   * SETFEAT-01: raw text VOD link for this specific game (a Bo3/Bo5 set is
   * often recorded as separate clips per game, unlike the single-game form's
   * one-VOD-per-match assumption). Mirrors `MatchFormValues.vodUrl` — held as
   * raw text, parsed/validated in `buildSetGamePayloads`.
   */
  vodUrl?: string;
  /**
   * SETFEAT-01: raw text start-time offset into this game's `vodUrl`.
   * Mirrors `MatchFormValues.vodStartSeconds` — only meaningful alongside a
   * non-blank `vodUrl` for this same game (see `buildSetGamePayloads`).
   */
  vodStartSeconds?: string;
  /**
   * SETFEAT-02: which form of the stage this game was played on, if the
   * player tracked it. Untouched toggle = `undefined` = no form recorded
   * on that game's `map` (see `buildSetGamePayloads`'s conditional-spread).
   */
  stageForm?: 'normal' | 'battlefield' | 'omega';
  /**
   * This game's OWN character choice — `undefined` means inherit: game 1
   * inherits the set-level `SetSharedValues.fighterId` picker, games 2+
   * inherit the previous game's EFFECTIVE value (see
   * `resolveSetFighterSelections`).
   */
  fighterId?: number;
  /**
   * This game's OWN opponent-character choice — `undefined` means inherit:
   * game 1 inherits the set-level `SetSharedValues.opponentFighterId`
   * picker, games 2+ inherit the previous game's EFFECTIVE value (see
   * `resolveSetFighterSelections`).
   */
  opponentFighterId?: number;
}

/** Running win/loss tally across the games entered so far. */
export interface SetScore {
  wins: number;
  losses: number;
}

/** Tallies wins/losses from the games entered so far. */
export function getSetScore(games: SetGameValues[]): SetScore {
  return games.reduce<SetScore>(
    (score, game) => ({
      wins: score.wins + (game.result === 'win' ? 1 : 0),
      losses: score.losses + (game.result === 'loss' ? 1 : 0),
    }),
    { wins: 0, losses: 0 },
  );
}

/**
 * A set is decided once either side has reached the number of wins needed
 * to clinch the format (2 for Bo3, 3 for Bo5) — matching standard Smash set
 * rules where play stops the instant the outcome is mathematically settled.
 */
export function isSetDecided(format: SetFormat, score: SetScore): boolean {
  const needed = winsNeededFor(format);
  return score.wins >= needed || score.losses >= needed;
}

/**
 * Whether the wizard should render a row for `gameNumber` (1-indexed): only
 * while the set is undecided and the format's game cap hasn't been reached.
 * Game 1 always renders regardless of `games` so the wizard has somewhere
 * to start.
 */
export function shouldShowGame(
  format: SetFormat,
  gameNumber: number,
  games: SetGameValues[],
): boolean {
  if (gameNumber === 1) {
    return true;
  }
  if (gameNumber > maxGamesFor(format)) {
    return false;
  }
  const priorGames = games.slice(0, gameNumber - 1);
  if (priorGames.length < gameNumber - 1 || priorGames.some((g) => !g.result)) {
    return false;
  }
  return !isSetDecided(format, getSetScore(priorGames));
}

/** Human-readable "2-1" style label for the live set-score chip. */
export function formatSetScore(score: SetScore): string {
  return `${score.wins}-${score.losses}`;
}

/** Fields entered once and shared across every game in a set. */
export interface SetSharedValues {
  /**
   * The set-level DEFAULT for "your fighter" — seeds game 1's effective
   * value (see `resolveSetFighterSelections`). No longer stamped onto every
   * game: each game's own `SetGameValues.fighterId` can override it.
   */
  fighterId: number;
  /**
   * The set-level DEFAULT for "opponent's fighter" — seeds game 1's
   * effective value (see `resolveSetFighterSelections`). No longer stamped
   * onto every game: each game's own `SetGameValues.opponentFighterId` can
   * override it.
   */
  opponentFighterId: number;
  opponentName: string;
  matchType: MatchType;
  eventName?: string;
  tournamentName?: string;
}

/** One game's resolved (never-undefined) character pair. */
export interface ResolvedGameFighters {
  fighterId: number;
  opponentFighterId: number;
}

/**
 * Resolves the EFFECTIVE character pair for every game in `games`, given the
 * set-level defaults in `shared`. Resolution is a forward carry, per axis,
 * independent of the other axis:
 *  - entry 0 (game 1) uses `games[0]?.fighterId ?? shared.fighterId` (same
 *    shape for `opponentFighterId`).
 *  - entry `i` (i > 0) uses `games[i]?.fighterId ?? entry[i - 1].fighterId`
 *    — an untouched game inherits the PREVIOUS game's effective value, not
 *    the set-level default, so an earlier override "sticks" through the
 *    rest of the set until explicitly changed again.
 *
 * Never mutates `games`. Resolution only ever looks at a game's OWN entry
 * and the previously-resolved entry — it never looks ahead — so resolving
 * over the full `games` array (what the wizard UI does, to render every
 * visible row) and resolving over the trailing-trimmed array
 * `buildSetGamePayloads` actually receives (only the played games) yield
 * IDENTICAL values for every game present in both calls.
 */
export function resolveSetFighterSelections(
  shared: Pick<SetSharedValues, 'fighterId' | 'opponentFighterId'>,
  games: SetGameValues[],
): ResolvedGameFighters[] {
  const resolved: ResolvedGameFighters[] = [];
  games.forEach((game, index) => {
    const previous = resolved[index - 1];
    resolved.push({
      fighterId: game.fighterId ?? previous?.fighterId ?? shared.fighterId,
      opponentFighterId:
        game.opponentFighterId ?? previous?.opponentFighterId ?? shared.opponentFighterId,
    });
  });
  return resolved;
}

/**
 * Builds a game's `map` field — `{ id, name }` plus a conditional-spread
 * `form` key (SETFEAT-02) present only when `stageForm` is set, mirroring
 * `matchFormValuesToInput`'s map-building convention and the RTDB
 * null-stripping rule (never an own `form` property holding `undefined`).
 */
function resolveStageMap(stageId: number, stageForm?: 'normal' | 'battlefield' | 'omega') {
  const stage = stageOptions.find((s) => s.id === stageId) ?? NO_SELECTION_STAGE;
  return {
    id: stage.id,
    name: stage.name,
    ...(stageForm ? { form: stageForm } : {}),
  };
}

/**
 * Builds one `CreateMatchInput` per game in the set, merging the
 * once-entered shared fields with each game's own stage/result/stocks.
 * `notes` isn't collected per-game in the wizard, so it's always sent empty
 * (matching the schema's default).
 */
export function buildSetGamePayloads(
  shared: SetSharedValues,
  games: SetGameValues[],
): CreateMatchInput[] {
  const resolvedFighters = resolveSetFighterSelections(shared, games);
  return games.map((game, index) => {
    // Mirrors matchFormValuesToInput's clear-on-omit convention (MatchForm.tsx):
    // trim vodUrl, only parse/include vodStartSeconds when a vodUrl is also
    // present on this same game, and never emit an `undefined` key.
    const vodUrl = game.vodUrl?.trim();
    const vodStartSecondsRaw = game.vodStartSeconds?.trim();
    const vodStartSeconds =
      vodUrl && vodStartSecondsRaw ? parseFlexibleTimestamp(vodStartSecondsRaw) : null;
    const { fighterId, opponentFighterId } = resolvedFighters[index]!;
    return {
      fighter_id: fighterId,
      opponent_id: opponentFighterId,
      map: resolveStageMap(game.stageId, game.stageForm),
      opponent: shared.opponentName,
      notes: '',
      matchType: shared.matchType,
      win: game.result === 'win',
      ...(game.stocksLeft !== undefined ? { stocksLeft: game.stocksLeft } : {}),
      ...(shared.eventName ? { eventName: shared.eventName } : {}),
      ...(shared.tournamentName ? { tournamentName: shared.tournamentName } : {}),
      ...(vodUrl ? { vodUrl } : {}),
      ...(vodStartSeconds !== null ? { vodStartSeconds } : {}),
    };
  });
}

/** Default per-game values for a freshly-added row. */
export function buildDefaultGameValues(): SetGameValues {
  return {
    result: undefined as unknown as SetGameValues['result'],
    stageId: NO_SELECTION_STAGE.id,
    stocksLeft: undefined,
    vodUrl: undefined,
    vodStartSeconds: undefined,
    stageForm: undefined,
    fighterId: undefined,
    opponentFighterId: undefined,
  };
}

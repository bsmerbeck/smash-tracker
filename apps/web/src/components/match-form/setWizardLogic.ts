import type { CreateMatchInput, MatchType } from '@smash-tracker/shared';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { stageOptions } from '@/lib/stageOptions';

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
  fighterId: number;
  opponentFighterId: number;
  opponentName: string;
  matchType: MatchType;
  eventName?: string;
  tournamentName?: string;
}

function resolveStageMap(stageId: number) {
  const stage = stageOptions.find((s) => s.id === stageId) ?? NO_SELECTION_STAGE;
  return { id: stage.id, name: stage.name };
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
  return games.map((game) => ({
    fighter_id: shared.fighterId,
    opponent_id: shared.opponentFighterId,
    map: resolveStageMap(game.stageId),
    opponent: shared.opponentName,
    notes: '',
    matchType: shared.matchType,
    win: game.result === 'win',
    ...(game.stocksLeft !== undefined ? { stocksLeft: game.stocksLeft } : {}),
    ...(shared.eventName ? { eventName: shared.eventName } : {}),
    ...(shared.tournamentName ? { tournamentName: shared.tournamentName } : {}),
  }));
}

/** Default per-game values for a freshly-added row. */
export function buildDefaultGameValues(): SetGameValues {
  return {
    result: undefined as unknown as SetGameValues['result'],
    stageId: NO_SELECTION_STAGE.id,
    stocksLeft: undefined,
  };
}

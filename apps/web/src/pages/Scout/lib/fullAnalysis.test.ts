import { describe, expect, it } from 'vitest';
import type { ScoutGame } from '@smash-tracker/shared';
import { buildScoutFormSeries, gamesBehindPoint, scoutGamesToMatches } from './fullAnalysis';

function makeGame(overrides: Partial<ScoutGame> = {}): ScoutGame {
  return {
    time: 1_700_000_000_000,
    win: true,
    fighterId: 67,
    opponentFighterId: 41,
    stageId: 1,
    stageName: 'Battlefield',
    opponentTag: 'PowPow',
    eventName: 'Ultimate Singles',
    ...overrides,
  };
}

describe('scoutGamesToMatches', () => {
  it('maps every field to its Match equivalent', () => {
    const matches = scoutGamesToMatches([makeGame()]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      fighter_id: 67,
      opponent_id: 41,
      time: 1_700_000_000_000,
      win: true,
      opponent: 'PowPow',
      matchType: 'none',
      map: { id: 1, name: 'Battlefield' },
      eventName: 'Ultimate Singles',
    });
  });

  it('assigns each game a unique, stable-order synthetic id', () => {
    const matches = scoutGamesToMatches([makeGame(), makeGame({ win: false })]);
    expect(matches[0]?.id).not.toBe(matches[1]?.id);
  });

  it('omits `map` entirely when the game has no resolved stage', () => {
    const matches = scoutGamesToMatches([makeGame({ stageId: undefined, stageName: undefined })]);
    expect(matches[0]?.map).toBeUndefined();
  });

  it('omits `eventName` when absent', () => {
    const matches = scoutGamesToMatches([makeGame({ eventName: undefined })]);
    expect(matches[0]?.eventName).toBeUndefined();
  });

  it('maps tournamentName onto the Match and omits the key when absent (41-17)', () => {
    const [named, bare] = scoutGamesToMatches([
      makeGame({ tournamentName: 'Genesis 9' }),
      makeGame(),
    ]);
    expect(named?.tournamentName).toBe('Genesis 9');
    expect(bare && 'tournamentName' in bare).toBe(false);
  });

  it('preserves the fighterId-0 / opponentFighterId-0 sentinels as plain numbers', () => {
    const matches = scoutGamesToMatches([makeGame({ opponentFighterId: 0 })]);
    expect(matches[0]?.opponent_id).toBe(0);
  });

  it('returns an empty array for an empty input', () => {
    expect(scoutGamesToMatches([])).toEqual([]);
  });
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2025, 0, 6, 18);

/** One game per distinct weekly event: `count` events, each named differently and a week apart. */
function weeklyEventGames(count: number): ScoutGame[] {
  return Array.from({ length: count }, (_, i) =>
    makeGame({ time: T0 + i * WEEK_MS, win: i % 3 !== 0, eventName: `Weekly ${i}` }),
  );
}

describe('buildScoutFormSeries', () => {
  it('at or under 60 anchors the display is the unbinned anchor array at grain "event"', () => {
    const matches = scoutGamesToMatches(weeklyEventGames(20));
    const { display, grain } = buildScoutFormSeries(matches);
    expect(grain).toBe('event');
    expect(display).toHaveLength(20);
    expect(display.every((point) => point.kind === 'tournament')).toBe(true);
  });

  it('100 distinct weekly events bin to at most 60 points at grain "month"', () => {
    const matches = scoutGamesToMatches(weeklyEventGames(100));
    const { display, grain } = buildScoutFormSeries(matches);
    expect(grain).toBe('month');
    expect(display.length).toBeLessThanOrEqual(60);
    expect(display.every((point) => point.kind === 'bin')).toBe(true);
  });

  it.each([20, 100])('partition: %i events, every match id sits behind exactly one point', (n) => {
    const matches = scoutGamesToMatches(weeklyEventGames(n));
    const { display } = buildScoutFormSeries(matches);
    const ids = display.flatMap((point) => point.matchIds);
    expect(ids).toHaveLength(matches.length);
    expect(new Set(ids)).toEqual(new Set(matches.map((m) => m.id)));
  });

  it('no games yields an empty display at grain "event"', () => {
    expect(buildScoutFormSeries([])).toEqual({ display: [], grain: 'event' });
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Six games in two events both named 'Ultimate Singles', 30 days apart, at two tournaments. */
function sameNamedEventGames(withTournament: boolean): ScoutGame[] {
  const at = (tournamentName: string, start: number, wins: boolean[]) =>
    wins.map((win, i) =>
      makeGame({
        time: start + i * 60 * 60 * 1000,
        win,
        eventName: 'Ultimate Singles',
        ...(withTournament ? { tournamentName } : {}),
      }),
    );
  return [
    ...at('Genesis 9', T0, [true, true, false]),
    ...at('Pound 2025', T0 + 30 * DAY_MS, [false, false, true]),
  ];
}

describe('buildScoutFormSeries — tournament-named labels (41-17, UAT 41-6)', () => {
  it('two same-named events at two tournaments get distinct "<tournament> · <event>" labels', () => {
    const { display } = buildScoutFormSeries(scoutGamesToMatches(sameNamedEventGames(true)));
    expect(display.map((point) => point.label)).toEqual([
      'Genesis 9 \u00b7 Ultimate Singles',
      'Pound 2025 \u00b7 Ultimate Singles',
    ]);
  });

  it('anchor keys and per-anchor W–L are identical with and without tournamentName', () => {
    const shape = (withTournament: boolean) =>
      buildScoutFormSeries(scoutGamesToMatches(sameNamedEventGames(withTournament))).display.map(
        (point) => ({ key: point.key, wins: point.wins, losses: point.losses }),
      );
    const named = shape(true);
    expect(named).toHaveLength(2);
    expect(named).toEqual(shape(false));
    expect(named.map(({ wins, losses }) => [wins, losses])).toEqual([
      [2, 1],
      [1, 2],
    ]);
  });

  it('without tournamentName the label stays the bare event name', () => {
    const { display } = buildScoutFormSeries(scoutGamesToMatches(sameNamedEventGames(false)));
    expect(display.map((point) => point.label)).toEqual(['Ultimate Singles', 'Ultimate Singles']);
  });
});

describe('gamesBehindPoint', () => {
  it('returns exactly the matches whose ids are in the point matchIds, oldest first', () => {
    const matches = scoutGamesToMatches([
      makeGame({ time: T0 + 30, eventName: 'Event A' }),
      makeGame({ time: T0 + 10, eventName: 'Event A' }),
      makeGame({ time: T0 + 40 * WEEK_MS, eventName: 'Event B' }),
    ]);
    const { display } = buildScoutFormSeries(matches);
    expect(display).toHaveLength(2);
    const behind = gamesBehindPoint(display[0]!, matches);
    expect(behind.map((m) => m.time)).toEqual([T0 + 10, T0 + 30]);
    expect(gamesBehindPoint(display[1]!, matches)).toHaveLength(1);
  });

  it('identity, not window: a game inside the point time span but not in matchIds is excluded', () => {
    const matches = scoutGamesToMatches([
      makeGame({ time: T0, eventName: 'Event A' }),
      makeGame({ time: T0 + 20, eventName: 'Event A' }),
      makeGame({ time: T0 + 10, eventName: undefined, opponentTag: 'Other' }),
    ]);
    const { display } = buildScoutFormSeries(matches);
    const tournament = display.find((point) => point.kind === 'tournament')!;
    const behind = gamesBehindPoint(tournament, matches);
    expect(behind).toHaveLength(2);
    expect(behind.every((m) => m.opponent === 'PowPow')).toBe(true);
  });

  it('an empty matchIds returns no games', () => {
    const matches = scoutGamesToMatches([makeGame()]);
    const { display } = buildScoutFormSeries(matches);
    expect(gamesBehindPoint({ ...display[0]!, matchIds: [] }, matches)).toEqual([]);
  });
});

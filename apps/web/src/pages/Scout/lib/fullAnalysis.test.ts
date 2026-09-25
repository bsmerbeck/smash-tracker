import { describe, expect, it } from 'vitest';
import type { Match, ScoutGame } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { getRollingWinRate } from '@/lib/stats';
import { buildScoutTrendChartPoints, scoutGamesToMatches } from './fullAnalysis';

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

  it('preserves the fighterId-0 / opponentFighterId-0 sentinels as plain numbers', () => {
    const matches = scoutGamesToMatches([makeGame({ opponentFighterId: 0 })]);
    expect(matches[0]?.opponent_id).toBe(0);
  });

  it('returns an empty array for an empty input', () => {
    expect(scoutGamesToMatches([])).toEqual([]);
  });
});

describe('buildScoutTrendChartPoints', () => {
  function makeMatch(overrides: Partial<Match> = {}): Match {
    return {
      id: 'm1',
      fighter_id: 1,
      opponent_id: 10,
      time: 1000,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'PowPow',
      matchType: 'none',
      win: true,
      ...overrides,
    };
  }

  it('maps the rolling-win-rate series onto the kit TrendChartPoint shape', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false }),
    ];
    const series = getRollingWinRate(matches, 5);
    const points = buildScoutTrendChartPoints(series, i18n.t.bind(i18n));
    expect(points).toHaveLength(2);
    expect(points[0]?.context).toMatchObject({
      matchId: 'm1',
      opponentTag: 'PowPow',
      stageName: 'Battlefield',
      win: true,
    });
  });

  it('falls back to the localized unknown label for a match with stage id 0', () => {
    const series = getRollingWinRate([makeMatch({ map: { id: 0, name: 'no selection' } })], 5);
    const points = buildScoutTrendChartPoints(series, i18n.t.bind(i18n));
    expect(points[0]?.context.stageName).toBe(i18n.t('common.unknown'));
  });

  it('resolves eventName from tournamentName when eventName is absent', () => {
    const series = getRollingWinRate(
      [makeMatch({ eventName: undefined, tournamentName: 'Genesis 10' })],
      5,
    );
    const points = buildScoutTrendChartPoints(series, i18n.t.bind(i18n));
    expect(points[0]?.context.eventName).toBe('Genesis 10');
  });

  it('returns an empty array for an empty series', () => {
    expect(buildScoutTrendChartPoints([], i18n.t.bind(i18n))).toEqual([]);
  });
});

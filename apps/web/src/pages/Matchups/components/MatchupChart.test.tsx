import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n';
import type { Match } from '@smash-tracker/shared';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { buildTrendChartPoints, buildTrendSeries, MatchupChart } from './MatchupChart';
import { MATCHUP_TABLE_ANCHOR_ID } from './MatchupTable';

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function sequence(results: boolean[]): Match[] {
  return results.map((win, i) => makeMatch({ id: `m${i}`, time: i + 1, win }));
}

describe('buildTrendSeries', () => {
  it('builds a trailing-5 rolling window by default mode', () => {
    // 7 matches: L L L L L W W — trailing window 5 at the last point covers
    // matches 3-7 (L L L W W) => 2/5 = 40%.
    const matches = sequence([false, false, false, false, false, true, true]);
    const series = buildTrendSeries(matches, '5');
    expect(series).toHaveLength(7);
    expect(series[series.length - 1]?.winRate).toBeCloseTo(40);
  });

  it('builds a trailing-10 rolling window', () => {
    const matches = sequence([true, true, true, false, false]);
    const series = buildTrendSeries(matches, '10');
    // Only 5 matches exist, so the window is the whole series: 3/5 = 60%.
    expect(series[series.length - 1]?.winRate).toBeCloseTo(60);
  });

  it('builds a cumulative (all-time running) series', () => {
    const matches = sequence([true, false, true, true]);
    const series = buildTrendSeries(matches, 'cumulative');
    // Cumulative win rate after 4 matches: 3/4 = 75%.
    expect(series[series.length - 1]?.winRate).toBeCloseTo(75);
    // Cumulative after match 1: 1/1 = 100%.
    expect(series[0]?.winRate).toBeCloseTo(100);
  });

  it('returns an empty series for no matches', () => {
    expect(buildTrendSeries([], '5')).toEqual([]);
    expect(buildTrendSeries([], 'cumulative')).toEqual([]);
  });
});

describe('buildTrendChartPoints', () => {
  it('falls back to the localized unknown label for a match with stage id 0', () => {
    const series = buildTrendSeries([makeMatch({ map: { id: 0, name: 'no selection' } })], '5');
    const points = buildTrendChartPoints(series, i18n.t.bind(i18n));
    expect(points[0]?.context.stageName).toBe(i18n.t('common.unknown'));
  });

  it('resolves eventName to null when neither eventName nor tournamentName is set', () => {
    const series = buildTrendSeries(
      [makeMatch({ eventName: undefined, tournamentName: undefined })],
      '5',
    );
    const points = buildTrendChartPoints(series, i18n.t.bind(i18n));
    expect(points[0]?.context.eventName).toBeNull();
  });

  it('resolves eventName from tournamentName when eventName is absent', () => {
    const series = buildTrendSeries(
      [makeMatch({ eventName: undefined, tournamentName: 'Genesis 10' })],
      '5',
    );
    const points = buildTrendChartPoints(series, i18n.t.bind(i18n));
    expect(points[0]?.context.eventName).toBe('Genesis 10');
  });

  it('resolves the game number from a parseable externalId, else null', () => {
    const series = buildTrendSeries(
      [
        makeMatch({ id: 'm1', time: 1, externalId: 'sgg:123:g2' }),
        makeMatch({ id: 'm2', time: 2, externalId: undefined }),
      ],
      '5',
    );
    const points = buildTrendChartPoints(series, i18n.t.bind(i18n));
    expect(points[0]?.context.gameNumber).toBe(2);
    expect(points[1]?.context.gameNumber).toBeNull();
  });
});

/**
 * `MatchupChart` reads `setSelectedMatchIds` off `MatchupsContext` (D-07,
 * CHRT-02) to wire its click-to-select handler, so every render needs a
 * provider — this fixture mirrors the shape `MatchupsPage` supplies in
 * production, plus a real anchor element so the scroll assertion has a
 * target under jsdom.
 */
function renderChart(
  matches: Match[],
  props: { width?: number; height?: number } = {},
  contextOverrides: Partial<MatchupsContextValue> = {},
) {
  const setSelectedMatchIds = vi.fn();
  const contextValue: MatchupsContextValue = {
    fighterSprites: [],
    fighter: undefined,
    setFighter: vi.fn(),
    opponent: undefined,
    setOpponent: vi.fn(),
    fighterUsageById: new Map(),
    opponentUsage: [],
    selectedMatchIds: null,
    setSelectedMatchIds,
    ...contextOverrides,
  };

  const utils = render(
    <MatchupsContext.Provider value={contextValue}>
      <div id={MATCHUP_TABLE_ANCHOR_ID} />
      <MatchupChart matchupMatches={matches} {...props} />
    </MatchupsContext.Provider>,
  );

  return { ...utils, setSelectedMatchIds };
}

describe('MatchupChart', () => {
  it('defaults to the rolling-5 window', () => {
    renderChart(sequence([true, false]), { width: 640, height: 288 });
    expect(screen.getByLabelText('Trend window')).toHaveTextContent('Rolling 5');
  });

  it('switches to rolling-10 and cumulative via the selector', async () => {
    const user = userEvent.setup();
    renderChart(sequence([true, false, true]), { width: 640, height: 288 });

    await user.click(screen.getByLabelText('Trend window'));
    await user.click(await screen.findByRole('option', { name: 'Rolling 10' }));
    expect(screen.getByLabelText('Trend window')).toHaveTextContent('Rolling 10');

    await user.click(screen.getByLabelText('Trend window'));
    await user.click(await screen.findByRole('option', { name: 'Cumulative' }));
    expect(screen.getByLabelText('Trend window')).toHaveTextContent('Cumulative');
  });

  it('renders real SVG marks when mounted with an explicit numeric size', () => {
    const { container } = renderChart(sequence([true, false, true, true, false]), {
      width: 640,
      height: 288,
    });
    // Scoped to the Recharts surface — the Select trigger's chevron-down icon
    // is also an SVG `path`, so an unscoped query would false-positive.
    expect(container.querySelectorAll('svg.recharts-surface path').length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('renders no Recharts surface with no size props — proves the size passthrough is load-bearing, not decorative', () => {
    // Recorded observation (plan 37-01 SUMMARY): with no width/height, the
    // ResponsiveContainer measures 0x0 under jsdom's no-op ResizeObserver
    // stub and Recharts renders no SVG at all — not an empty one. A lucide
    // chevron-down icon `<path>` in the unrelated Select trigger is present
    // either way, so this asserts absence of the Recharts surface itself
    // rather than a raw `path` count.
    const { container } = renderChart(sequence([true, false, true]));
    expect(container.querySelector('svg.recharts-surface')).toBeNull();
  });
});

describe('MatchupChart drill-down (D-07, CHRT-02, plan 37-03)', () => {
  it("clicking a trend point selects that point's match id and scrolls to the results-table anchor", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const matches = sequence([true, false, true]);
    const { container, setSelectedMatchIds } = renderChart(matches, { width: 640, height: 288 });

    const svg = container.querySelector('svg.recharts-surface');
    expect(svg).not.toBeNull();
    if (svg) {
      fireEvent.click(svg, { clientX: 320, clientY: 144 });
    }

    // jsdom's zero-size layout resolves every click to activeTooltipIndex 0
    // (see TrendLine.test.tsx and the 37-01 SUMMARY) — the clicked point is
    // therefore always points[0], whose match id is the first sequenced
    // match ('m0').
    expect(setSelectedMatchIds).toHaveBeenCalledTimes(1);
    expect(setSelectedMatchIds).toHaveBeenCalledWith(new Set([matches[0]?.id]));
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth', block: 'start' }),
    );
  });
});

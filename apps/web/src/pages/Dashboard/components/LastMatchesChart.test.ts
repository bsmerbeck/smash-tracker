import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { chartColors } from '@/lib/chartTheme';
import { DashboardContext, type DashboardContextValue } from '../DashboardContext';
import { LastMatchesChart, buildFormCurveSeries } from './LastMatchesChart';

/**
 * The vitest alias stub for react-chartjs-2 drops every prop, so this file
 * mocks the module locally: the Line records its `data` prop (the Form
 * Curve's colour assertion reads it) and renders the stub's own test id.
 */
type ChartData = { labels: unknown[]; datasets: Array<Record<string, unknown>> };
type TickCallback = (value: unknown, index: number, ticks: unknown[]) => unknown;
type ChartOptionsShape = {
  plugins?: { legend?: { display?: boolean } };
  scales?: {
    x?: {
      grid?: { display?: boolean };
      ticks?: {
        maxRotation?: number;
        minRotation?: number;
        autoSkip?: boolean;
        align?: string;
        callback?: TickCallback;
      };
    };
  };
};
const captured = vi.hoisted(() => ({
  data: null as ChartData | null,
  options: null as ChartOptionsShape | null,
}));

vi.mock('react-chartjs-2', async () => {
  const { createElement: h } = await import('react');
  return {
    Line: (props: { data: ChartData; options: ChartOptionsShape }) => {
      captured.data = props.data;
      captured.options = props.options;
      return h('div', { 'data-testid': 'chartjs-stub', 'data-chart-type': 'line', role: 'img' });
    },
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 25, 12);

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

/** 50 games, one a day ending yesterday, alternating loss / win (chronological). */
const fifty: Match[] = Array.from({ length: 50 }, (_, i) =>
  makeMatch({
    id: `m${String(i).padStart(2, '0')}`,
    time: NOW_MS - (50 - i) * DAY_MS,
    win: i % 2 === 1,
  }),
);

/** 40 games older than 90 days plus 12 inside the last 90 days. */
const mixedAge: Match[] = [
  ...Array.from({ length: 40 }, (_, i) =>
    makeMatch({ id: `old${i}`, time: NOW_MS - (200 + i) * DAY_MS, win: true }),
  ),
  ...Array.from({ length: 12 }, (_, i) =>
    // The three OLDEST in-window games (i = 9..11) are the wins.
    makeMatch({ id: `new${i}`, time: NOW_MS - (10 + i) * DAY_MS, win: i >= 9 }),
  ),
];

/** Two named events; the later one holds 4 games. */
const withEvents: Match[] = [
  ...Array.from({ length: 6 }, (_, i) =>
    makeMatch({ id: `a${i}`, time: NOW_MS - (30 - i) * DAY_MS, win: true, eventName: 'Genesis' }),
  ),
  ...Array.from({ length: 4 }, (_, i) =>
    makeMatch({
      id: `b${i}`,
      time: NOW_MS - (5 - i) * DAY_MS,
      win: i === 0,
      eventName: 'Collision',
    }),
  ),
];

/**
 * Plan 39.1-39 rewrote the FB-10 `buildSeries(matches, window)` cases into
 * their horizon form: the card's own "Window: Last N / Cumulative" select is
 * gone (UI-SPEC §10.4 — never a per-chart control) and the chart plots the
 * page horizon's window (D-06, `resolveWindow({ scoped: false })`) as a
 * running win rate from the window's first game. FB-10's intent — the chosen
 * window LIMITS which games plot, so two windows plot different game sets —
 * survives unchanged.
 */
describe('buildFormCurveSeries (the page horizon picks the plotted games)', () => {
  it('last30 on 50 games plots exactly the last 30, and its last value is the running rate of those 30', () => {
    const series = buildFormCurveSeries(fifty, 'last30', NOW_MS);
    expect(series).toHaveLength(30);
    expect(series.map((p) => p.match.id)).toEqual(fifty.slice(-30).map((m) => m.id));
    const wins = fifty.slice(-30).filter((m) => m.win).length;
    expect(series.at(-1)?.winRate).toBeCloseTo((wins / 30) * 100, 6);
  });

  it('last90 plots only the games inside 90 days of now (12 of 52)', () => {
    const series = buildFormCurveSeries(mixedAge, 'last90', NOW_MS);
    expect(series).toHaveLength(12);
    expect(series.every((p) => p.match.id.startsWith('new'))).toBe(true);
  });

  it("lastEvent plots exactly the last event's games", () => {
    const series = buildFormCurveSeries(withEvents, 'lastEvent', NOW_MS);
    expect(series.map((p) => p.match.id)).toEqual(['b0', 'b1', 'b2', 'b3']);
  });

  it('FB-10 regression, horizon form: two different horizons plot different game sets', () => {
    const last30 = buildFormCurveSeries(mixedAge, 'last30', NOW_MS);
    const last90 = buildFormCurveSeries(mixedAge, 'last90', NOW_MS);
    expect(last30).toHaveLength(30);
    expect(last90).toHaveLength(12);
    expect(last30.map((p) => p.match.id)).not.toEqual(last90.map((p) => p.match.id));
    // The narrower window's games are a trailing subset of the wider one's.
    expect(last30.map((p) => p.match.id)).toEqual(
      expect.arrayContaining(last90.map((p) => p.match.id)),
    );
  });

  it("the running rate starts at the window's first game, never the account's", () => {
    // last90's window opens on three wins even though 40 older wins exist.
    const series = buildFormCurveSeries(mixedAge, 'last90', NOW_MS);
    expect(series[0]?.winRate).toBe(100);
    expect(series.at(-1)?.winRate).toBeCloseTo((3 / 12) * 100, 6);
  });

  it('keeps the unrounded running-rate semantics', () => {
    const two = [
      makeMatch({ id: 'a', time: NOW_MS - 2 * DAY_MS, win: true }),
      makeMatch({ id: 'b', time: NOW_MS - DAY_MS, win: false }),
    ];
    const series = buildFormCurveSeries(two, 'last30', NOW_MS);
    expect(series.map((p) => p.winRate)).toEqual([100, 50]);
  });

  it('a window larger than the history returns every game (no padding, no crash)', () => {
    const three = [
      makeMatch({ id: 'a', time: NOW_MS - 3 * DAY_MS, win: true }),
      makeMatch({ id: 'b', time: NOW_MS - 2 * DAY_MS, win: true }),
      makeMatch({ id: 'c', time: NOW_MS - DAY_MS, win: false }),
    ];
    const series = buildFormCurveSeries(three, 'last30', NOW_MS);
    expect(series).toHaveLength(3);
    expect(series[2]?.winRate).toBeCloseTo(66.6667, 3);
  });

  it('returns an empty series for no games', () => {
    for (const horizon of ['last30', 'lastEvent', 'last90'] as const) {
      expect(buildFormCurveSeries([], horizon, NOW_MS)).toEqual([]);
    }
  });
});

const mario = SpriteList.find((s) => s.id === 1)!;

function renderChart(matches: Match[], horizon: HorizonKey) {
  const value: DashboardContextValue = {
    fighterSprites: [mario],
    fighter: mario,
    setFighter: () => {},
  };
  return render(
    createElement(
      DashboardContext.Provider,
      { value },
      createElement(LastMatchesChart, { matches, horizon }),
    ),
  );
}

describe('LastMatchesChart (UI-SPEC §10.4: no per-card control; the page horizon names the window)', () => {
  const recent = Array.from({ length: 8 }, (_, i) =>
    makeMatch({ id: `r${i}`, time: Date.now() - (i + 1) * DAY_MS, win: i % 2 === 0 }),
  );

  it('renders no select or combobox in the card', () => {
    const { container } = renderChart(recent, 'last30');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.querySelector('select, [data-slot="select-trigger"]')).toBeNull();
    expect(screen.queryByText('Window')).toBeNull();
  });

  it.each([
    ['last30', 'Running win rate · last 30 games'],
    ['last90', 'Running win rate · last 90 days'],
  ] as const)('%s: the caption names the window', (horizon, caption) => {
    const { container } = renderChart(recent, horizon);
    const node = container.querySelector('[data-slot="form-curve-caption"]');
    expect(node?.textContent).toBe(caption);
    expect(screen.getByTestId('chartjs-stub')).toBeInTheDocument();
  });

  it('a 2-game window renders the honest whole-sentence line and no chart', () => {
    const two = recent.slice(0, 2);
    const { container } = renderChart(two, 'last90');
    expect(screen.queryByTestId('chartjs-stub')).toBeNull();
    expect(container.querySelector('[data-slot="form-curve-window-empty"]')?.textContent).toBe(
      'Fewer than 3 games in the last 90 days — the curve needs at least 3.',
    );
  });

  it("DD-11: the Form Curve's single dataset (line and point rings) is the series blue, never brand red", () => {
    captured.data = null;
    renderChart(recent, 'last30');
    expect(captured.data).not.toBeNull();
    expect(captured.data!.datasets).toHaveLength(1);
    const [dataset] = captured.data!.datasets;
    expect(dataset!.borderColor).toBe(chartColors.series);
    expect(dataset!.pointBorderColor).toBe(chartColors.series);
    expect(dataset!.borderColor).not.toBe(chartColors.red);
    expect(dataset!.pointBorderColor).not.toBe(chartColors.red);
    expect(dataset!.label).toBe('Win Rate');
    expect(captured.data!.labels).toHaveLength(recent.length);
  });

  it('keeps the empty-account copy when the fighter has no games', () => {
    renderChart([], 'last30');
    expect(screen.getByText('Submit a match to see the match chart.')).toBeInTheDocument();
    expect(screen.queryByTestId('chartjs-stub')).toBeNull();
  });
});

/**
 * Plan 39.1-50 (orchestrator 2026-09-26; the owner rejected text legends —
 * sketch 001-C / 002-C): no chart.js legend box, horizontal x labels with only
 * the two ends labelled by their games' dates, no vertical grid, and the series
 * named by the caption's series-ink swatch.
 */
describe('LastMatchesChart Form Curve legend and x axis (plan 39.1-50)', () => {
  function shortDate(ms: number): string {
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(ms));
  }
  const spread = Array.from({ length: 6 }, (_, i) =>
    makeMatch({ id: `s${i}`, time: Date.now() - (10 - i) * DAY_MS, win: i % 2 === 0 }),
  );

  it('draws no chart.js legend box', () => {
    captured.options = null;
    renderChart(spread, 'last30');
    expect(captured.options?.plugins?.legend?.display).toBe(false);
  });

  it('keeps the x ticks horizontal, never auto-skipped, aligned inner, with no x grid', () => {
    captured.options = null;
    renderChart(spread, 'last30');
    const x = captured.options?.scales?.x;
    expect(x?.ticks?.maxRotation).toBe(0);
    expect(x?.ticks?.minRotation).toBe(0);
    expect(x?.ticks?.autoSkip).toBe(false);
    expect(x?.ticks?.align).toBe('inner');
    expect(x?.grid?.display).toBe(false);
  });

  it('labels only the two ends, each with its plotted game date', () => {
    captured.options = null;
    renderChart(spread, 'last30');
    const callback = captured.options?.scales?.x?.ticks?.callback;
    expect(typeof callback).toBe('function');
    const ticks = spread.map((_, i) => ({ value: i }));
    const labels = spread.map((_, i) => callback!(i, i, ticks));
    expect(labels[0]).toBe(shortDate(spread[0]!.time));
    expect(labels.at(-1)).toBe(shortDate(spread.at(-1)!.time));
    for (const label of labels.slice(1, -1)) expect(label).toBe('');
  });

  it('labels only the right end when the first and last games share a calendar day', () => {
    const base = Date.UTC(2026, 3, 10, 9);
    const sameDay = Array.from({ length: 4 }, (_, i) =>
      makeMatch({ id: `d${i}`, time: base + i * 60 * 60 * 1000, win: true }),
    );
    captured.options = null;
    renderChart(sameDay, 'last30');
    const callback = captured.options?.scales?.x?.ticks?.callback;
    const ticks = sameDay.map((_, i) => ({ value: i }));
    expect(callback!(0, 0, ticks)).toBe('');
    expect(callback!(3, 3, ticks)).toBe(shortDate(sameDay[3]!.time));
  });

  it('names the series with an aria-hidden series-ink swatch before the unchanged caption text', () => {
    const { container } = renderChart(spread, 'last30');
    const caption = container.querySelector('[data-slot="form-curve-caption"]');
    const swatch = caption?.querySelector('[data-slot="form-curve-swatch"]');
    expect(swatch).not.toBeNull();
    expect(swatch).toHaveAttribute('aria-hidden', 'true');
    expect(caption?.firstElementChild).toBe(swatch);
    expect((swatch as HTMLElement).style.backgroundColor).toBe('rgb(49, 134, 233)');
    expect(caption?.textContent).toBe('Running win rate · last 30 games');
  });
});

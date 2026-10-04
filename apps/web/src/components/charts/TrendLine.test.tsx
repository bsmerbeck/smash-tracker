import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  TrendLine,
  type TrendChartPoint,
  type TrendEventPoint,
  type TrendLinePeriodLabels,
  type TrendLineValueProps,
  type TrendValuePoint,
} from './TrendLine';
import { ChartCard } from './ChartCard';
import { ChartTooltip } from './ChartTooltip';
import { formatEventTickLabel } from './eventTicks';
import {
  estimateTickLabelWidthPx,
  formatPeriodRowLabel,
  selectPeriodTickLayout,
} from './periodTicks';
import type { PeriodPoint } from '@smash-tracker/shared';
import { PERIOD_TREND_MIN_PERIODS, buildValueSeries } from '@smash-tracker/shared';
import type { ValueSeries, ValueSeriesReading } from '@smash-tracker/shared';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function makePoint(overrides: Partial<TrendChartPoint> = {}): TrendChartPoint {
  return {
    index: 1,
    winRate: 50,
    context: {
      matchId: 'm1',
      opponentTag: 'rival',
      stageName: 'Battlefield',
      eventName: null,
      dateMs: 1000,
      win: true,
      gameNumber: null,
    },
    ...overrides,
  };
}

/** `eventKey` deliberately mirrors `eventSeries.ts`'s composite `${kind}:${name}:${startMs}` encoding — comfortably longer than `MAX_EVENT_TICK_LABEL_LENGTH`, per plan 38-01's OPP-03 encoding truth, so every fixture here actually exercises the tick-label truncation rather than accidentally staying under it. */
function makeEventPoint(overrides: Partial<TrendEventPoint> = {}): TrendEventPoint {
  return {
    eventKey: 'tournament:genesis-ten-major-bracket:1700000000000',
    cumulativeWinRate: 50,
    wins: 2,
    losses: 1,
    context: {
      opponentTag: 'rival',
      eventLabel: 'Genesis Ten Major Bracket',
      dateMs: 1700000000000,
    },
    ...overrides,
  };
}

function eventKeysFor(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `tournament:genesis-round-robin-block-${i}:${1700000000000 + i}`,
  );
}

/**
 * Scoped to `.recharts-xAxis-tick-labels` (confirmed against a real render —
 * the tick VALUE `<text>` elements live inside a `recharts-xAxis-tick-labels`
 * wrapper portaled to its own z-index layer, a sibling of, not a descendant
 * of, `.recharts-xAxis-ticks`, which itself only wraps the tick LINES). The
 * unscoped `.recharts-cartesian-axis-tick-value` class also matches the
 * Y-axis's own numeric ticks (0/25/50/75/100), which would corrupt this
 * assertion.
 */
function renderedTickTexts(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value'),
  ).map((el) => el.textContent ?? '');
}

describe('TrendLine', () => {
  it('renders at least one path and exactly three dots for three points at an explicit size', () => {
    const points = [
      makePoint({ index: 1, winRate: 40 }),
      makePoint({ index: 2, winRate: 60 }),
      makePoint({ index: 3, winRate: 80 }),
    ];
    const { container } = render(<TrendLine points={points} width={640} height={288} />);
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
  });

  it('renders nothing (firstChild null) for an empty point array', () => {
    const { container } = render(<TrendLine points={[]} width={640} height={288} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders zero path elements when no explicit size is given (jsdom responsive-wrapper probe)', () => {
    const points = [makePoint()];
    const { container } = render(<TrendLine points={points} />);
    expect(container.querySelectorAll('path').length).toBe(0);
  });

  it('invokes onSelectPoint with a real TrendChartPoint read via activeTooltipIndex on container click', () => {
    // jsdom's zero-size layout means recharts' pointer->index resolution
    // always lands on index 0 here regardless of clientX/clientY — this
    // test locks the OBSERVED shape (activeTooltipIndex, not the recharts-2
    // `activePayload` field, which does not exist on this version's
    // `MouseHandlerDataParam`) rather than a specific click-to-index mapping,
    // which real-layout browser behavior (not exercised under jsdom) governs.
    const points = [makePoint({ index: 1, winRate: 40 }), makePoint({ index: 2, winRate: 60 })];
    const onSelectPoint = vi.fn();
    const { container } = render(
      <TrendLine points={points} width={640} height={288} onSelectPoint={onSelectPoint} />,
    );
    const svg = container.querySelector('svg.recharts-surface');
    expect(svg).not.toBeNull();
    if (svg) {
      fireEvent.click(svg, { clientX: 320, clientY: 144 });
    }
    expect(onSelectPoint).toHaveBeenCalledTimes(1);
    expect(onSelectPoint).toHaveBeenCalledWith(points[0]);
  });
});

/**
 * Plan 39.1-37 (human-event-axis): the new periodTicks exports are read
 * through the module namespace so the RED run fails on an assertion.
 */
type EventAnchorTickPoint = { eventKey: string; eventLabel: string; dateMs: number };

async function loadEventAnchorFormatter(): Promise<
  (point: EventAnchorTickPoint, locale: string) => string
> {
  const mod = (await import('./periodTicks')) as Record<string, unknown>;
  expect(typeof mod.formatEventAnchorTickLabel, 'formatEventAnchorTickLabel is exported').toBe(
    'function',
  );
  return mod.formatEventAnchorTickLabel as (point: EventAnchorTickPoint, locale: string) => string;
}

async function loadEventAnchorLayout(): Promise<
  (
    points: EventAnchorTickPoint[],
    opts: { plotWidthPx: number; locale: string },
  ) => { key: string; label: string }[]
> {
  const mod = (await import('./periodTicks')) as Record<string, unknown>;
  expect(typeof mod.selectEventAnchorTickLayout, 'selectEventAnchorTickLayout is exported').toBe(
    'function',
  );
  return mod.selectEventAnchorTickLayout as (
    points: EventAnchorTickPoint[],
    opts: { plotWidthPx: number; locale: string },
  ) => { key: string; label: string }[];
}

/** A 640px event chart's category band: 640 - 2 x 5 margin - 60 y-axis - 2 x 16 edge padding. */
const EVENT_PLOT_WIDTH_AT_640 = 640 - 10 - 60 - 32;

describe('TrendLine — event mode', () => {
  it('renders exactly one path and one dot per point for three anchors at an explicit size', () => {
    const points = [
      makeEventPoint({ eventKey: eventKeysFor(3)[0], wins: 2, losses: 0 }),
      makeEventPoint({ eventKey: eventKeysFor(3)[1], wins: 1, losses: 1 }),
      makeEventPoint({ eventKey: eventKeysFor(3)[2], wins: 0, losses: 2 }),
    ];
    const { container } = render(
      <TrendLine mode="event" points={points} width={640} height={288} />,
    );
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
  });

  it('renders nothing (firstChild null) for an empty anchor array', () => {
    const { container } = render(<TrendLine mode="event" points={[]} width={640} height={288} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders zero path elements when no explicit size is given (jsdom responsive-wrapper probe)', () => {
    const points = [makeEventPoint()];
    const { container } = render(<TrendLine mode="event" points={points} />);
    expect(container.querySelectorAll('path').length).toBe(0);
  });

  it('SPARSE (four anchors or fewer): every anchor HUMAN label (formatEventAnchorTickLabel — plan 39.1-37, never the engine key) appears among the rendered tick texts, and each point shows its own W-L', async () => {
    // Plan 39.1-37 rewrite: this case used to expect `formatEventTickLabel(key)`
    // — the truncated ENGINE KEY — as the tick text (design-audit item 5's
    // "session::170…" axis). The contract is now the anchor's human label.
    const format = await loadEventAnchorFormatter();
    const keys = eventKeysFor(4);
    const points = keys.map((eventKey, i) =>
      makeEventPoint({
        eventKey,
        wins: i,
        losses: 1,
        context: { ...makeEventPoint().context, eventLabel: `Weekly ${i}` },
      }),
    );
    const { container } = render(
      <TrendLine mode="event" points={points} width={640} height={288} />,
    );
    const tickTexts = renderedTickTexts(container);
    for (const point of points) {
      expect(tickTexts).toContain(
        format(
          {
            eventKey: point.eventKey,
            eventLabel: point.context.eventLabel,
            dateMs: point.context.dateMs,
          },
          'en',
        ),
      );
      expect(tickTexts).not.toContain(formatEventTickLabel(point.eventKey));
    }
    expect(container.querySelectorAll('circle')).toHaveLength(4);
    // The on-chart per-point label is a bare wins-en-dash-losses pair (D-11/ADV-02 spirit,
    // opponents.hub.trend.pointLabel — en dash per the 38-UI-SPEC Copywriting Contract).
    expect(container.textContent).toContain('0–1');
    expect(container.textContent).toContain('3–1');
  });

  it('DENSE (thirty anchors): the rendered tick labels equal the event-anchor tick layout for the same points and plot width — strictly fewer than thirty — while thirty dots still render', async () => {
    // Plan 39.1-37 rewrite: this case used to expect `selectEventTicks(keys,
    // 640)` mapped through `formatEventTickLabel` (the engine key). The tick
    // set is now the width-aware layout over the anchors' human labels.
    const layoutFor = await loadEventAnchorLayout();
    const keys = eventKeysFor(30);
    const points = keys.map((eventKey, i) =>
      makeEventPoint({
        eventKey,
        context: { ...makeEventPoint().context, eventLabel: `W${i}`, dateMs: 1700000000000 + i },
      }),
    );
    const { container } = render(
      <TrendLine mode="event" points={points} width={640} height={288} />,
    );
    const expectedLabels = layoutFor(
      points.map((point) => ({
        eventKey: point.eventKey,
        eventLabel: point.context.eventLabel,
        dateMs: point.context.dateMs,
      })),
      { plotWidthPx: EVENT_PLOT_WIDTH_AT_640, locale: 'en' },
    ).map((tick) => tick.label);
    const tickTexts = renderedTickTexts(container);

    expect(expectedLabels.length).toBeLessThan(keys.length);
    expect(tickTexts).toEqual(expectedLabels);
    expect(tickTexts[0]).toBe('W0');
    expect(tickTexts[tickTexts.length - 1]).toBe('W29');
    expect(container.querySelectorAll('circle')).toHaveLength(30);
  });

  it('a container click resolves the anchor at the active tooltip index and hands the whole point to the callback', () => {
    const points = [
      makeEventPoint({ eventKey: eventKeysFor(2)[0] }),
      makeEventPoint({ eventKey: eventKeysFor(2)[1] }),
    ];
    const onSelectPoint = vi.fn();
    const { container } = render(
      <TrendLine
        mode="event"
        points={points}
        width={640}
        height={288}
        onSelectPoint={onSelectPoint}
      />,
    );
    const svg = container.querySelector('svg.recharts-surface');
    expect(svg).not.toBeNull();
    if (svg) {
      fireEvent.click(svg, { clientX: 320, clientY: 144 });
    }
    expect(onSelectPoint).toHaveBeenCalledTimes(1);
    expect(onSelectPoint).toHaveBeenCalledWith(points[0]);
  });

  it('a single anchor renders one dot and no line-to or curve-to segment on the series curve', () => {
    // Verified against a real render (`container.innerHTML` dump, kept out of
    // the committed test): with exactly one data point recharts 3.10.1
    // renders `<g class="recharts-layer recharts-line">` EMPTY — no
    // `.recharts-line-curve` element at all, not a degenerate one — while
    // `recharts-line-dots` still renders the single `<circle>`. The assertion
    // below holds under either shape (`d` defaults to the empty string, which
    // trivially contains neither `L` nor `C`), so it proves "no line segment"
    // without presupposing which of the two the installed version chooses.
    const points = [makeEventPoint()];
    const { container } = render(
      <TrendLine mode="event" points={points} width={640} height={288} />,
    );
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    const curve = container.querySelector('.recharts-line-curve');
    const d = curve?.getAttribute('d') ?? '';
    expect(d).not.toMatch(/[LC]/);
  });
});

function renderTooltip(overrides: { active?: boolean; payload?: { payload?: unknown }[] } = {}) {
  return render(<ChartTooltip active={true} payload={[]} {...overrides} />);
}

function tooltipPayload(point: TrendChartPoint | TrendEventPoint) {
  return [{ payload: point }];
}

describe('ChartTooltip', () => {
  it('renders nothing when Recharts reports it inactive', () => {
    const { container } = renderTooltip({ active: false, payload: tooltipPayload(makePoint()) });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the payload is empty', () => {
    const { container } = renderTooltip({ active: true, payload: [] });
    expect(container.firstChild).toBeNull();
  });

  it('renders the win rate rounded to a whole percent in the emphasized value row', () => {
    const point = makePoint({ winRate: 66.6666 });
    const { getByText, queryByText } = renderTooltip({ payload: tooltipPayload(point) });
    expect(getByText('67%')).toBeInTheDocument();
    expect(queryByText('66.6666%')).not.toBeInTheDocument();
  });

  it('renders the opponent tag and the stage name on one muted row', () => {
    const point = makePoint({
      context: {
        ...makePoint().context,
        opponentTag: 'sparg0',
        stageName: 'Pokémon Stadium 2',
      },
    });
    const { getByText } = renderTooltip({ payload: tooltipPayload(point) });
    expect(getByText('sparg0 on Pokémon Stadium 2')).toBeInTheDocument();
  });

  it('renders the event-and-date row when the context carries an event name, the date-only row when it does not', () => {
    const withEvent = makePoint({
      context: { ...makePoint().context, eventName: 'Genesis 10', dateMs: 1700000000000 },
    });
    const { getByText: getByTextWithEvent } = renderTooltip({ payload: tooltipPayload(withEvent) });
    const expectedDate = new Date(1700000000000).toLocaleDateString('en');
    expect(getByTextWithEvent(`Genesis 10 · ${expectedDate}`)).toBeInTheDocument();

    const withoutEvent = makePoint({
      context: { ...makePoint().context, eventName: null, dateMs: 1700000000000 },
    });
    const { getByText: getByTextNoEvent, queryByText } = renderTooltip({
      payload: tooltipPayload(withoutEvent),
    });
    expect(getByTextNoEvent(expectedDate)).toBeInTheDocument();
    expect(queryByText(/·\s*$/)).not.toBeInTheDocument();
  });

  it('renders the result with the game number when present, the result alone (never a placeholder dash) when absent', () => {
    const withGame = makePoint({ context: { ...makePoint().context, win: true, gameNumber: 3 } });
    const { getByText } = renderTooltip({ payload: tooltipPayload(withGame) });
    expect(getByText('Win (Game 3)')).toBeInTheDocument();

    const withoutGame = makePoint({
      context: { ...makePoint().context, win: false, gameNumber: null },
    });
    const { getByText: getByTextNoGame, queryByText } = renderTooltip({
      payload: tooltipPayload(withoutGame),
    });
    expect(getByTextNoGame('Loss')).toBeInTheDocument();
    expect(queryByText(/\(.*-.*\)/)).not.toBeInTheDocument();
  });

  it('event mode: shows the cumulative rate, the full untruncated event name in the opponent-at-event row, the date row and an event-scoped score row', () => {
    const point = makeEventPoint({
      cumulativeWinRate: 66.6666,
      wins: 2,
      losses: 1,
      context: {
        opponentTag: 'sparg0',
        eventLabel: 'A Deliberately Long Tournament Name That Should Never Be Truncated Here',
        dateMs: 1700000000000,
      },
    });
    const { getByText, queryByText } = renderTooltip({ payload: tooltipPayload(point) });
    expect(getByText('67%')).toBeInTheDocument();
    expect(queryByText('66.6666%')).not.toBeInTheDocument();
    expect(
      getByText(
        'sparg0 at A Deliberately Long Tournament Name That Should Never Be Truncated Here',
      ),
    ).toBeInTheDocument();
    const expectedDate = new Date(1700000000000).toLocaleDateString('en');
    expect(getByText(expectedDate)).toBeInTheDocument();
    expect(getByText('2–1 this event')).toBeInTheDocument();
  });
});

function makePeriodPoint(overrides: Partial<PeriodPoint> = {}): PeriodPoint {
  return {
    grain: 'week',
    key: 'week:2024-W01',
    label: '2024-W01',
    startMs: 0,
    endMs: 999,
    wins: 3,
    losses: 2,
    total: 5,
    rate: 0.6,
    subFloor: false,
    matchIds: [],
    ...overrides,
  };
}

/** 8 points (at the `PERIOD_TREND_MIN_PERIODS` floor), evenly spaced 1000ms apart, all above the abstention floor with equal rates unless overridden per-index. */
function makePeriodSeries(
  count: number,
  perIndex: (i: number) => Partial<PeriodPoint> = () => ({}),
): PeriodPoint[] {
  return Array.from({ length: count }, (_, i) =>
    makePeriodPoint({
      key: `week:2024-W${String(i).padStart(2, '0')}`,
      label: `2024-W${String(i).padStart(2, '0')}`,
      startMs: i * 1000,
      endMs: i * 1000 + 999,
      ...perIndex(i),
    }),
  );
}

// REWRITTEN by plan 39.1-43 (was two fixed strings): the locked labels are
// formatters of the kit's { need, have } counts (PD-43-1).
const PERIOD_LABELS: TrendLinePeriodLabels = {
  lockedSentence: ({ need }) => `${need} more weeks with 3+ games unlock this chart.`,
  lockedCountLabel: ({ have }) => `${have} of 8 weeks`,
  tableToggle: 'View as table',
  tableHeaders: { period: 'Period', record: 'Record', rate: 'Rate', sample: 'Sample' },
};

describe('TrendLine — period mode (VIZ-01, VIZ-03, UI-SPEC §7.13)', () => {
  it('renders one hollow dot per sub-floor point (fill=surface, stroke=deemphasis) and one filled dot per normal point (fill=series1, stroke=surface)', () => {
    // REWRITTEN by plan 39.1-43 (PD-43-1): 8 points with sub-floor periods now
    // lock (fewer than 8 at the floor), so the series gains at-floor points to
    // keep exercising the DRAWN plot this case pins.
    const points = makePeriodSeries(10, (i) =>
      i === 3 || i === 4 ? { subFloor: true, total: 2, rate: 0.2 } : { rate: 0.5 },
    );
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const circles = Array.from(container.querySelectorAll('circle'));
    expect(circles).toHaveLength(10);
    circles.forEach((circle, i) => {
      const isHollow = i === 3 || i === 4;
      expect(circle.getAttribute('fill')).toBe(isHollow ? 'var(--card)' : 'var(--viz-series-1)');
      expect(circle.getAttribute('stroke')).toBe(isHollow ? 'var(--viz-context)' : 'var(--card)');
    });
  });

  it('two adjacent sub-floor points render NO line segment between them or to their neighbors — the stroke line breaks into two disjoint runs', () => {
    // REWRITTEN by plan 39.1-43 (PD-43-1): 8 points with sub-floor periods now
    // lock (fewer than 8 at the floor), so the series gains at-floor points to
    // keep exercising the DRAWN plot this case pins.
    const points = makePeriodSeries(10, (i) =>
      i === 3 || i === 4 ? { subFloor: true, total: 2, rate: 0.2 } : { rate: 0.5 },
    );
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const strokeLine = container.querySelector('.trend-line-period-line .recharts-line-curve');
    expect(strokeLine).not.toBeNull();
    const d = strokeLine!.getAttribute('d') ?? '';
    // Two disjoint runs (indices 0-2 and 5-9) — exactly 2 "M" (move-to, one
    // per run) and exactly 6 "L" (line-to: 2 + 4 segments). A bug that
    // connected across the gap would produce 1 "M" and 9 "L" instead.
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d.match(/L/g)).toHaveLength(6);
  });

  it('a fully-connected series (no sub-floor points) renders one unbroken run — sanity check for the gap mechanism above', () => {
    const points = makePeriodSeries(8, () => ({ rate: 0.5 }));
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const strokeLine = container.querySelector('.trend-line-period-line .recharts-line-curve');
    const d = strokeLine!.getAttribute('d') ?? '';
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.match(/L/g)).toHaveLength(7);
  });

  it('draws exactly one mark per series point — never a synthetic mark for a period absent from the series (a calendar gap is not padded)', () => {
    // Weeks 0,1,2,5,8,9,10,11 — a real calendar gap (weeks 3,4,6,7 missing)
    // that the engine never emitted a point for.
    const weekIndices = [0, 1, 2, 5, 8, 9, 10, 11];
    const points = weekIndices.map((week, i) =>
      makePeriodPoint({
        key: `week:2024-W${week}`,
        label: `2024-W${week}`,
        startMs: week * 1000,
        endMs: week * 1000 + 999,
        rate: 0.4 + i * 0.01,
      }),
    );
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    expect(container.querySelectorAll('circle')).toHaveLength(points.length);
  });

  it('direct value labels render on exactly the last, maximum and minimum points; a MAX tie keeps the earlier period, never duplicating the label', () => {
    // rates: [.5, .9, .3, .9, .6, .7, .4, .2] — max .9 ties at index 1 and 3
    // (index 1 must win); min .2 is unique at index 7 (which is also last).
    const rates = [0.5, 0.9, 0.3, 0.9, 0.6, 0.7, 0.4, 0.2];
    const points = makePeriodSeries(8, (i) => ({ rate: rates[i] }));
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const percentLabels = Array.from(container.querySelectorAll('text'))
      .map((el) => el.textContent ?? '')
      .filter((text) => /^\d+%$/.test(text));
    expect(percentLabels.sort()).toEqual(['20%', '90%']);
    // Exactly one "90%" label exists — the tied index 3 does not also render one.
    expect(percentLabels.filter((text) => text === '90%')).toHaveLength(1);
  });

  it('the emphasis band left edge snaps to the period containing the window start, and its rendered width is at least 4px', () => {
    const points = makePeriodSeries(8, () => ({ rate: 0.5 }));
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        width={640}
        height={288}
        labels={PERIOD_LABELS}
        emphasisStartMs={points[5]!.startMs}
      />,
    );
    const band = container.querySelector('.recharts-reference-area-rect');
    expect(band).not.toBeNull();
    expect(band!.getAttribute('x1')).toBe(points[5]!.key);
    expect(band!.getAttribute('x2')).toBe(points[7]!.key);
    const width = Number(band!.getAttribute('width'));
    expect(width).toBeGreaterThanOrEqual(4);
  });

  it('below PERIOD_TREND_MIN_PERIODS the plot is absent and the locked inset with a meter is present, using the host-supplied sentence', () => {
    const points = makePeriodSeries(PERIOD_TREND_MIN_PERIODS - 1);
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    expect(container.querySelector('svg')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="trend-line-period-locked"]')).toBeInTheDocument();
    // Plan 39.1-43: 7 points at the floor -> need 1 / have 7, through the formatters.
    expect(
      screen.getByText(PERIOD_LABELS.lockedSentence({ need: 1, have: 7 })),
    ).toBeInTheDocument();
    expect(container.querySelector('[role="img"]')).toHaveAttribute(
      'aria-label',
      PERIOD_LABELS.lockedCountLabel({ need: 1, have: 7 }),
    );
  });

  it('an empty period series (0 points) also renders the locked inset, never a bare null', () => {
    const { container } = render(
      <TrendLine mode="period" points={[]} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    expect(container.querySelector('svg')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="trend-line-period-locked"]')).toBeInTheDocument();
  });

  it('the table twin is a real keyboard-reachable button (native <button>) whose row count and cell values equal the series points', () => {
    const points = makePeriodSeries(8, (i) => ({
      wins: i,
      losses: 8 - i,
      total: 8,
      rate: i / 8,
    }));
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const toggle = screen.getByRole('button', { name: PERIOD_LABELS.tableToggle });
    expect(toggle.tagName).toBe('BUTTON');
    expect(container.querySelector('table')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const rows = table!.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(points.length);
    rows.forEach((row, i) => {
      const point = points[i]!;
      const cells = row.querySelectorAll('td');
      // Plan 39.1-30: the row label now goes through `formatPeriodRowLabel`
      // (the same period-ticks module the axis reads), not the engine's raw
      // `point.label` directly — byte-identical here since these fixture
      // points are week-grain (formatPeriodRowLabel keeps a week/quarter/
      // year point's engine label unchanged), but the CONTRACT is now the
      // formatter, not the raw field, so a future non-date-shaped label
      // change here is caught by this module's own tests, not silently
      // absorbed by an assertion that duplicated the raw value.
      expect(cells[0]?.textContent).toBe(formatPeriodRowLabel(point, 'en'));
      expect(cells[1]?.textContent).toBe(`${point.wins}–${point.losses}`);
      expect(cells[2]?.textContent).toBe(`${Math.round(point.rate * 100)}%`);
      expect(cells[3]?.textContent).toBe(String(point.total));
    });
    const headers = table!.querySelectorAll('thead th');
    expect(Array.from(headers).map((h) => h.textContent)).toEqual([
      PERIOD_LABELS.tableHeaders.period,
      PERIOD_LABELS.tableHeaders.record,
      PERIOD_LABELS.tableHeaders.rate,
      PERIOD_LABELS.tableHeaders.sample,
    ]);
  });

  it('a click resolves the period at the active tooltip index and hands the whole PeriodPoint to the callback', () => {
    const points = makePeriodSeries(8, () => ({ rate: 0.5 }));
    const onSelectPoint = vi.fn();
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        width={640}
        height={288}
        labels={PERIOD_LABELS}
        onSelectPoint={onSelectPoint}
      />,
    );
    const svg = container.querySelector('svg.recharts-surface');
    expect(svg).not.toBeNull();
    fireEvent.click(svg!, { clientX: 320, clientY: 144 });
    expect(onSelectPoint).toHaveBeenCalledTimes(1);
    expect(onSelectPoint).toHaveBeenCalledWith(points[0]);
  });

  it('TrendLine.tsx imports nothing from the shared engine but the period TYPE and the one declared threshold — no bucketing/grouping/windowing code appears anywhere in the file', () => {
    // Plan 39.1-30: `PeriodGrain` dropped from this assertion (and from the
    // file's own import) — the grain-rule tick selection that was the ONLY
    // reader of that type moved out to `periodTicks.ts` wholesale (action E),
    // so `TrendLine.tsx` no longer has any legitimate reference to it; kept
    // here would be a dead import failing `pnpm lint`'s no-unused-vars gate.
    // `PeriodPoint` stays — the chart still consumes `PeriodPoint[]` directly.
    const filePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'TrendLine.tsx');
    const source = fs.readFileSync(filePath, 'utf8');
    const sharedImportLines = source
      .split('\n')
      .filter((line) => line.includes("from '@smash-tracker/shared'"));
    expect(sharedImportLines).toHaveLength(2);
    expect(sharedImportLines.join('\n')).toMatch(/PeriodPoint/);
    expect(sharedImportLines.join('\n')).toMatch(/PERIOD_TREND_MIN_PERIODS/);
    expect(sharedImportLines.join('\n')).not.toMatch(/buildPeriodSeries|regrainFor/);
    // No date-bucketing helper of the kind periodSeries.ts owns.
    expect(source).not.toMatch(
      /isoWeekKey|monthKey|quarterKey|yearKey|splitIntoSessions|buildSetTimeline|buildEventSessionPoints/,
    );
  });

  it('does not truncate or resample a longer-than-typical series — it renders exactly what it is given', () => {
    const points = makePeriodSeries(60, (i) => ({ rate: (i % 10) / 10 }));
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    expect(container.querySelectorAll('circle')).toHaveLength(60);
  });
});

/** 8 daily game-grain points with ISO engine labels — the shape a small account's period series actually takes (`periodSeries.ts` `buildGamePoints`). */
function makeGamePeriodSeries(count: number): PeriodPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const startMs = Date.UTC(2023, 10, 1 + i);
    return makePeriodPoint({
      grain: 'game',
      key: `game:${i}`,
      label: new Date(startMs).toISOString(),
      startMs,
      endMs: startMs + 1,
      rate: 0.5,
    });
  });
}

describe('TrendLine — period mode axis (plan 39.1-30, UI-SPEC §7.13/§11)', () => {
  it('no rendered x-tick text is a raw ISO timestamp', () => {
    const points = makeGamePeriodSeries(8);
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const tickTexts = Array.from(
      container.querySelectorAll('.recharts-xAxis-tick-labels text'),
    ).map((el) => el.textContent ?? '');
    expect(tickTexts.length).toBeGreaterThan(0);
    for (const text of tickTexts) {
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('the first rendered x tick is start-anchored and the last is end-anchored', () => {
    const points = makeGamePeriodSeries(8);
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const ticks = Array.from(container.querySelectorAll('.recharts-xAxis-tick-labels text'));
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    const sorted = [...ticks].sort(
      (a, b) => Number(a.getAttribute('x')) - Number(b.getAttribute('x')),
    );
    expect(sorted[0]!.getAttribute('text-anchor')).toBe('start');
    expect(sorted[sorted.length - 1]!.getAttribute('text-anchor')).toBe('end');
  });

  it('CR-01: every rendered tick takes its text, x and text-anchor from selectPeriodTickLayout — never a second derivation', () => {
    // game grain, n=10 at an 829px plot — one of the review's reproduced
    // overlap cases (the old renderer re-derived anchors from the selected
    // set and drew a middle tick into the appended final one).
    const points = Array.from({ length: 10 }, (_, i) => {
      const startMs = Date.UTC(2023, 10, 1 + i, 12);
      return makePeriodPoint({
        grain: 'game',
        key: `game:${i}`,
        label: new Date(startMs).toISOString(),
        startMs,
        endMs: startMs + 1,
        rate: 0.5,
      });
    });
    // REWRITTEN by plan 39.1-43b (sketch `.trend.gutter`): the period chart
    // has no left margin and a 26px y-axis gutter (was a 5px margin + a 60px
    // axis); the right margin stays 5px.
    const chartMargin = 5;
    const yAxisGutter = 26;
    const xPadding = 16;
    const plotWidthPx = 829;
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        width={plotWidthPx + chartMargin + yAxisGutter + xPadding * 2}
        height={288}
        labels={PERIOD_LABELS}
      />,
    );
    const rendered = Array.from(container.querySelectorAll('.recharts-xAxis-tick-labels text'))
      .map((el) => ({
        x: Number(el.getAttribute('x')),
        label: el.textContent ?? '',
        anchor: el.getAttribute('text-anchor'),
      }))
      .sort((a, b) => a.x - b.x);
    const layout = selectPeriodTickLayout(points, { plotWidthPx, locale: 'en' });
    expect(rendered.map(({ label, anchor }) => ({ label, anchor }))).toEqual(
      layout.map(({ label, anchor }) => ({ label, anchor })),
    );
    rendered.forEach((tick, j) => {
      expect(tick.x).toBeCloseTo(layout[j]!.x + yAxisGutter + xPadding, 0);
    });
  });

  it('every period circle carries data-slot "trend-period-dot" and every direct value label carries data-slot "trend-period-value-label"', () => {
    const points = makeGamePeriodSeries(8);
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const circles = Array.from(container.querySelectorAll('circle'));
    expect(circles.length).toBe(8);
    for (const circle of circles) {
      expect(circle.getAttribute('data-slot')).toBe('trend-period-dot');
    }
    const valueLabels = Array.from(
      container.querySelectorAll('[data-slot="trend-period-value-label"]'),
    );
    expect(valueLabels.length).toBeGreaterThan(0);
  });
});

/** A 640-wide trend's y tick texts (numbers only). */
function renderedYTickValues(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text')).map((el) =>
    Number(el.textContent ?? 'NaN'),
  );
}

function renderedValueLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot="trend-period-value-label"]')).map(
    (el) => el.textContent ?? '',
  );
}

const PERIOD_LABELS_WITH_REFERENCE: TrendLinePeriodLabels = {
  ...PERIOD_LABELS,
  referenceLabel: '55%',
};

describe('TrendLine — period mode fitted to its real range (plan 39.1-37, fitted-period-trend)', () => {
  /** Joined periods between 45% and 60%, and one sub-floor 0% period last. */
  // REWRITTEN by plan 39.1-43 (PD-43-1): was 7 joined + 1 sub-floor (8
  // points), which now locks; a 50% joined period is PREPENDED so 8 reach the
  // floor and the sub-floor 0% period stays last (index 8).
  function joinedWithSubFloorZero(): PeriodPoint[] {
    const joined = [0.5, 0.45, 0.5, 0.55, 0.6, 0.52, 0.48, 0.58];
    return makePeriodSeries(9, (i) =>
      i === 8
        ? { subFloor: true, wins: 0, losses: 2, total: 2, rate: 0 }
        : { rate: joined[i], total: 20 },
    );
  }

  it('fits the y-domain to the joined periods and the reference rate — a sub-floor 0% period never stretches it to 0', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={joinedWithSubFloorZero()}
        referenceRate={50}
        width={640}
        height={288}
        labels={PERIOD_LABELS}
      />,
    );
    const ticks = renderedYTickValues(container);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(30);
      expect(tick).toBeLessThanOrEqual(70);
    }
  });

  it('pins an off-domain sub-floor dot to the bottom edge (hollow, data-pinned="bottom") and keeps its true rate in the table twin', () => {
    const points = joinedWithSubFloorZero();
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        referenceRate={50}
        width={640}
        height={288}
        labels={PERIOD_LABELS}
      />,
    );
    const circles = Array.from(container.querySelectorAll('circle'));
    expect(circles).toHaveLength(9);
    const pinned = circles[8]!;
    expect(pinned.getAttribute('data-pinned')).toBe('bottom');
    expect(pinned.getAttribute('fill')).toBe('var(--card)');
    expect(pinned.getAttribute('stroke')).toBe('var(--viz-context)');
    const bottomTick = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text'))
      .map((el) => ({ value: Number(el.textContent), y: Number(el.getAttribute('y')) }))
      .sort((a, b) => a.value - b.value)[0]!;
    expect(Number(pinned.getAttribute('cy'))).toBeCloseTo(bottomTick.y, 0);
    for (const circle of circles.slice(0, 8)) {
      expect(circle.getAttribute('data-pinned')).toBeNull();
    }

    fireEvent.click(screen.getByRole('button', { name: PERIOD_LABELS.tableToggle }));
    const lastRow = container.querySelectorAll('table tbody tr')[8]!;
    expect(lastRow.querySelectorAll('td')[2]?.textContent).toBe('0%');
  });

  it('labels exactly the last, max and min JOINED periods — a sub-floor point is never labelled', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={joinedWithSubFloorZero()}
        referenceRate={50}
        width={640}
        height={288}
        labels={PERIOD_LABELS}
      />,
    );
    expect(renderedValueLabels(container).sort()).toEqual(['45%', '58%', '60%']);
  });

  it('a sub-floor 100% period is never the labelled maximum', () => {
    // REWRITTEN by plan 39.1-43 (PD-43-1): 8 points with sub-floor periods now
    // lock (fewer than 8 at the floor), so the series gains at-floor points to
    // keep exercising the DRAWN plot this case pins.
    const points = makePeriodSeries(9, (i) =>
      i === 2 ? { subFloor: true, wins: 1, losses: 0, total: 1, rate: 1 } : { rate: 0.5 },
    );
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    expect(
      container.querySelector('[data-slot="trend-line-period"]')?.getAttribute('data-state'),
    ).toBe('drawn');
    expect(renderedValueLabels(container)).not.toContain('100%');
  });

  // REWRITTEN by plan 39.1-43 (PD-43-1): a series with no joined period has
  // no period at the floor, so it is the LOCKED trend — no plot, no label.
  it('a series with no joined period renders no value label at all (the locked trend, PD-43-1)', () => {
    const points = makePeriodSeries(8, () => ({
      subFloor: true,
      wins: 1,
      losses: 1,
      total: 2,
      rate: 0.5,
    }));
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    expect(
      container.querySelector('[data-slot="trend-line-period"]')?.getAttribute('data-state'),
    ).toBe('locked');
    expect(renderedValueLabels(container)).toEqual([]);
  });

  it('dot radii are half the 5 / 7 / 9 px diameters: 2.5 / 3.5 / 4.5 for 20 / 80 / 200 games', () => {
    const totals = [20, 80, 200, 20, 20, 20, 20, 20];
    const points = makePeriodSeries(8, (i) => ({ total: totals[i], rate: 0.5 }));
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const radii = Array.from(container.querySelectorAll('circle')).map((c) =>
      Number(c.getAttribute('r')),
    );
    expect(radii.slice(0, 3)).toEqual([2.5, 3.5, 4.5]);
  });

  it('the all-time reference label moves above the line when the last joined value label rises into its under-the-line slot', () => {
    // 640 x 160: domain [40, 60] maps to y 29..109 (4px per point). The
    // reference (55%) sits at y 49; the last joined point (48%) at y 77 has
    // its value label box at y 53..69 — inside the default slot (y 54..70).
    const rates = [0.5, 0.52, 0.54, 0.5, 0.53, 0.51, 0.5, 0.48];
    const points = makePeriodSeries(8, (i) => ({ rate: rates[i] }));
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        referenceRate={55}
        width={640}
        height={160}
        labels={PERIOD_LABELS_WITH_REFERENCE}
      />,
    );
    const line = container.querySelector('.recharts-reference-line-line')!;
    const label = container.querySelector('text.recharts-label')!;
    expect(label).not.toBeNull();
    expect(Number(label.getAttribute('y'))).toBeLessThan(Number(line.getAttribute('y1')));
  });

  it('with no value label near it, the reference label keeps the sketch placement: right-aligned under the line', () => {
    const points = makePeriodSeries(8, () => ({ rate: 0.55 }));
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        referenceRate={55}
        width={640}
        height={160}
        labels={PERIOD_LABELS_WITH_REFERENCE}
      />,
    );
    const line = container.querySelector('.recharts-reference-line-line')!;
    const label = container.querySelector('text.recharts-label')!;
    expect(Number(label.getAttribute('y'))).toBeGreaterThan(Number(line.getAttribute('y1')));
    expect(label.getAttribute('text-anchor')).toBe('end');
  });
});

describe('TrendLine — event mode human axis, fitted domain, label cap (plan 39.1-37, human-event-axis)', () => {
  /** 23 SESSION anchors (key `session::<ms>`, ISO engine label) whose cumulative rate lives between 45 and 60. */
  function sessionAnchors(count = 23): TrendEventPoint[] {
    return Array.from({ length: count }, (_, i) => {
      const dateMs = Date.UTC(2023, 10, 1 + i * 3, 19, 30);
      return makeEventPoint({
        eventKey: `session::${dateMs}`,
        cumulativeWinRate: 45 + ((i * 7) % 16),
        wins: 9,
        losses: 7,
        context: { opponentTag: 'rival', eventLabel: new Date(dateMs).toISOString(), dateMs },
      });
    });
  }

  it('no rendered tick text is a raw engine key ("::") or an ISO timestamp', () => {
    const { container } = render(
      <TrendLine mode="event" points={sessionAnchors()} width={1390} height={288} />,
    );
    const tickTexts = renderedTickTexts(container);
    expect(tickTexts.length).toBeGreaterThan(1);
    for (const text of tickTexts) {
      expect(text).not.toMatch(/::/);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('fits the y-domain to the cumulative rates (45-60 renders ticks within 40-70, never 0 and 100)', () => {
    const { container } = render(
      <TrendLine mode="event" points={sessionAnchors()} width={1390} height={288} />,
    );
    const ticks = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text')).map(
      (el) => Number(el.textContent),
    );
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(40);
      expect(tick).toBeLessThanOrEqual(70);
    }
  });

  it('labels at most 8 anchors, every label carrying data-slot "trend-event-value-label"', () => {
    const { container } = render(
      <TrendLine mode="event" points={sessionAnchors()} width={1390} height={288} />,
    );
    const labels = container.querySelectorAll('[data-slot="trend-event-value-label"]');
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels.length).toBeLessThanOrEqual(8);
    const wlTexts = Array.from(container.querySelectorAll('text')).filter((el) =>
      /^\d+–\d+$/.test(el.textContent ?? ''),
    );
    expect(wlTexts.length).toBe(labels.length);
  });

  it('at a phone width (326px) the tick labels never sit closer than 4px (modelled from the rendered x and anchor)', () => {
    const { container } = render(
      <TrendLine mode="event" points={sessionAnchors()} width={326} height={288} />,
    );
    const ticks = Array.from(container.querySelectorAll('.recharts-xAxis-tick-labels text'))
      .map((el) => {
        const x = Number(el.getAttribute('x'));
        const w = estimateTickLabelWidthPx(el.textContent ?? '');
        const anchor = el.getAttribute('text-anchor');
        const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
        return { left, right: left + w };
      })
      .sort((a, b) => a.left - b.left);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i]!.left - ticks[i - 1]!.right).toBeGreaterThanOrEqual(4);
    }
    for (const tick of ticks) {
      expect(tick.left).toBeGreaterThanOrEqual(0);
      expect(tick.right).toBeLessThanOrEqual(326);
    }
  });
});

describe('TrendLine — design-fidelity loop (plan 39.1-37 Task 3): marks at the domain edge are whole, labels stay legible', () => {
  it('period mode: a pinned or edge dot is never clipped — the dots layer carries no clip-path', () => {
    // REWRITTEN by plan 39.1-43 (PD-43-1): 8 points with sub-floor periods now
    // lock (fewer than 8 at the floor), so the series gains at-floor points to
    // keep exercising the DRAWN plot this case pins.
    const points = makePeriodSeries(9, (i) =>
      i === 8 ? { subFloor: true, wins: 0, losses: 2, total: 2, rate: 0 } : { rate: 1 },
    );
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const dotLayers = Array.from(container.querySelectorAll('.recharts-line-dots'));
    expect(dotLayers.length).toBeGreaterThan(0);
    for (const layer of dotLayers) {
      expect(layer.getAttribute('clip-path')).toBeNull();
    }
  });

  // REWRITTEN by plan 39.1-41 (PD-41-3): this case pinned plan 37's hidden
  // second y-axis carrying Matchups' cumulative context step series (the
  // series could leave the fitted domain without re-extending it). The kit no
  // longer has a context series at all: a caller that still passes the old
  // prop gets ONE stroked data line and ONE y-axis, and the fitted ticks.
  it('period mode: a legacy context-series prop draws nothing — one stroked data line, one y-axis, y ticks stay 40-70 (PD-41-3)', () => {
    const joined = [0.45, 0.5, 0.55, 0.6, 0.52, 0.48, 0.58, 0.5];
    const points = makePeriodSeries(8, (i) => ({ rate: joined[i] }));
    const legacyContextProp = { contextRatePercents: [0, 100, 0, 100, 0, 100, 0, 100] } as object;
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        {...legacyContextProp}
        width={640}
        height={288}
        labels={PERIOD_LABELS}
      />,
    );
    expect(strokedLineCurves(container)).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-yAxis')).toHaveLength(1);
    const ticks = renderedYTickValues(container);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(40);
      expect(tick).toBeLessThanOrEqual(70);
    }
  });

  it('event mode: a first anchor at 100% keeps its whole dot — the dots layer carries no clip-path', () => {
    const points = eventKeysFor(6).map((eventKey, i) =>
      makeEventPoint({ eventKey, cumulativeWinRate: i === 0 ? 100 : 60 - i }),
    );
    const { container } = render(
      <TrendLine mode="event" points={points} width={640} height={288} />,
    );
    const dotLayers = Array.from(container.querySelectorAll('.recharts-line-dots'));
    expect(dotLayers.length).toBeGreaterThan(0);
    for (const layer of dotLayers) {
      expect(layer.getAttribute('clip-path')).toBeNull();
    }
  });

  it('event mode: two same-day sessions never print the same date twice on the axis', () => {
    const day = Date.UTC(2023, 10, 18, 12);
    const times = [
      Date.UTC(2023, 10, 14, 12),
      Date.UTC(2023, 10, 16, 12),
      Date.UTC(2023, 10, 17, 12),
      day,
      day + 4 * 60 * 60 * 1000,
    ];
    const points = times.map((dateMs) =>
      makeEventPoint({
        eventKey: `session::${dateMs}`,
        context: { opponentTag: 'rival', eventLabel: new Date(dateMs).toISOString(), dateMs },
      }),
    );
    const { container } = render(
      <TrendLine mode="event" points={points} width={1390} height={288} />,
    );
    const tickTexts = renderedTickTexts(container);
    expect(tickTexts.length).toBeGreaterThan(1);
    expect(new Set(tickTexts).size).toBe(tickTexts.length);
    expect(tickTexts[tickTexts.length - 1]).toBe('Nov 18, 2023');
  });

  it('event and period value labels carry a surface-coloured halo so a crossing line never overprints them', () => {
    const { container: eventContainer } = render(
      <TrendLine
        mode="event"
        points={eventKeysFor(3).map((eventKey) => makeEventPoint({ eventKey }))}
        width={640}
        height={288}
      />,
    );
    const eventLabel = eventContainer.querySelector('[data-slot="trend-event-value-label"]')!;
    expect(eventLabel.getAttribute('stroke')).toBe('var(--card)');
    expect(eventLabel.getAttribute('paint-order')).toBe('stroke');

    const { container: periodContainer } = render(
      <TrendLine
        mode="period"
        points={makePeriodSeries(8, (i) => ({ rate: 0.4 + i * 0.02 }))}
        width={640}
        height={288}
        labels={PERIOD_LABELS}
      />,
    );
    const periodLabel = periodContainer.querySelector('[data-slot="trend-period-value-label"]')!;
    expect(periodLabel.getAttribute('stroke')).toBe('var(--card)');
    expect(periodLabel.getAttribute('paint-order')).toBe('stroke');
  });
});

describe('TrendLine — event labels clear the step riser (plan 39.1-37 Task 3 design-fidelity loop)', () => {
  it('each W-L label starts just right of its dot (clear of the stepAfter riser); the last ends just left of it', () => {
    const points = eventKeysFor(5).map((eventKey, i) =>
      makeEventPoint({ eventKey, cumulativeWinRate: 40 + i * 5, wins: i, losses: 1 }),
    );
    const { container } = render(
      <TrendLine mode="event" points={points} width={1000} height={288} />,
    );
    const dots = Array.from(container.querySelectorAll('.recharts-line-dots circle')).map((c) =>
      Number(c.getAttribute('cx')),
    );
    const labels = Array.from(container.querySelectorAll('[data-slot="trend-event-value-label"]'));
    expect(labels).toHaveLength(5);
    labels.forEach((label, i) => {
      const x = Number(label.getAttribute('x'));
      if (i === labels.length - 1) {
        expect(label.getAttribute('text-anchor')).toBe('end');
        expect(x).toBeLessThan(dots[i]!);
      } else {
        expect(label.getAttribute('text-anchor')).toBe('start');
        expect(x).toBeGreaterThan(dots[i]!);
      }
    });
  });
});

describe('TrendLine — the reference label sits on a card-coloured ground (sketch 001-C .ref-label background; plan 39.1-37 Task 3)', () => {
  it('the all-time reference label carries the same --card halo as the value labels', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={makePeriodSeries(8, () => ({ rate: 0.55 }))}
        referenceRate={55}
        width={640}
        height={160}
        labels={PERIOD_LABELS_WITH_REFERENCE}
      />,
    );
    const label = container.querySelector('text.trend-period-reference-label')!;
    expect(label).not.toBeNull();
    expect(label.getAttribute('stroke')).toBe('var(--card)');
    expect(label.getAttribute('paint-order')).toBe('stroke');
  });
});

describe('TrendLine table-twin toggle link tone (plan 39.1-39, UI-SPEC §4.3)', () => {
  it('"View as table" is a muted link, never brand red', () => {
    const points = makePeriodSeries(6, (i) => ({ wins: i, losses: 6 - i, total: 6, rate: i / 6 }));
    render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const classes = screen
      .getByRole('button', { name: PERIOD_LABELS.tableToggle })
      .className.split(/\s+/);
    expect(classes).toContain('text-muted-foreground');
    expect(classes).toContain('hover:text-foreground');
    expect(classes).not.toContain('text-primary');
  });
});

/** Recharts line curves that actually draw a stroke (the dot-carrier series is stroke="none"). */
function strokedLineCurves(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('path.recharts-line-curve')).filter((path) => {
    const stroke = path.getAttribute('stroke');
    const width = Number(path.getAttribute('stroke-width') ?? '1');
    return stroke !== null && stroke !== 'none' && width > 0;
  });
}

describe('TrendLine — period dot sizing, one data line, surface attributes (plan 39.1-41, sketch 003 A)', () => {
  // REWRITTEN by plan 39.1-43 (PD-43-1): a ninth (20-game) period keeps 8 at
  // the floor beside the sub-floor first one, so the series still draws.
  const TIER_TOTALS = [2, 5, 8, 20, 20, 20, 20, 20, 20];

  function tierSeries(): PeriodPoint[] {
    return makePeriodSeries(9, (i) =>
      i === 0
        ? { total: 2, wins: 1, losses: 1, rate: 0.5, subFloor: true }
        : { total: TIER_TOTALS[i], rate: 0.5 },
    );
  }

  function dotRadii(container: HTMLElement): number[] {
    return Array.from(container.querySelectorAll('[data-slot="trend-period-dot"]')).map((c) =>
      Number(c.getAttribute('r')),
    );
  }

  it('dotSizing="tier" draws 5 / 5 / 7 / 9 px diameters for totals 2 / 5 / 8 / 20 (confidence tiers)', () => {
    const tierProps = { dotSizing: 'tier' } as object;
    const { container } = render(
      <TrendLine
        mode="period"
        points={tierSeries()}
        {...tierProps}
        width={640}
        height={160}
        labels={PERIOD_LABELS}
      />,
    );
    expect(
      dotRadii(container)
        .slice(0, 4)
        .map((r) => r * 2),
    ).toEqual([5, 5, 7, 9]);
  });

  it("the default dot sizing keeps plan 37's games thresholds (every total under 50 games is 5 px)", () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={tierSeries()}
        width={640}
        height={160}
        labels={PERIOD_LABELS}
      />,
    );
    expect(dotRadii(container).map((r) => r * 2)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 5]);
  });

  it('draws exactly ONE stroked line path and exactly ONE y-axis', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={tierSeries()}
        width={640}
        height={160}
        labels={PERIOD_LABELS}
      />,
    );
    expect(strokedLineCurves(container)).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-yAxis')).toHaveLength(1);
  });

  it('the drawn root carries data-state="drawn", data-dot-sizing and data-y-domain "lo,hi"', () => {
    const tierProps = { dotSizing: 'tier' } as object;
    const joined = [0.45, 0.5, 0.55, 0.6, 0.52, 0.48, 0.58, 0.5];
    const points = makePeriodSeries(8, (i) => ({ rate: joined[i] }));
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        referenceRate={50}
        {...tierProps}
        width={640}
        height={160}
        labels={PERIOD_LABELS}
      />,
    );
    const root = container.querySelector('[data-slot="trend-line-period"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-state')).toBe('drawn');
    expect(root?.getAttribute('data-dot-sizing')).toBe('tier');
    expect(root?.getAttribute('data-y-domain')).toBe('40,70');
    // The attributes are metadata only: the root is layout-neutral.
    expect(root?.className).toContain('contents');
    expect(root?.querySelector('svg.recharts-surface')).not.toBeNull();
    expect(root?.querySelector('[data-slot="trend-line-period-table"]')).not.toBeNull();
  });

  it('the locked root carries data-state="locked" and the default data-dot-sizing "games"', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={makePeriodSeries(3)}
        width={640}
        height={160}
        labels={PERIOD_LABELS}
      />,
    );
    const root = container.querySelector('[data-slot="trend-line-period"]');
    expect(root?.getAttribute('data-state')).toBe('locked');
    expect(root?.getAttribute('data-dot-sizing')).toBe('games');
    expect(root?.hasAttribute('data-y-domain')).toBe(false);
    expect(root?.querySelector('[data-slot="trend-line-period-locked"]')).not.toBeNull();
  });

  it('every dot carries data-sub-floor and data-point-key; every value label carries data-point-key', () => {
    const points = tierSeries();
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={160} labels={PERIOD_LABELS} />,
    );
    const dots = Array.from(container.querySelectorAll('[data-slot="trend-period-dot"]'));
    expect(dots.map((d) => d.getAttribute('data-point-key'))).toEqual(points.map((p) => p.key));
    expect(dots.map((d) => d.getAttribute('data-sub-floor'))).toEqual(
      points.map((p) => String(p.subFloor)),
    );
    const labels = Array.from(container.querySelectorAll('[data-slot="trend-period-value-label"]'));
    expect(labels.length).toBeGreaterThan(0);
    const keys = new Set(points.map((p) => p.key));
    for (const label of labels) {
      expect(keys.has(label.getAttribute('data-point-key') ?? '')).toBe(true);
    }
  });
});

/**
 * Plan 39.1-41 fidelity loop (sketch 003 `.band`, UI-SPEC §7.13 "from the
 * period containing the window start to the right edge", "1px left edge"):
 * the recent band covers its first period's whole slot and runs to the
 * plot's right edge, with a 1px series-1 left edge. Geometry of a 640px
 * trend: plot 26..635, category centres 42 + i x (577 / 7).
 * REWRITTEN by plan 39.1-43b (sketch `.trend.gutter`): was plot 65..635,
 * centres 81 + i x (538 / 7) — the 60px axis and 5px left margin became the
 * sketch's 26px gutter.
 */
describe('TrendLine — the recent band reaches the plot edge (plan 39.1-41 fidelity loop)', () => {
  it("spans from the containing period's slot start to the plot's right edge, with a 1px series-1 left edge", () => {
    const points = makePeriodSeries(8, () => ({ rate: 0.5 }));
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        width={640}
        height={160}
        labels={PERIOD_LABELS}
        emphasisStartMs={points[5]!.startMs}
      />,
    );
    const step = 577 / 7;
    const band = container.querySelector('.recharts-reference-area-rect');
    expect(band).not.toBeNull();
    const x = Number(band!.getAttribute('x'));
    const width = Number(band!.getAttribute('width'));
    expect(x).toBeCloseTo(42 + 5 * step - step / 2, 0);
    expect(x + width).toBeCloseTo(635, 0);
    const edge = container.querySelector('[data-slot="trend-period-band-edge"]');
    expect(edge).not.toBeNull();
    expect(Number(edge!.getAttribute('x1'))).toBeCloseTo(x, 1);
    expect(Number(edge!.getAttribute('x2'))).toBeCloseTo(x, 1);
    expect(edge!.getAttribute('stroke')).toBe('var(--viz-series-1)');
    expect(edge!.getAttribute('stroke-width')).toBe('1');
  });

  it('a band starting at the first period never extends left of the plot', () => {
    const points = makePeriodSeries(8, () => ({ rate: 0.5 }));
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        width={640}
        height={160}
        labels={PERIOD_LABELS}
        emphasisStartMs={points[0]!.startMs}
      />,
    );
    const band = container.querySelector('.recharts-reference-area-rect');
    // REWRITTEN by plan 39.1-43b: the plot's left edge is the 26px gutter (was 65).
    expect(Number(band!.getAttribute('x'))).toBeGreaterThanOrEqual(26);
  });
});

describe('TrendLine — value labels placed like sketch 003 (plan 39.1-41 fidelity loop)', () => {
  function labelFor(container: HTMLElement, key: string): Element {
    const label = container.querySelector(
      `[data-slot="trend-period-value-label"][data-point-key="${key}"]`,
    );
    expect(label, key).not.toBeNull();
    return label!;
  }

  function dotFor(container: HTMLElement, key: string): Element {
    return container.querySelector(`[data-slot="trend-period-dot"][data-point-key="${key}"]`)!;
  }

  it('the min label sits below its dot, a max at the top edge flips below, the last label stays above', () => {
    // Max 100% (index 2) at the top edge; min 33% (index 5); last 60%.
    const rates = [0.5, 0.7, 1, 0.6, 0.55, 1 / 3, 0.65, 0.6];
    const points = makePeriodSeries(8, (i) => ({ rate: rates[i] }));
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={160} labels={PERIOD_LABELS} />,
    );
    const below = (key: string) =>
      Number(labelFor(container, key).getAttribute('y')) >
      Number(dotFor(container, key).getAttribute('cy'));
    expect(below(points[5]!.key)).toBe(true);
    expect(labelFor(container, points[5]!.key).getAttribute('data-placement')).toBe('below');
    expect(below(points[2]!.key)).toBe(true);
    expect(below(points[7]!.key)).toBe(false);
    expect(labelFor(container, points[7]!.key).getAttribute('data-placement')).toBe('above');
  });

  // REWRITTEN by plan 39.1-41's own fidelity loop (after 540912a0): see
  // trendGeometry.test.ts — a last-periods label right-aligned across the
  // recent band's left edge; the 16px x-axis padding keeps it inside the plot
  // centred.
  it('the last label stays centred on its dot and inside the plot', () => {
    const points = makePeriodSeries(8, (i) => ({ rate: i === 7 ? 0.9 : 0.5 }));
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={160} labels={PERIOD_LABELS} />,
    );
    const label = labelFor(container, points[7]!.key);
    expect(label.getAttribute('text-anchor')).toBe('middle');
    const x = Number(label.getAttribute('x'));
    expect(x).toBeCloseTo(Number(dotFor(container, points[7]!.key).getAttribute('cx')), 0);
    expect(x + estimateTickLabelWidthPx('90%') / 2).toBeLessThanOrEqual(635);
  });
});

// ---------------------------------------------------------------------------
// Plan 39.1-43 Task 2 (trend-head-locked): the period trend's head, the honest
// at-floor locked rule, the sketches' 160px value range and OOS-6.
// ---------------------------------------------------------------------------

/** The hero hosts' shape of the labels: formatters of `{ need, have }` plus the head. */
const HEAD_LABELS = {
  ...PERIOD_LABELS,
  lockedSentence: ({ need }: { need: number; have: number }) =>
    `${need} more weeks with 3+ games unlock this chart.`,
  lockedCountLabel: ({ have }: { need: number; have: number }) => `${have} of 8`,
  title: 'Win rate by week',
  legend: {
    dot: 'size = games',
    hollow: 'hollow = under 3 games',
    reference: '50% all time',
    band: 'Last 30 games',
  },
  referenceLabel: '50% all time',
} as unknown as TrendLinePeriodLabels;

function legendKinds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot="trend-legend-item"]')).map(
    (item) => item.getAttribute('data-kind') ?? '',
  );
}

describe('TrendLine — period head: title + swatch legend (plan 39.1-43, sketch 001-C / 003 trendLegend)', () => {
  it('with labels.title renders the head: the overline, then dot / hollow / reference / band items when each is drawn', () => {
    const points = makePeriodSeries(10, (i) =>
      i === 4 ? { subFloor: true, total: 2, rate: 0.5 } : { rate: 0.45 + i * 0.01 },
    );
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        referenceRate={50}
        emphasisStartMs={points[7]!.startMs}
        width={640}
        height={288}
        labels={HEAD_LABELS}
      />,
    );
    const head = container.querySelector('[data-slot="trend-period-head"]');
    expect(head).not.toBeNull();
    expect(head!.firstElementChild?.textContent).toBe('Win rate by week');
    expect(head!.firstElementChild?.className).toMatch(/uppercase/);
    expect(legendKinds(container)).toEqual(['dot', 'hollow', 'reference', 'band']);
    const texts = Array.from(container.querySelectorAll('[data-slot="trend-legend-item"]')).map(
      (item) => item.textContent,
    );
    expect(texts).toEqual([
      'size = games',
      'hollow = under 3 games',
      '50% all time',
      'Last 30 games',
    ]);
  });

  it('hollow only when a drawn point is sub-floor; reference only with referenceRate; band only when the band is drawn', () => {
    const points = makePeriodSeries(10, (i) => ({ rate: 0.45 + i * 0.01 }));
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={HEAD_LABELS} />,
    );
    expect(legendKinds(container)).toEqual(['dot']);
  });

  it('no title -> no head', () => {
    const points = makePeriodSeries(10, (i) => ({ rate: 0.45 + i * 0.01 }));
    const labels = { ...HEAD_LABELS, title: undefined } as unknown as TrendLinePeriodLabels;
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        referenceRate={50}
        width={640}
        height={288}
        labels={labels}
      />,
    );
    expect(container.querySelector('[data-slot="trend-period-head"]')).toBeNull();
  });

  it('the locked trend keeps its overline and draws no legend item (sketch trendSection locked branch)', () => {
    const points = makePeriodSeries(3);
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={HEAD_LABELS} />,
    );
    expect(container.querySelector('[data-slot="trend-period-head"]')?.textContent).toBe(
      'Win rate by week',
    );
    expect(legendKinds(container)).toEqual([]);
  });
});

describe('TrendLine — the locked rule counts only periods at the 3-game floor (plan 39.1-43, PD-43-1, UI-SPEC 7.13)', () => {
  function quarterPoints(totals: number[]): PeriodPoint[] {
    return totals.map((total, i) =>
      makePeriodPoint({
        grain: 'quarter',
        key: `quarter:2020-Q${i + 1}`,
        label: `2020-Q${i + 1}`,
        startMs: i * 1000,
        endMs: i * 1000 + 999,
        wins: Math.min(total, 1),
        losses: total - Math.min(total, 1),
        total,
        rate: total > 0 ? Math.min(total, 1) / total : 0,
        subFloor: total < 3,
      }),
    );
  }

  it('4 quarters with 1 at the floor -> locked, the formatters receive need 7 / have 1', () => {
    const sentence = vi.fn(({ need }: { need: number; have: number }) => `${need} more`);
    const meter = vi.fn(({ have }: { need: number; have: number }) => `${have} of 8`);
    const labels = {
      ...HEAD_LABELS,
      lockedSentence: sentence,
      lockedCountLabel: meter,
    } as unknown as TrendLinePeriodLabels;
    const { container } = render(
      <TrendLine
        mode="period"
        points={quarterPoints([2, 6, 2, 1])}
        width={640}
        height={288}
        labels={labels}
      />,
    );
    const root = container.querySelector('[data-slot="trend-line-period"]');
    expect(root?.getAttribute('data-state')).toBe('locked');
    expect(sentence).toHaveBeenCalledWith({ need: 7, have: 1 });
    expect(meter).toHaveBeenCalledWith({ need: 7, have: 1 });
    expect(screen.getByText('7 more')).toBeInTheDocument();
    expect(container.querySelector('[role="img"]')).toHaveAttribute('aria-label', '1 of 8');
  });

  it('9 points with 8 at the floor -> drawn', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={quarterPoints([5, 5, 5, 2, 5, 5, 5, 5, 5])}
        width={640}
        height={288}
        labels={HEAD_LABELS}
      />,
    );
    expect(
      container.querySelector('[data-slot="trend-line-period"]')?.getAttribute('data-state'),
    ).toBe('drawn');
  });

  it('8 emitted points with 5 at the floor -> locked with need 3 (the old all-points rule drew it)', () => {
    const sentence = vi.fn(({ need }: { need: number; have: number }) => `${need} more`);
    const labels = { ...HEAD_LABELS, lockedSentence: sentence } as unknown as TrendLinePeriodLabels;
    const { container } = render(
      <TrendLine
        mode="period"
        points={quarterPoints([5, 1, 5, 2, 5, 2, 5, 5])}
        width={640}
        height={288}
        labels={labels}
      />,
    );
    expect(
      container.querySelector('[data-slot="trend-line-period"]')?.getAttribute('data-state'),
    ).toBe('locked');
    expect(sentence).toHaveBeenCalledWith({ need: 3, have: 5 });
  });
});

/**
 * The y of every horizontal grid hairline drawn AT a y-axis tick (px), sorted
 * top to bottom. Recharts 3's CartesianGrid also draws the plot box's own top
 * and bottom edge lines, which are not domain hairlines — only a line whose
 * y matches a rendered y tick counts (the guard's collector uses the same rule).
 */
function hairlineYs(container: HTMLElement): number[] {
  const tickYs = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text')).map(
    (tick) => Number(tick.getAttribute('y')),
  );
  return Array.from(container.querySelectorAll('.recharts-cartesian-grid-horizontal line'))
    .map((line) => Number(line.getAttribute('y1')))
    .filter((y) => Number.isFinite(y) && tickYs.some((tickY) => Math.abs(tickY - y) < 0.5))
    .sort((a, b) => a - b);
}

describe('TrendLine — the hero value range (plan 39.1-43, PD-43-3, sketch 001-C / 003 trend(): the 160px box is the value range)', () => {
  const points = makePeriodSeries(10, (i) => ({ rate: 0.3 + i * 0.05 }));

  it('valueRangePx={160}: the fitted domain lowest and highest hairlines are 160 ± 1 px apart and the root carries data-value-range-px', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        width={640}
        valueRangePx={160}
        labels={HEAD_LABELS}
        {...({} as object)}
      />,
    );
    const root = container.querySelector('[data-slot="trend-line-period"]');
    expect(root?.getAttribute('data-value-range-px')).toBe('160');
    expect(container.querySelector('svg.recharts-surface')?.getAttribute('height')).toBe('240');
    const ys = hairlineYs(container);
    expect(ys.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(ys[ys.length - 1]! - ys[0]! - 160)).toBeLessThanOrEqual(1);
  });

  it('without valueRangePx the chart keeps its height exactly (160 -> an 80px value range), no data-value-range-px', () => {
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={160} labels={HEAD_LABELS} />,
    );
    const root = container.querySelector('[data-slot="trend-line-period"]');
    expect(root?.hasAttribute('data-value-range-px')).toBe(false);
    expect(container.querySelector('svg.recharts-surface')?.getAttribute('height')).toBe('160');
    const ys = hairlineYs(container);
    expect(Math.abs(ys[ys.length - 1]! - ys[0]! - 80)).toBeLessThanOrEqual(1);
  });

  it('valueRangePx sets data-value-range-px on a locked trend too', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={makePeriodSeries(3)}
        width={640}
        valueRangePx={160}
        labels={HEAD_LABELS}
      />,
    );
    expect(
      container
        .querySelector('[data-slot="trend-line-period"]')
        ?.getAttribute('data-value-range-px'),
    ).toBe('160');
  });
});

describe('TrendLine — the reference label clears every drawn dot (plan 39.1-43, OOS-6)', () => {
  /**
   * 20 weekly points (40% unless set), domain fitted to [30, 70] by a 38% min and a 62% max,
   * the reference at 50%: on a 640 x 288 plot one rate point is 5.2px, so a
   * dot at 47.7% sits ~12px under the reference line — inside the default
   * (right, under the line) slot.
   */
  function series(rates: Record<number, number>): PeriodPoint[] {
    return makePeriodSeries(20, (i) => ({
      rate: rates[i] ?? (i === 5 ? 0.38 : i === 10 ? 0.62 : 0.4),
    }));
  }

  it('last dots just under the reference line move the label off the default slot (was insideTopRight over the dots)', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={series({ 18: 0.477, 19: 0.477 })}
        referenceRate={50}
        width={640}
        height={288}
        labels={HEAD_LABELS}
      />,
    );
    const root = container.querySelector('[data-slot="trend-line-period"]');
    const position = root?.getAttribute('data-reference-label-position');
    expect(['insideBottomRight', 'insideTopLeft', 'insideBottomLeft']).toContain(position);
    expect(container.querySelector('text.trend-period-reference-label')?.textContent).toBe(
      '50% all time',
    );
  });

  it('with every slot taken by a dot no direct reference label renders; the head legend reference item still states the rate', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={series({ 0: 0.477, 1: 0.523, 18: 0.477, 19: 0.523 })}
        referenceRate={50}
        width={640}
        height={288}
        labels={HEAD_LABELS}
      />,
    );
    const root = container.querySelector('[data-slot="trend-line-period"]');
    expect(root?.getAttribute('data-reference-label-position')).toBe('none');
    expect(container.querySelector('text.trend-period-reference-label')).toBeNull();
    expect(container.querySelector('[data-kind="reference"]')?.textContent).toBe('50% all time');
  });

  it('a trend whose dots stay clear keeps the sketch slot (insideTopRight)', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={series({})}
        referenceRate={50}
        width={640}
        height={288}
        labels={HEAD_LABELS}
      />,
    );
    expect(
      container
        .querySelector('[data-slot="trend-line-period"]')
        ?.getAttribute('data-reference-label-position'),
    ).toBe('insideTopRight');
  });
});

// Plan 39.1-43 fidelity loop (M2 locked, thin 1440 / 390; sketch 001-C / 003
// `.lock-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}`):
// the meter and its "1 of 8" count share one wrapping row.
describe('TrendLine — the locked meter and its count share one row (plan 39.1-43 fidelity loop, sketch .lock-row)', () => {
  it('the meter (role img) and the count label sit in one flex-wrap row, the meter growing', () => {
    const { container } = render(
      <TrendLine
        mode="period"
        points={makePeriodSeries(3)}
        width={640}
        height={288}
        labels={HEAD_LABELS}
      />,
    );
    const row = container.querySelector('[data-slot="trend-locked-row"]');
    expect(row).not.toBeNull();
    expect(row!.className).toMatch(/flex-wrap/);
    expect(row!.className).toMatch(/items-center/);
    const meter = row!.querySelector('[role="img"]');
    expect(meter).not.toBeNull();
    expect(meter!.className).toMatch(/flex-\[1_1_80px\]/);
    expect(row!.textContent).toBe('3 of 8');
  });
});

/**
 * Plan 39.1-43b (fidelity follow-up to 39.1-43): the period trend's axis is
 * sketch 003 A's `trend()` CSS — `.ytick{font-size:10px;color:muted;
 * left:-26px;width:20px;text-align:right}`, `.xaxis{font-size:10px}`,
 * `.val{font-size:10px;font-weight:600}` in the body text colour,
 * `.ref-label{font-size:10px}`, `.trend.gutter{margin-left:26px}`, and
 * `.grid-y` horizontal hairlines only (no vertical grid, no axis line, no
 * tick mark). The guard:layout family period-trend-axis measures the same
 * rules in real Chrome.
 */
describe('TrendLine — period axis matches sketch 003 A / 001-C (plan 39.1-43b)', () => {
  // Rates 25%..95%: the fitted domain is [20, 100] (span 80 -> sketch step 20).
  const points = makePeriodSeries(10, (i) => ({ rate: 0.25 + i * (0.7 / 9) }));

  function renderAxis() {
    return render(
      <TrendLine
        mode="period"
        points={points}
        width={640}
        valueRangePx={160}
        referenceRate={50}
        labels={HEAD_LABELS}
      />,
    );
  }

  it('y ticks step by 20 over a span above 50: 20 / 40 / 60 / 80 / 100', () => {
    const { container } = renderAxis();
    const ticks = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text')).map(
      (tick) => (tick.textContent ?? '').trim(),
    );
    expect(ticks).toEqual(['20', '40', '60', '80', '100']);
  });

  it('y ticks and x labels are 10px in the muted token; value labels 10px / 600 in the foreground token; the reference label 10px', () => {
    const { container } = renderAxis();
    const yTicks = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text'));
    const xTicks = Array.from(container.querySelectorAll('.recharts-xAxis-tick-labels text'));
    expect(yTicks.length).toBeGreaterThan(0);
    expect(xTicks.length).toBeGreaterThan(0);
    for (const tick of [...yTicks, ...xTicks]) {
      expect(tick.getAttribute('font-size')).toBe('10');
      expect(tick.getAttribute('fill')).toBe('var(--muted-foreground)');
    }
    const valueLabels = Array.from(
      container.querySelectorAll('[data-slot="trend-period-value-label"]'),
    );
    expect(valueLabels.length).toBeGreaterThan(0);
    for (const label of valueLabels) {
      expect(label.getAttribute('font-size')).toBe('10');
      expect(label.getAttribute('font-weight')).toBe('600');
      expect(label.getAttribute('fill')).toBe('var(--foreground)');
    }
    const reference = container.querySelector('.trend-period-reference-label');
    if (reference) {
      const text =
        reference.tagName.toLowerCase() === 'text' ? reference : reference.querySelector('text');
      expect(text?.getAttribute('font-size') ?? reference.getAttribute('font-size')).toBe('10');
    }
  });

  it('the plot starts 26px from the chart edge and a tick ends 6px before it (right-aligned)', () => {
    const { container } = renderAxis();
    const lines = Array.from(
      container.querySelectorAll('.recharts-cartesian-grid-horizontal line'),
    ).map((line) => Number(line.getAttribute('x1')));
    expect(lines.length).toBeGreaterThan(0);
    expect(Math.min(...lines)).toBe(26);
    for (const tick of Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text'))) {
      expect(Number(tick.getAttribute('x'))).toBe(20);
      expect(tick.getAttribute('text-anchor')).toBe('end');
    }
  });

  it('horizontal hairlines only, each at a y tick: no vertical grid, no axis line, no tick mark', () => {
    const { container } = renderAxis();
    expect(container.querySelectorAll('.recharts-cartesian-grid-vertical line')).toHaveLength(0);
    expect(
      container.querySelectorAll(
        '.recharts-cartesian-axis-line, .recharts-cartesian-axis-tick-line',
      ),
    ).toHaveLength(0);
    const tickYs = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text')).map(
      (tick) => Number(tick.getAttribute('y')),
    );
    const stray = Array.from(container.querySelectorAll('.recharts-cartesian-grid-horizontal line'))
      .map((line) => Number(line.getAttribute('y1')))
      .filter((y) => !tickYs.some((tickY) => Math.abs(tickY - y) < 0.5));
    expect(stray).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Value mode (plan 41-02, A1 / DD-41-01, UI-SPEC §7.1)
// ---------------------------------------------------------------------------

const VALUE_DAY_MS = 24 * 60 * 60 * 1000;
const VALUE_START_MS = Date.UTC(2025, 0, 1, 12);

/** `count` GSP-like readings spread evenly over `spanDays`, rising with the index. */
function gspReadings(count: number, spanDays: number): ValueSeriesReading[] {
  return Array.from({ length: count }, (_, i) => ({
    atMs: VALUE_START_MS + Math.round((i * spanDays * VALUE_DAY_MS) / count),
    value: 9_000_000 + i * 5_000,
    calibration: false,
  }));
}

/** A host's job: attach a pre-resolved readout to every point the shared ladder produced. */
function valuePointsOf(series: ValueSeries): TrendValuePoint[] {
  return series.points.map((point) => ({
    ...point,
    context: {
      valueKey: 'value',
      title: `${point.value.toLocaleString('en')} GSP`,
      lines: [`${point.n} readings`],
    },
  }));
}

function valueLabels(
  overrides: Partial<TrendLineValueProps['labels']> = {},
): TrendLineValueProps['labels'] {
  return {
    overline: 'GSP by reading',
    aria: 'GSP over time',
    legend: { series: 'GSP', calibration: 'set manually' },
    tableToggle: 'View as table',
    tableHeaders: { date: 'Date', value: 'GSP', readings: 'Readings' },
    ...overrides,
  };
}

function renderValue(
  series: ValueSeries,
  overrides: Partial<Omit<TrendLineValueProps, 'mode'>> = {},
  { width = 640, height = 288 }: { width?: number; height?: number } = {},
) {
  const points = valuePointsOf(series);
  const props = {
    mode: 'value' as const,
    points,
    grain: series.grain,
    formatTick: (n: number) => `${(n / 1e6).toFixed(2)}M`,
    formatValueFull: (n: number) => n.toLocaleString('en'),
    labels: valueLabels(),
    ...overrides,
  };
  const view = render(
    <ChartCard title="GSP curve">
      <TrendLine {...props} width={width} height={height} />
    </ChartCard>,
  );
  return { ...view, points: props.points };
}

describe('TrendLine — mode value (plan 41-02, tracer)', () => {
  it('draws a 200-reading series as at most 60 value points on one line, inside the frame', () => {
    const series = buildValueSeries(gspReadings(200, 18 * 30));
    expect(series.grain).not.toBe('reading');
    const { container } = renderValue(series);
    expect(container.querySelector('[data-slot="card"]')).not.toBeNull();
    const root = container.querySelector('[data-slot="trend-line-value"]')!;
    expect(root.getAttribute('data-grain')).toBe(series.grain);
    expect(root.getAttribute('data-point-count')).toBe(String(series.points.length));
    const marks = container.querySelectorAll(
      '[data-slot="trend-value-dot"], [data-slot="trend-value-diamond"]',
    );
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.length).toBeLessThanOrEqual(60);
    expect(marks).toHaveLength(series.points.length);
    expect(
      container.querySelectorAll('.trend-line-value-line path.recharts-line-curve'),
    ).toHaveLength(1);
  });

  it('marks only the last reading at reading grain (no dot on match readings)', () => {
    const series = buildValueSeries(gspReadings(40, 120));
    expect(series.grain).toBe('reading');
    const { container } = renderValue(series);
    expect(container.querySelectorAll('[data-slot="trend-value-dot"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="trend-value-diamond"]')).toHaveLength(0);
  });

  it('hands the clicked point back with its memberIndexes intact', () => {
    const series = buildValueSeries(gspReadings(200, 18 * 30));
    const onSelectPoint = vi.fn();
    const { container, points } = renderValue(series, { onSelectPoint });
    const target = points[4]!;
    const mark = container.querySelector(`[data-point-key="${target.key}"]`)!;
    const hit = container.querySelector('[data-slot="trend-value-hit"]')!;
    fireEvent.click(hit, { clientX: Number(mark.getAttribute('cx')), clientY: 100 });
    expect(onSelectPoint).toHaveBeenCalledTimes(1);
    const selected = onSelectPoint.mock.calls[0]![0] as TrendValuePoint;
    expect(selected).toEqual(target);
    expect(selected.memberIndexes.length).toBeGreaterThan(0);
    expect(selected.memberIndexes).toEqual(series.points[4]!.memberIndexes);
  });

  it('puts the marks where the plot geometry says: last point at the plot right edge, line inside it', () => {
    const series = buildValueSeries(gspReadings(200, 18 * 30));
    const { container, points } = renderValue(series);
    const last = points[points.length - 1]!;
    const cx = Number(
      container.querySelector(`[data-point-key="${last.key}"]`)!.getAttribute('cx'),
    );
    // width 640 - the 12px right margin.
    expect(cx).toBeCloseTo(640 - 12, 0);
  });

  it('shows the one readout (ChartTooltip value branch) for the point under a fine pointer', () => {
    const series = buildValueSeries(gspReadings(200, 18 * 30));
    const { container, points } = renderValue(series);
    const target = points[2]!;
    const mark = container.querySelector(`[data-point-key="${target.key}"]`)!;
    const hit = container.querySelector('[data-slot="trend-value-hit"]')!;
    fireEvent.pointerMove(hit, { clientX: Number(mark.getAttribute('cx')), pointerType: 'mouse' });
    const readout = container.querySelector('[data-slot="trend-value-readout"]');
    expect(readout?.textContent).toContain(target.context.title);
    expect(container.querySelector('[data-slot="trend-value-crosshair"]')).not.toBeNull();
    fireEvent.pointerLeave(hit, { pointerType: 'mouse' });
    expect(container.querySelector('[data-slot="trend-value-readout"]')).toBeNull();
  });

  it('renders nothing for an empty series and leaves the index / event / period modes alone', () => {
    const { container } = render(
      <TrendLine
        mode="value"
        points={[]}
        grain="reading"
        formatTick={String}
        formatValueFull={String}
        labels={valueLabels()}
        width={640}
      />,
    );
    expect(container.firstChild).toBeNull();
    const indexRender = render(
      <TrendLine
        points={[makePoint({ index: 1 }), makePoint({ index: 2 })]}
        width={640}
        height={288}
      />,
    );
    expect(indexRender.container.querySelectorAll('circle')).toHaveLength(2);
  });
});

describe('TrendLine — mode value says what it shows (plan 41-02 Task 2, UI-SPEC §7.1)', () => {
  const calibrationReadings = (): ValueSeriesReading[] => {
    const readings = gspReadings(12, 36);
    readings[5] = { ...readings[5]!, calibration: true };
    return readings;
  };

  it('names the grain actually drawn in the head overline and carries the legend', () => {
    const series = buildValueSeries(gspReadings(200, 18 * 30));
    const { container } = renderValue(series, {
      labels: valueLabels({ overline: (grain) => `GSP by ${grain}` }),
    });
    const head = container.querySelector('[data-slot="trend-value-head"]')!;
    expect(head.textContent).toContain(`GSP by ${series.grain}`);
    expect(
      container.querySelectorAll('[data-slot="trend-value-legend-item"][data-kind="series"]'),
    ).toHaveLength(1);
    // No calibration drawn: no calibration legend item.
    expect(container.querySelector('[data-kind="calibration"]')).toBeNull();
  });

  it('draws a diamond for a calibration reading at reading grain, and shows its legend item', () => {
    const series = buildValueSeries(calibrationReadings());
    expect(series.grain).toBe('reading');
    const { container } = renderValue(series);
    expect(container.querySelectorAll('[data-slot="trend-value-diamond"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="trend-value-dot"]')).toHaveLength(1);
    expect(container.querySelector('[data-kind="calibration"]')?.textContent).toBe('set manually');
  });

  it('draws one dot per close at a coarser grain and a diamond for a close holding a calibration', () => {
    const series = buildValueSeries(calibrationReadings(), { minGrain: 'week' });
    expect(series.grain).not.toBe('reading');
    const { container } = renderValue(series);
    const diamonds = container.querySelectorAll('[data-slot="trend-value-diamond"]');
    const dots = container.querySelectorAll('[data-slot="trend-value-dot"]');
    expect(diamonds).toHaveLength(series.points.filter((p) => p.containsCalibration).length);
    expect(diamonds.length + dots.length).toBe(series.points.length);
  });

  it('draws a dashed reference line and its direct label when the host placed it as a line', () => {
    const series = buildValueSeries(gspReadings(40, 120));
    const { container } = renderValue(series, {
      reference: { value: 9_100_000, label: 'Elite 9,100,000', placement: 'line' },
      labels: valueLabels({
        legend: { series: 'GSP', reference: 'Elite 9,100,000' },
      }),
    });
    const line = container.querySelector('[data-slot="trend-value-reference"]')!;
    expect(line.getAttribute('stroke-dasharray')).toBe('4 3');
    expect(container.querySelector('[data-slot="trend-value-reference-label"]')?.textContent).toBe(
      'Elite 9,100,000',
    );
    expect(container.querySelector('[data-kind="reference"]')).not.toBeNull();
  });

  it("draws no line for an 'above-range' reference and states it in the head legend instead", () => {
    const series = buildValueSeries(gspReadings(40, 120));
    const { container } = renderValue(series, {
      reference: { value: 40_000_000, label: 'Elite 40,000,000', placement: 'above-range' },
      labels: valueLabels({
        legend: { series: 'GSP', reference: 'Elite 40,000,000 — above this range' },
      }),
    });
    expect(container.querySelector('[data-slot="trend-value-reference"]')).toBeNull();
    expect(container.querySelector('[data-slot="trend-value-reference-label"]')).toBeNull();
    expect(container.querySelector('[data-kind="reference-range"]')?.textContent).toBe(
      'Elite 40,000,000 — above this range',
    );
    // The far reference never widened the domain: the y domain still hugs the readings.
    const domain = container
      .querySelector('[data-slot="trend-line-value"]')!
      .getAttribute('data-y-domain')!
      .split(',')
      .map(Number);
    expect(domain[1]).toBeLessThan(10_000_000);
  });

  it('widens the domain to hold a line-placed reference', () => {
    const series = buildValueSeries(gspReadings(40, 120));
    const { container } = renderValue(series, {
      reference: { value: 9_300_000, label: 'Elite', placement: 'line' },
    });
    const domain = container
      .querySelector('[data-slot="trend-line-value"]')!
      .getAttribute('data-y-domain')!
      .split(',')
      .map(Number);
    expect(domain[1]).toBeGreaterThanOrEqual(9_300_000);
  });

  it('labels the last point always, and peak / low only when distinct and at 3+ points', () => {
    const readings: ValueSeriesReading[] = [3, 9, 5, 1, 4].map((v, i) => ({
      atMs: VALUE_START_MS + i * VALUE_DAY_MS,
      value: v * 1_000_000,
      calibration: false,
    }));
    const series = buildValueSeries(readings);
    const last = renderValue(series, { directLabels: 'last' });
    expect(
      Array.from(last.container.querySelectorAll('[data-slot="trend-value-label"]')).map((el) =>
        el.getAttribute('data-role'),
      ),
    ).toEqual(['last']);
    last.unmount();
    const all = renderValue(series, { directLabels: 'last-peak-low' });
    expect(
      Array.from(all.container.querySelectorAll('[data-slot="trend-value-label"]')).map((el) =>
        el.getAttribute('data-role'),
      ),
    ).toEqual(['last', 'peak', 'low']);
    expect(all.container.querySelector('[data-role="last"]')?.textContent).toBe('4,000,000');
  });

  it('shows the locked inset in place of the plot, and nothing at all for 0 points', () => {
    const series = buildValueSeries(gspReadings(1, 1));
    const { container } = renderValue(series, {
      locked: {
        have: 1,
        need: 2,
        sentence: 'Log one more reading to unlock this chart.',
        meterLabel: '1 of 2 readings',
      },
    });
    expect(container.querySelector('[data-slot="trend-value-locked"]')?.textContent).toContain(
      'Log one more reading to unlock this chart.',
    );
    expect(container.querySelector('[role="img"][aria-label="1 of 2 readings"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="trend-value-plot"]')).toBeNull();
    expect(container.querySelector('.recharts-surface')).toBeNull();

    const empty = render(
      <TrendLine
        mode="value"
        points={[]}
        grain="reading"
        formatTick={String}
        formatValueFull={String}
        labels={valueLabels()}
        locked={{ have: 0, need: 2, sentence: 's', meterLabel: '0 of 2' }}
        width={640}
      />,
    );
    expect(empty.container.firstChild).toBeNull();
  });

  it('steps points from the keyboard: one tab stop, ← → / Home / End, Enter selects', () => {
    const series = buildValueSeries(gspReadings(40, 120));
    const onSelectPoint = vi.fn();
    const { container, points } = renderValue(series, { onSelectPoint });
    const plot = container.querySelector('[data-slot="trend-value-plot"]') as HTMLElement;
    expect(plot.getAttribute('role')).toBe('img');
    expect(plot.getAttribute('tabindex')).toBe('0');
    expect(plot.getAttribute('aria-label')).toBe('GSP over time');
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    const readout = () => container.querySelector('[data-slot="trend-value-readout"]')?.textContent;
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(readout()).toContain(points[points.length - 1]!.context.title);
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(readout()).toContain(points[points.length - 2]!.context.title);
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(readout()).toContain(points[0]!.context.title);
    fireEvent.keyDown(plot, { key: 'End' });
    expect(readout()).toContain(points[points.length - 1]!.context.title);
    expect(container.querySelector('[data-slot="trend-value-live"]')?.textContent).toContain(
      points[points.length - 1]!.context.title,
    );
    fireEvent.keyDown(plot, { key: 'Enter' });
    expect(onSelectPoint).toHaveBeenCalledWith(points[points.length - 1]);
    fireEvent.keyDown(plot, { key: ' ' });
    expect(onSelectPoint).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(readout()).toBeUndefined();
  });

  it('re-grains instead of squeezing: a plot under 520px draws the narrow series', () => {
    const readings = gspReadings(200, 18 * 30);
    const wide = buildValueSeries(readings, { target: 60 });
    const narrowSeries = buildValueSeries(readings, { target: 12 });
    expect(narrowSeries.points.length).toBeLessThan(wide.points.length);
    const narrowPoints = valuePointsOf(narrowSeries);

    const narrow = renderValue(
      wide,
      { narrowPoints, narrowGrain: narrowSeries.grain },
      { width: 400 },
    );
    const root = narrow.container.querySelector('[data-slot="trend-line-value"]')!;
    expect(root.getAttribute('data-narrow')).toBe('true');
    expect(root.getAttribute('data-grain')).toBe(narrowSeries.grain);
    expect(root.getAttribute('data-point-count')).toBe(String(narrowSeries.points.length));
    expect(Number(root.getAttribute('data-point-count'))).toBeLessThanOrEqual(30);
    narrow.unmount();

    const roomy = renderValue(
      wide,
      { narrowPoints, narrowGrain: narrowSeries.grain },
      { width: 800 },
    );
    const roomyRoot = roomy.container.querySelector('[data-slot="trend-line-value"]')!;
    expect(roomyRoot.getAttribute('data-narrow')).toBe('false');
    expect(roomyRoot.getAttribute('data-point-count')).toBe(String(wide.points.length));
  });

  it('WR-05: reports which series it draws (onDrawnChange), so a host describes what is on screen', () => {
    const readings = gspReadings(200, 18 * 30);
    const wide = buildValueSeries(readings, { target: 60 });
    const narrowSeries = buildValueSeries(readings, { target: 12 });
    const narrowPoints = valuePointsOf(narrowSeries);
    const onDrawnChange = vi.fn();

    const narrow = renderValue(
      wide,
      { narrowPoints, narrowGrain: narrowSeries.grain, onDrawnChange },
      { width: 400 },
    );
    expect(onDrawnChange).toHaveBeenLastCalledWith({ narrow: true });
    narrow.unmount();

    const roomy = renderValue(
      wide,
      { narrowPoints, narrowGrain: narrowSeries.grain, onDrawnChange },
      { width: 800 },
    );
    expect(onDrawnChange).toHaveBeenLastCalledWith({ narrow: false });
    roomy.unmount();
  });

  it('WR-07: the table toggle carries aria-expanded, flips on click and then names the table it controls', () => {
    const series = buildValueSeries(gspReadings(30, 90));
    const { container } = renderValue(series);
    const toggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View as table',
    )!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    expect(
      container.querySelector(`[id="${toggle.getAttribute('aria-controls')}"]`),
    ).not.toBeNull();
  });

  it('offers a table twin (date · value · readings) with column-scoped headers', () => {
    const series = buildValueSeries(gspReadings(30, 90));
    const { container, points } = renderValue(series);
    const toggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View as table',
    )!;
    fireEvent.click(toggle);
    const headers = Array.from(container.querySelectorAll('th[scope="col"]')).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(['Date', 'GSP', 'Readings']);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(points.length);
  });

  it('never builds a NaN domain from a non-finite point value (T-41-05)', () => {
    const series = buildValueSeries(gspReadings(10, 30));
    const points = valuePointsOf(series);
    points[3] = { ...points[3]!, value: Number.NaN };
    const { container } = render(
      <ChartCard title="GSP curve">
        <TrendLine
          mode="value"
          points={points}
          grain="reading"
          formatTick={String}
          formatValueFull={String}
          labels={valueLabels()}
          width={640}
          height={288}
        />
      </ChartCard>,
    );
    const domain = container
      .querySelector('[data-slot="trend-line-value"]')!
      .getAttribute('data-y-domain')!;
    expect(domain).not.toMatch(/NaN/);
    // Every point NaN: the empty path, not a NaN axis.
    const allNaN = render(
      <TrendLine
        mode="value"
        points={points.map((p) => ({ ...p, value: Number.NaN }))}
        grain="reading"
        formatTick={String}
        formatValueFull={String}
        labels={valueLabels()}
        width={640}
        height={288}
      />,
    );
    expect(allNaN.container.firstChild).toBeNull();
  });

  it('draws 1.5px at a compact height or with lineWidth thin, 2px otherwise', () => {
    const series = buildValueSeries(gspReadings(40, 120));
    const width = (container: HTMLElement) =>
      container
        .querySelector('.trend-line-value-line path.recharts-line-curve')
        ?.getAttribute('stroke-width');
    const regular = renderValue(series);
    expect(width(regular.container)).toBe('2');
    regular.unmount();
    const compact = renderValue(series, {}, { height: 160 });
    expect(width(compact.container)).toBe('1.5');
    compact.unmount();
    const thin = renderValue(series, { lineWidth: 'thin' });
    expect(width(thin.container)).toBe('1.5');
  });
});

describe('TrendLine — mode value, host-controlled cursor (plan 41-02 Task 3, RESEARCH correction 1)', () => {
  it('draws the crosshair at the host xMs, reports the nearest of ITS points on hover, and owns no readout or keys', () => {
    const series = buildValueSeries(gspReadings(30, 90), { minGrain: 'week' });
    const onChange = vi.fn();
    const points = valuePointsOf(series);
    const midMs = (points[0]!.xMs + points[1]!.xMs) / 2; // an x no point has
    const { container } = renderValue(series, { cursor: { xMs: midMs, onChange } });
    expect(container.querySelectorAll('[data-slot="trend-value-crosshair"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="trend-value-readout"]')).toBeNull();

    const target = points[3]!;
    const mark = container.querySelector(`[data-point-key="${target.key}"]`)!;
    const hit = container.querySelector('[data-slot="trend-value-hit"]')!;
    fireEvent.pointerMove(hit, { clientX: Number(mark.getAttribute('cx')), pointerType: 'mouse' });
    expect(onChange).toHaveBeenLastCalledWith(target.xMs);
    fireEvent.pointerLeave(hit, { pointerType: 'mouse' });
    expect(onChange).toHaveBeenLastCalledWith(null);

    // The host owns the keys: the panel's own handler stays out of the way.
    onChange.mockClear();
    fireEvent.keyDown(container.querySelector('[data-slot="trend-value-plot"]')!, {
      key: 'ArrowRight',
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('draws no crosshair while the host cursor is null, and omits the x tick band with drawXAxis false', () => {
    const series = buildValueSeries(gspReadings(30, 90), { minGrain: 'week' });
    const { container } = renderValue(series, {
      cursor: { xMs: null, onChange: vi.fn() },
      drawXAxis: false,
    });
    expect(container.querySelector('[data-slot="trend-value-crosshair"]')).toBeNull();
    expect(container.querySelector('[data-slot="trend-value-x-axis"]')).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  TrendLine,
  type TrendChartPoint,
  type TrendEventPoint,
  type TrendLinePeriodLabels,
} from './TrendLine';
import { ChartTooltip } from './ChartTooltip';
import { formatEventTickLabel } from './eventTicks';
import {
  estimateTickLabelWidthPx,
  formatPeriodRowLabel,
  selectPeriodTickLayout,
} from './periodTicks';
import type { PeriodPoint } from '@smash-tracker/shared';
import { PERIOD_TREND_MIN_PERIODS } from '@smash-tracker/shared';
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

const PERIOD_LABELS: TrendLinePeriodLabels = {
  lockedSentence: 'Period trend — 3 more weeks with 3+ games unlock this chart.',
  lockedCountLabel: '5 of 8 weeks',
  tableToggle: 'View as table',
  tableHeaders: { period: 'Period', record: 'Record', rate: 'Rate', sample: 'Sample' },
};

describe('TrendLine — period mode (VIZ-01, VIZ-03, UI-SPEC §7.13)', () => {
  it('renders one hollow dot per sub-floor point (fill=surface, stroke=deemphasis) and one filled dot per normal point (fill=series1, stroke=surface)', () => {
    const points = makePeriodSeries(8, (i) =>
      i === 3 || i === 4 ? { subFloor: true, total: 2, rate: 0.2 } : { rate: 0.5 },
    );
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const circles = Array.from(container.querySelectorAll('circle'));
    expect(circles).toHaveLength(8);
    circles.forEach((circle, i) => {
      const isHollow = i === 3 || i === 4;
      expect(circle.getAttribute('fill')).toBe(isHollow ? 'var(--card)' : 'var(--viz-series-1)');
      expect(circle.getAttribute('stroke')).toBe(isHollow ? 'var(--viz-context)' : 'var(--card)');
    });
  });

  it('two adjacent sub-floor points render NO line segment between them or to their neighbors — the stroke line breaks into two disjoint runs', () => {
    const points = makePeriodSeries(8, (i) =>
      i === 3 || i === 4 ? { subFloor: true, total: 2, rate: 0.2 } : { rate: 0.5 },
    );
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    const strokeLine = container.querySelector('.trend-line-period-line .recharts-line-curve');
    expect(strokeLine).not.toBeNull();
    const d = strokeLine!.getAttribute('d') ?? '';
    // Two disjoint runs of 3 consecutive points each (indices 0-2, indices
    // 5-7) — exactly 2 "M" (move-to, one per run) and exactly 4 "L"
    // (line-to: 2 segments per 3-point run). A bug that connected across the
    // gap would produce 1 "M" and 7 "L" instead.
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d.match(/L/g)).toHaveLength(4);
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
    expect(screen.getByText(PERIOD_LABELS.lockedSentence)).toBeInTheDocument();
    expect(container.querySelector('[role="img"]')).toHaveAttribute(
      'aria-label',
      PERIOD_LABELS.lockedCountLabel,
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
    const chartMargin = 5;
    const yAxisWidth = 60;
    const xPadding = 16;
    const plotWidthPx = 829;
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        width={plotWidthPx + chartMargin * 2 + yAxisWidth + xPadding * 2}
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
      expect(tick.x).toBeCloseTo(layout[j]!.x + chartMargin + yAxisWidth + xPadding, 0);
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
  function joinedWithSubFloorZero(): PeriodPoint[] {
    const joined = [0.45, 0.5, 0.55, 0.6, 0.52, 0.48, 0.58];
    return makePeriodSeries(8, (i) =>
      i === 7
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
    expect(circles).toHaveLength(8);
    const pinned = circles[7]!;
    expect(pinned.getAttribute('data-pinned')).toBe('bottom');
    expect(pinned.getAttribute('fill')).toBe('var(--card)');
    expect(pinned.getAttribute('stroke')).toBe('var(--viz-context)');
    const bottomTick = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels text'))
      .map((el) => ({ value: Number(el.textContent), y: Number(el.getAttribute('y')) }))
      .sort((a, b) => a.value - b.value)[0]!;
    expect(Number(pinned.getAttribute('cy'))).toBeCloseTo(bottomTick.y, 0);
    for (const circle of circles.slice(0, 7)) {
      expect(circle.getAttribute('data-pinned')).toBeNull();
    }

    fireEvent.click(screen.getByRole('button', { name: PERIOD_LABELS.tableToggle }));
    const lastRow = container.querySelectorAll('table tbody tr')[7]!;
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
    const points = makePeriodSeries(8, (i) =>
      i === 2 ? { subFloor: true, wins: 1, losses: 0, total: 1, rate: 1 } : { rate: 0.5 },
    );
    const { container } = render(
      <TrendLine mode="period" points={points} width={640} height={288} labels={PERIOD_LABELS} />,
    );
    expect(renderedValueLabels(container)).not.toContain('100%');
  });

  it('a series with no joined period renders no value label at all', () => {
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
    const points = makePeriodSeries(8, (i) =>
      i === 7 ? { subFloor: true, wins: 0, losses: 2, total: 2, rate: 0 } : { rate: 1 },
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

  it('period mode: a context series outside the fitted domain never re-extends it (y ticks stay 40-70)', () => {
    const joined = [0.45, 0.5, 0.55, 0.6, 0.52, 0.48, 0.58, 0.5];
    const points = makePeriodSeries(8, (i) => ({ rate: joined[i] }));
    const { container } = render(
      <TrendLine
        mode="period"
        points={points}
        contextRatePercents={[0, 100, 0, 100, 0, 100, 0, 100]}
        width={640}
        height={288}
        labels={PERIOD_LABELS}
      />,
    );
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

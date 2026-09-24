import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  TrendLine,
  type TrendChartPoint,
  type TrendEventPoint,
  type TrendLinePeriodLabels,
} from './TrendLine';
import { ChartTooltip } from './ChartTooltip';
import { formatEventTickLabel, selectEventTicks } from './eventTicks';
import { formatPeriodRowLabel, selectPeriodTickLayout } from './periodTicks';
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

  it('SPARSE (four anchors or fewer): every anchor label — mapped through the exported formatter — appears among the rendered tick texts, and each point shows its own W-L', () => {
    const keys = eventKeysFor(4);
    const points = keys.map((eventKey, i) =>
      makeEventPoint({ eventKey, wins: i, losses: 1, context: { ...makeEventPoint().context } }),
    );
    const { container } = render(
      <TrendLine mode="event" points={points} width={640} height={288} />,
    );
    const tickTexts = renderedTickTexts(container);
    for (const key of keys) {
      expect(tickTexts).toContain(formatEventTickLabel(key));
    }
    expect(container.querySelectorAll('circle')).toHaveLength(4);
    // The on-chart per-point label is a bare wins-en-dash-losses pair (D-11/ADV-02 spirit,
    // opponents.hub.trend.pointLabel — en dash per the 38-UI-SPEC Copywriting Contract).
    expect(container.textContent).toContain('0–1');
    expect(container.textContent).toContain('3–1');
  });

  it('DENSE (thirty anchors): the rendered tick labels equal the eventTicks helper output for the same keys and width, mapped through the exported formatter — strictly fewer than thirty — while thirty dots still render', () => {
    const keys = eventKeysFor(30);
    const points = keys.map((eventKey) => makeEventPoint({ eventKey }));
    const { container } = render(
      <TrendLine mode="event" points={points} width={640} height={288} />,
    );
    const expectedKeys = selectEventTicks(keys, 640);
    const expectedLabels = expectedKeys.map((key) => formatEventTickLabel(key));
    const tickTexts = renderedTickTexts(container);

    expect(expectedKeys.length).toBeLessThan(keys.length);
    expect(tickTexts).toEqual(expectedLabels);
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

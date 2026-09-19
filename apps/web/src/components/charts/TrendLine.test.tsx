import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { TrendLine, type TrendChartPoint, type TrendEventPoint } from './TrendLine';
import { ChartTooltip } from './ChartTooltip';
import { formatEventTickLabel, selectEventTicks } from './eventTicks';

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

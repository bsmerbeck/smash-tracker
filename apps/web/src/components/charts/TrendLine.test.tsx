import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { TooltipContentProps } from 'recharts';
import { TrendLine, type TrendChartPoint } from './TrendLine';
import { ChartTooltip } from './ChartTooltip';

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

/** Fills the full `TooltipContentProps` shape Recharts' `content` prop actually
 * receives — this test only cares about `active`/`payload`, but the type is
 * not optional on the rest, so every other field gets an inert default. */
function renderTooltip(overrides: Partial<TooltipContentProps<number, string>> = {}) {
  const props: TooltipContentProps<number, string> = {
    active: true,
    payload: [],
    label: undefined,
    coordinate: undefined,
    accessibilityLayer: false,
    activeIndex: null,
    ...overrides,
  };
  return render(<ChartTooltip {...props} />);
}

function tooltipPayload(point: TrendChartPoint) {
  return [{ payload: point, graphicalItemId: 'trend-line' }];
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
});

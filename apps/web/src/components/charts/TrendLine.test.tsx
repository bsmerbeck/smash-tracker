import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { TrendLine, type TrendChartPoint } from './TrendLine';

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

import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScoutGame } from '@smash-tracker/shared';
import type { TrendLineProps } from '@/components/charts/TrendLine';
import { scoutGamesToMatches } from '../lib/fullAnalysis';
import { FullAnalysisSection } from './FullAnalysisSection';
import { ScoutRecentFormCard } from './ScoutRecentFormCard';

/**
 * Plan 41-12 (SC1 / SC2, PD-12-1): the Scout Recent Form card plots an
 * event-anchored series through the kit `TrendLine mode="event"`, and any
 * plotted point lists exactly its own games in-card. Captures the props the
 * card hands `<TrendLine>` (StageDetailPage.test.tsx's prop-capture pattern):
 * the kit's own click-to-index geometry is `TrendLine.test.tsx`'s contract,
 * this only proves the card wires a working handler.
 */
let capturedTrendLineProps: TrendLineProps | undefined;
vi.mock('@/components/charts/TrendLine', async () => {
  const actual = await vi.importActual<typeof import('@/components/charts/TrendLine')>(
    '@/components/charts/TrendLine',
  );
  return {
    ...actual,
    TrendLine: (props: TrendLineProps) => {
      capturedTrendLineProps = props;
      return <div data-testid="trend-line-stub" />;
    },
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2025, 2, 1, 18);

function makeGame(overrides: Partial<ScoutGame> = {}): ScoutGame {
  return {
    time: T0,
    win: true,
    fighterId: 1,
    opponentFighterId: 41,
    stageId: 1,
    stageName: 'Battlefield',
    opponentTag: 'PowPow',
    eventName: 'Event A',
    ...overrides,
  };
}

/** Event A: 3 games, 2W 1L. Event B, ten days later: 2 games, 0W 2L. */
function twoEventGames(): ScoutGame[] {
  return [
    makeGame({ time: T0, win: true }),
    makeGame({ time: T0 + 1_000, win: true }),
    makeGame({ time: T0 + 2_000, win: false }),
    makeGame({ time: T0 + 10 * DAY_MS, win: false, eventName: 'Event B', opponentTag: 'Kola' }),
    makeGame({
      time: T0 + 10 * DAY_MS + 1_000,
      win: false,
      eventName: 'Event B',
      opponentTag: 'Kola',
    }),
  ];
}

describe('ScoutRecentFormCard through FullAnalysisSection (plan 41-12 end to end)', () => {
  it('hands TrendLine mode event with one point per event, and a point lists exactly its own games', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <FullAnalysisSection games={twoEventGames()} gamerTag="Pandem1c" />,
    );
    await user.click(screen.getByRole('button', { name: /full analysis/i }));

    expect(capturedTrendLineProps?.mode).toBe('event');
    if (capturedTrendLineProps?.mode !== 'event') throw new Error('expected event mode');
    expect(capturedTrendLineProps.points).toHaveLength(2);
    expect(typeof capturedTrendLineProps.onSelectPoint).toBe('function');
    expect(container.querySelector('[data-slot="scout-form-games"]')).toBeNull();

    const pointB = capturedTrendLineProps.points[1]!;
    const select = capturedTrendLineProps.onSelectPoint!;
    act(() => select(pointB));

    const panel = container.querySelector('[data-slot="scout-form-games"]');
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('data-count')).toBe('2');
    expect(panel!.textContent).toContain('2 games');
    expect(panel!.textContent).toContain('Event B');
    const rows = panel!.querySelectorAll('li');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).toContain('Kola');
      expect(row.textContent).toContain('Loss');
    }
    expect(container.querySelectorAll('a')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Hide games' }));
    expect(container.querySelector('[data-slot="scout-form-games"]')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
});

describe('ScoutRecentFormCard direct renders (plan 41-12)', () => {
  it('renders the empty sentence, no chart and no panel, when there are no games', () => {
    capturedTrendLineProps = undefined;
    const { container } = render(<ScoutRecentFormCard matches={[]} gamerTag="Pandem1c" />);
    expect(container.querySelector('[data-slot="scout-recent-form"]')).toBeNull();
    expect(capturedTrendLineProps).toBeUndefined();
    expect(container.textContent).toContain('Not enough');
  });

  it('a stale selected key (the report changed under the card) resolves to no panel', () => {
    const first = scoutGamesToMatches(twoEventGames());
    const { container, rerender } = render(
      <ScoutRecentFormCard matches={first} gamerTag="Pandem1c" />,
    );
    if (capturedTrendLineProps?.mode !== 'event') throw new Error('expected event mode');
    const select = capturedTrendLineProps.onSelectPoint!;
    const point = capturedTrendLineProps.points[0]!;
    act(() => select(point));
    expect(container.querySelector('[data-slot="scout-form-games"]')).not.toBeNull();

    const other = scoutGamesToMatches([
      makeGame({ time: T0 + 200 * DAY_MS, eventName: 'Event Z' }),
    ]);
    rerender(<ScoutRecentFormCard matches={other} gamerTag="Pandem1c" />);
    expect(container.querySelector('[data-slot="scout-form-games"]')).toBeNull();
    expect(container.querySelector('[data-slot="scout-recent-form"]')).not.toBeNull();
  });
});

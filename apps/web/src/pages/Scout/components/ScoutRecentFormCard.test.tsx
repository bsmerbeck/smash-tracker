import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScoutGame } from '@smash-tracker/shared';
import type { TrendLineProps } from '@/components/charts/TrendLine';
import { buildScoutFormSeries, scoutGamesToMatches } from '../lib/fullAnalysis';
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

/**
 * PD-12-3: the keyboard twin. Driven by userEvent on the real twin — no
 * TrendLine interaction involved, so the stubbed chart above changes nothing.
 */
describe('ScoutRecentFormCard table twin (plan 41-12)', () => {
  const WEEK_MS = 7 * DAY_MS;

  /** `count` games, each its own weekly event ("Weekly i"), win pattern fixed. */
  function weeklyEventMatches(count: number) {
    return scoutGamesToMatches(
      Array.from({ length: count }, (_, i) =>
        makeGame({ time: T0 + i * WEEK_MS, win: i % 3 !== 0, eventName: `Weekly ${i}` }),
      ),
    );
  }

  async function openTwin(user: ReturnType<typeof userEvent.setup>) {
    const toggle = screen.getByRole('button', { name: 'View as table' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }

  function bodyRows(container: HTMLElement) {
    return container.querySelectorAll('[data-slot="scout-form-table"] tbody tr');
  }

  it('toggles open and carries one body row per plotted point, headed "Event" at event grain', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ScoutRecentFormCard matches={weeklyEventMatches(20)} gamerTag="Pandem1c" />,
    );
    expect(container.querySelector('[data-slot="scout-form-table"]')).toBeNull();
    await openTwin(user);
    expect(bodyRows(container)).toHaveLength(20);
    expect(container.querySelector('[data-slot="scout-form-table"] thead th')?.textContent).toBe(
      'Event',
    );
  });

  it('carries the binned count (at most 60) headed "Period" at a binned grain', async () => {
    const user = userEvent.setup();
    const matches = weeklyEventMatches(100);
    const { display } = buildScoutFormSeries(matches);
    const { container } = render(<ScoutRecentFormCard matches={matches} gamerTag="Pandem1c" />);
    await openTwin(user);
    expect(bodyRows(container)).toHaveLength(display.length);
    expect(display.length).toBeLessThanOrEqual(60);
    expect(container.querySelector('[data-slot="scout-form-table"] thead th')?.textContent).toBe(
      'Period',
    );
  });

  it('Enter on a row button opens the same panel, presses only that button, focuses the heading, and a second row swaps the panel', async () => {
    const user = userEvent.setup();
    const matches = scoutGamesToMatches(twoEventGames());
    const { container } = render(<ScoutRecentFormCard matches={matches} gamerTag="Pandem1c" />);
    await openTwin(user);

    const buttons = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-slot="scout-form-table"] tbody button',
        ),
      );
    expect(buttons()).toHaveLength(2);

    buttons()[1]!.focus();
    await user.keyboard('{Enter}');
    const panel = container.querySelector('[data-slot="scout-form-games"]');
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('data-count')).toBe('2');
    expect(panel!.textContent).toContain('Event B');
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(document.activeElement).toBe(panel!.querySelector('[tabindex="-1"]'));

    buttons()[0]!.focus();
    await user.keyboard('{Enter}');
    const swapped = container.querySelector('[data-slot="scout-form-games"]');
    expect(swapped!.getAttribute('data-count')).toBe('3');
    expect(swapped!.textContent).toContain('Event A');
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });

  it.each([
    ['event', 20],
    ['month', 100],
  ])(
    'same-n at grain %s: heading count equals listed rows equals the point wins + losses',
    async (grain, events) => {
      const user = userEvent.setup();
      const matches = weeklyEventMatches(events);
      const { display, grain: actualGrain } = buildScoutFormSeries(matches);
      expect(actualGrain).toBe(grain);
      const { container } = render(<ScoutRecentFormCard matches={matches} gamerTag="Pandem1c" />);
      await openTwin(user);

      for (const index of [0, display.length - 1]) {
        const point = display[index]!;
        const expected = point.wins + point.losses;
        const button = container.querySelectorAll<HTMLButtonElement>(
          '[data-slot="scout-form-table"] tbody button',
        )[index]!;
        await user.click(button);
        const panel = container.querySelector('[data-slot="scout-form-games"]')!;
        expect(Number(panel.getAttribute('data-count'))).toBe(expected);
        expect(panel.querySelectorAll('li')).toHaveLength(expected);
        const heading = panel.querySelector('[tabindex="-1"]')!.textContent!;
        expect(heading.startsWith(`${expected} game`)).toBe(true);
      }
      if (grain === 'month') {
        expect(display.some((p) => p.wins + p.losses > 1)).toBe(true);
      }
    },
  );

  it('holds zero anchors with the twin open and a point selected', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ScoutRecentFormCard matches={scoutGamesToMatches(twoEventGames())} gamerTag="Pandem1c" />,
    );
    await openTwin(user);
    await user.click(container.querySelector('[data-slot="scout-form-table"] tbody button')!);
    expect(container.querySelector('[data-slot="scout-form-games"]')).not.toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
});

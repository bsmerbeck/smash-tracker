import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScoutGame } from '@smash-tracker/shared';
import { FullAnalysisSection } from './FullAnalysisSection';

function makeGame(overrides: Partial<ScoutGame> = {}): ScoutGame {
  return {
    time: 1_700_000_000_000,
    win: true,
    fighterId: 1, // Mario
    opponentFighterId: 41, // Sonic
    stageId: 1,
    stageName: 'Battlefield',
    opponentTag: 'PowPow',
    eventName: 'Ultimate Singles',
    ...overrides,
  };
}

describe('FullAnalysisSection', () => {
  it('shows the "re-scout" empty state when games is undefined (pre-V9-D stored report)', async () => {
    const user = userEvent.setup();
    render(<FullAnalysisSection games={undefined} gamerTag="Pandem1c" />);

    await user.click(screen.getByRole('button', { name: /full analysis/i }));
    expect(screen.getByText('Re-scout to enable full analysis.')).toBeInTheDocument();
  });

  it('shows the "no per-game data" empty state when games is an empty array', async () => {
    const user = userEvent.setup();
    render(<FullAnalysisSection games={[]} gamerTag="Pandem1c" />);

    await user.click(screen.getByRole('button', { name: /full analysis/i }));
    expect(
      screen.getByText('No per-game data available from this source yet.'),
    ).toBeInTheDocument();
  });

  it('is collapsed by default', () => {
    render(<FullAnalysisSection games={[makeGame()]} gamerTag="Pandem1c" />);
    expect(screen.queryByText('Stage Mastery — Overall')).not.toBeInTheDocument();
  });

  it('renders the full analysis once expanded, with games adapted to the stats engine', async () => {
    const user = userEvent.setup();
    const games = [
      makeGame({ time: 1, win: true }),
      makeGame({ time: 2, win: false }),
      makeGame({ time: 3, win: true }),
    ];
    render(<FullAnalysisSection games={games} gamerTag="Pandem1c" />);

    await user.click(screen.getByRole('button', { name: /full analysis/i }));

    expect(screen.getByText('Stage Mastery — Overall')).toBeInTheDocument();
    expect(screen.getByText('What They Play')).toBeInTheDocument();
    expect(screen.getByText("Pandem1c's Recent Form")).toBeInTheDocument();
    expect(screen.getByText('Opponents')).toBeInTheDocument();
    // The opponent table groups by human opponent tag, verbatim as scouted
    // (the adapter doesn't lowercase it the way manually-entered matches do).
    expect(screen.getByText('PowPow')).toBeInTheDocument();
  });

  it('does not duplicate the top-character Stage Mastery card when every game is the same character', async () => {
    const user = userEvent.setup();
    const games = [makeGame(), makeGame({ time: 2 }), makeGame({ time: 3 })];
    render(<FullAnalysisSection games={games} gamerTag="Pandem1c" />);

    await user.click(screen.getByRole('button', { name: /full analysis/i }));

    expect(screen.getByText('Stage Mastery — Overall')).toBeInTheDocument();
    expect(screen.queryByText(/Stage Mastery — Mario/)).not.toBeInTheDocument();
  });

  it('shows a per-top-character Stage Mastery card when multiple characters are present', async () => {
    const user = userEvent.setup();
    const games = [
      makeGame({ fighterId: 1, time: 1 }),
      makeGame({ fighterId: 1, time: 2 }),
      makeGame({ fighterId: 1, time: 3 }),
      makeGame({ fighterId: 2, time: 4 }), // Donkey Kong, a rarer pick
    ];
    render(<FullAnalysisSection games={games} gamerTag="Pandem1c" />);

    await user.click(screen.getByRole('button', { name: /full analysis/i }));

    expect(screen.getByText('Stage Mastery — Overall')).toBeInTheDocument();
    expect(screen.getByText('Stage Mastery — Mario')).toBeInTheDocument();
  });
});

/**
 * Plan 39.1-49 (T-39.1-49-02): on a phone the Full analysis tables render
 * their stacked roots, and the third-party-data host still renders ZERO
 * anchors — the stacked rows add no link into the viewer's own routes.
 */
describe('FullAnalysisSection — phone layout (plan 39.1-49)', () => {
  it('with (max-width: 639px) matching, OpponentTable and WhatTheyPlayTable render their stack roots and the section renders zero anchors', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(max-width: 639px)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      })),
    });
    try {
      const user = userEvent.setup();
      const games = [
        makeGame({ time: 1, win: true }),
        makeGame({ time: 2, win: false, opponentTag: 'Kola' }),
        makeGame({ time: 3, win: true }),
        makeGame({ time: 4, win: true, fighterId: 2 }),
      ];
      const { container } = render(<FullAnalysisSection games={games} gamerTag="Pandem1c" />);
      await user.click(screen.getByRole('button', { name: /full analysis/i }));
      expect(container.querySelector('ul[data-slot="opponent-table"]')).not.toBeNull();
      expect(container.querySelector('ul[data-slot="what-they-play"]')).not.toBeNull();
      expect(container.querySelector('table[data-slot="opponent-table"]')).toBeNull();
      expect(container.querySelectorAll('a')).toHaveLength(0);
    } finally {
      // @ts-expect-error — jsdom has no matchMedia; restore that default.
      delete window.matchMedia;
    }
  });
});

/**
 * Plan 41-12 (UI-SPEC §11 "a line chart shows at most 60 points"; supersedes
 * the 39.1-49 trailing-form cap): the Recent Form card plots an EVENT-ANCHORED
 * series — one point per event at or under 60 anchors, calendar bins above —
 * and the card caption names the grain. No "N of M games shown" line: every
 * sampled game sits behind exactly one plotted point.
 */
describe('FullAnalysisSection — Recent Form point cap (plan 41-12)', () => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const T0 = Date.UTC(2025, 0, 6, 18);

  function weeklyEvents(count: number): ScoutGame[] {
    return Array.from({ length: count }, (_, i) =>
      makeGame({ time: T0 + i * WEEK_MS, win: i % 3 !== 0, eventName: `Weekly ${i}` }),
    );
  }

  it('100 games over 100 weekly events plot at most 60 points at grain month; 20 events plot 20 at grain event', async () => {
    const user = userEvent.setup();
    const view = render(<FullAnalysisSection games={weeklyEvents(100)} gamerTag="Pandem1c" />);
    await user.click(screen.getByRole('button', { name: /full analysis/i }));
    const trend = view.container.querySelector('[data-slot="scout-recent-form"]');
    expect(trend).not.toBeNull();
    expect(Number(trend!.getAttribute('data-points'))).toBeLessThanOrEqual(60);
    expect(trend!.getAttribute('data-grain')).toBe('month');
    expect(screen.queryByText(/games shown/)).not.toBeInTheDocument();
    view.unmount();

    const small = render(<FullAnalysisSection games={weeklyEvents(20)} gamerTag="Pandem1c" />);
    await user.click(screen.getByRole('button', { name: /full analysis/i }));
    const smallTrend = small.container.querySelector('[data-slot="scout-recent-form"]');
    expect(smallTrend?.getAttribute('data-points')).toBe('20');
    expect(smallTrend?.getAttribute('data-grain')).toBe('event');
    expect(screen.queryByText(/games shown/)).not.toBeInTheDocument();
  });
});

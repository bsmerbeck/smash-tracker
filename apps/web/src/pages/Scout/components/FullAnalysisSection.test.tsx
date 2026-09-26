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

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { TournamentEntry } from '@smash-tracker/shared';
import { TournamentHistory } from './TournamentHistory';
import { tournamentBlockEventKey, type TournamentBlock } from '../tournamentHistory';

function makeBlock(overrides: Partial<TournamentBlock> = {}): TournamentBlock {
  return {
    displayName: 'The Big House 9',
    eventName: 'The Big House 9',
    sets: [
      {
        setId: '1',
        games: [
          {
            match: {
              id: 'm1',
              time: 100,
              win: true,
              fighter_id: 1,
              opponent_id: 10,
              map: { id: 1, name: 'Battlefield' },
              opponent: 'rival',
              notes: '',
              matchType: 'offline-tourney',
            },
            stageAbbr: 'BF',
            stageName: 'Battlefield',
            win: true,
          },
        ],
        wins: 1,
        losses: 0,
        roundLabel: 'Winners Semi-Final',
        isLosersSide: false,
        time: 100,
      },
    ],
    startTime: 100,
    endTime: 100,
    wins: 1,
    losses: 0,
    ...overrides,
  };
}

function renderHistory(
  blocks: TournamentBlock[],
  tournamentEntries: TournamentEntry[] = [],
  onSelectEvent?: (key: string) => void,
  initialPath = '/',
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TournamentHistory
        blocks={blocks}
        tournamentEntries={tournamentEntries}
        onSelectEvent={onSelectEvent}
      />
    </MemoryRouter>,
  );
}

describe('TournamentHistory', () => {
  it('renders the empty state when there are no blocks', () => {
    renderHistory([]);
    expect(
      screen.getByText(
        "No tournament sets vs this player yet — resync start.gg if you've played recently.",
      ),
    ).toBeInTheDocument();
  });

  it("a set row's activation writes the same event-anchor key the hub's trend clicks write", async () => {
    const user = userEvent.setup();
    const onSelectEvent = vi.fn();
    const block = makeBlock();
    renderHistory([block], [], onSelectEvent);

    await user.click(screen.getByRole('button', { name: /Winners Semi-Final/ }));
    expect(onSelectEvent).toHaveBeenCalledWith(tournamentBlockEventKey(block));
  });

  it('a block with no resolvable tournament entry keeps its plain-title branch', () => {
    renderHistory([makeBlock()], []);
    expect(screen.getByText('The Big House 9')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'The Big House 9' })).not.toBeInTheDocument();
  });

  it('routes the block header link through the subject-aware builder, carrying the coach prefix', () => {
    const entries: TournamentEntry[] = [
      {
        entryKey: 'big-house-9',
        eventName: 'The Big House 9',
        firstSetAt: 0,
        lastSetAt: 200,
        setsPlayed: 1,
      },
    ];
    renderHistory([makeBlock()], entries, undefined, '/coach/client-a/opponents/rival');
    const link = screen.getByRole('link', { name: 'The Big House 9' });
    expect(link).toHaveAttribute('href', '/coach/client-a/tournaments/big-house-9');
  });

  it('a row stays plain when no onSelectEvent is supplied', () => {
    renderHistory([makeBlock()]);
    expect(screen.queryByRole('button', { name: /Winners Semi-Final/ })).not.toBeInTheDocument();
    expect(screen.getByText('Winners Semi-Final')).toBeInTheDocument();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match } from '@smash-tracker/shared';
import { OpponentList } from './OpponentList';

function makeMatch(
  overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win' | 'opponent'>,
): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    map: { id: 1, name: 'Battlefield' },
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

/**
 * alice: 4 games (3-1), most played, oldest activity.
 * bob:   2 games (0-2), most recent activity, lowest win rate.
 * cara:  1 game  (1-0), 100% win rate, small sample.
 */
const MATCHES: Match[] = [
  makeMatch({ id: 'a1', time: 100, win: true, opponent: 'alice' }),
  makeMatch({ id: 'a2', time: 200, win: true, opponent: 'alice' }),
  makeMatch({ id: 'a3', time: 300, win: true, opponent: 'alice' }),
  makeMatch({ id: 'a4', time: 400, win: false, opponent: 'alice' }),
  makeMatch({ id: 'b1', time: 900, win: false, opponent: 'bob' }),
  makeMatch({ id: 'b2', time: 1000, win: false, opponent: 'bob' }),
  makeMatch({ id: 'c1', time: 500, win: true, opponent: 'cara' }),
];

function renderList() {
  return render(
    <OpponentList
      matches={MATCHES}
      selected={null}
      onSelect={vi.fn()}
      onRequestMerge={vi.fn()}
      aliasMap={{}}
    />,
  );
}

function rowNames(): string[] {
  const list = screen.getByRole('list', { name: 'Opponents' });
  return within(list)
    .getAllByRole('listitem')
    .map((li) => within(li).getByTitle(/.+/).textContent ?? '');
}

describe('OpponentList sorting and filtering', () => {
  it('defaults to most played', () => {
    renderList();
    expect(rowNames()).toEqual(['alice', 'bob', 'cara']);
  });

  it('sorts by most recent activity', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('combobox', { name: 'Sort opponents' }));
    await user.click(screen.getByRole('option', { name: 'Recently played' }));
    expect(rowNames()).toEqual(['bob', 'cara', 'alice']);
  });

  it('sorts by highest and lowest win rate', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('combobox', { name: 'Sort opponents' }));
    await user.click(screen.getByRole('option', { name: 'Highest win rate' }));
    expect(rowNames()).toEqual(['cara', 'alice', 'bob']);

    await user.click(screen.getByRole('combobox', { name: 'Sort opponents' }));
    await user.click(screen.getByRole('option', { name: 'Lowest win rate' }));
    expect(rowNames()).toEqual(['bob', 'alice', 'cara']);
  });

  it('sorts alphabetically', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('combobox', { name: 'Sort opponents' }));
    await user.click(screen.getByRole('option', { name: 'A → Z' }));
    expect(rowNames()).toEqual(['alice', 'bob', 'cara']);
  });

  it('the 3+ games toggle hides small samples', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(
      screen.getByRole('button', { name: 'Only show opponents with 3 or more games' }),
    );
    expect(rowNames()).toEqual(['alice']);
    // The header count still reflects everyone faced, not the filtered view.
    expect(screen.getByText('3 opponents faced')).toBeInTheDocument();
  });
});

// Phase 36 (EVID-12, R2-MEDIUM-1, R3-MEDIUM-1): the migration to
// buildOpponentEvidence re-keys the per-opponent lookups by resolved
// identity — these assertions are ADDED (not edits to the fixture above),
// so they don't violate the "existing assertions pass unedited" rule.
describe('OpponentList alias-merged identity (EVID-12)', () => {
  it('sorts an alias-merged opponent by their latest game across all tags and renders a mixed source badge on the list row', async () => {
    const user = userEvent.setup();
    const matches: Match[] = [
      makeMatch({ id: 'd1', time: 100, win: true, opponent: 'dave' }),
      makeMatch({ id: 'd2', time: 200, win: true, opponent: 'dave' }),
      makeMatch({
        id: 'd3',
        time: 5000,
        win: true,
        opponent: 'daveovertime',
        source: 'startgg',
      }),
      makeMatch({ id: 'e1', time: 3000, win: false, opponent: 'ellis' }),
    ];
    render(
      <OpponentList
        matches={matches}
        selected={null}
        onSelect={vi.fn()}
        onRequestMerge={vi.fn()}
        aliasMap={{ daveovertime: 'dave' }}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Sort opponents' }));
    await user.click(screen.getByRole('option', { name: 'Recently played' }));
    // "dave"'s latest game (across both tags) is time 5000 — newer than
    // "ellis"'s single game at time 3000.
    expect(rowNames()).toEqual(['dave', 'ellis']);

    const list = screen.getByRole('list', { name: 'Opponents' });
    const daveRow = within(list).getAllByRole('listitem')[0]!;
    expect(within(daveRow).getByLabelText('mixed sources')).toBeInTheDocument();
  });
});

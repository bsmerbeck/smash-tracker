import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { PairingOpponentSplit } from './PairingOpponentSplit';

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

describe('PairingOpponentSplit', () => {
  it('shows an empty message when there are no named opponents', () => {
    render(<PairingOpponentSplit matchupMatches={[]} />);
    expect(
      screen.getByText('No named opponents recorded for this matchup yet.'),
    ).toBeInTheDocument();
  });

  it('groups by human opponent and shows each record', () => {
    const matches = [
      makeMatch({ id: 'm1', opponent: 'alice', win: true }),
      makeMatch({ id: 'm2', opponent: 'alice', win: false }),
      makeMatch({ id: 'm3', opponent: 'bob', win: true }),
    ];
    render(<PairingOpponentSplit matchupMatches={matches} />);

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText(/1-1 \(50%\)/)).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText(/1-0 \(100%\)/)).toBeInTheDocument();
  });

  it('sorts by games played descending and caps at the top 5', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const matches: Match[] = [];
    names.forEach((name, i) => {
      // Give the last-added opponent ('f') the most games so ordering is unambiguous.
      const gameCount = i + 1;
      for (let g = 0; g < gameCount; g++) {
        matches.push(makeMatch({ id: `${name}-${g}`, opponent: name, win: true }));
      }
    });

    render(<PairingOpponentSplit matchupMatches={matches} />);

    // 'a' had the fewest games (1) and should be excluded from the top 5.
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.getByText('f')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });
});

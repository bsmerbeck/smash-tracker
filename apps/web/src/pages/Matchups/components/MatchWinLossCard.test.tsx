import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { MatchWinLossCard } from './MatchWinLossCard';

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

describe('MatchWinLossCard', () => {
  it('with an empty match array renders the existing record-empty string and no pips element', () => {
    render(<MatchWinLossCard matchupMatches={[]} />);

    expect(screen.getByText('No reported matches against this fighter')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Last \d+ results/)).not.toBeInTheDocument();
  });

  it('with matches renders the record title, the three stat labels in order, and one pips element', () => {
    render(
      <MatchWinLossCard
        matchupMatches={[
          makeMatch({ id: 'm1', win: true }),
          makeMatch({ id: 'm2', win: true }),
          makeMatch({ id: 'm3', win: false }),
        ]}
      />,
    );

    expect(screen.getByText('Record')).toBeInTheDocument();

    const labels = ['Wins', 'Total Matches', 'Losses'];
    const labelElements = labels.map((label) => screen.getByText(label));
    // Order-preserving: wins, total, losses — matching the existing order.
    const positions = labelElements.map((el) =>
      Array.from(el.parentElement?.parentElement?.children ?? []).indexOf(el.parentElement!),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    expect(screen.getByText('2')).toBeInTheDocument(); // wins
    expect(screen.getByText('3')).toBeInTheDocument(); // total
    expect(screen.getByText('1')).toBeInTheDocument(); // losses

    expect(screen.getByLabelText('Last 3 results, newest first')).toBeInTheDocument();
  });
});

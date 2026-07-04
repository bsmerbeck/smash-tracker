import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Fighter, Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { RosterUsage } from './RosterUsage';

const roster = SpriteList.slice(0, 12);

function makeMatch(fighterId: number, win: boolean, id: string): Match {
  return {
    id,
    fighter_id: fighterId,
    opponent_id: roster[0]!.id,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win,
  };
}

function matchesFor(fighter: Fighter, wins: number, losses: number): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < wins; i++) matches.push(makeMatch(fighter.id, true, `${fighter.id}-w${i}`));
  for (let i = 0; i < losses; i++)
    matches.push(makeMatch(fighter.id, false, `${fighter.id}-l${i}`));
  return matches;
}

describe('RosterUsage', () => {
  it('shows an empty state when there is no match data', () => {
    render(<RosterUsage matches={[]} fighterSprites={roster.slice(0, 2)} />);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('orders rows by usage (games played) descending', () => {
    const [a, b] = roster;
    const matches = [...matchesFor(a!, 2, 0), ...matchesFor(b!, 5, 0)];

    render(<RosterUsage matches={matches} fighterSprites={[a!, b!]} />);

    const images = screen.getAllByRole('listitem').map((li) => li.querySelector('img'));
    // b has more games (5) so should render first.
    expect(images[0]).toHaveAttribute('src', b!.url);
    expect(images[1]).toHaveAttribute('src', a!.url);
  });

  it('shows win-rate chips with the "W-L · rate% (n)" shape', () => {
    const fighter = roster[0]!;
    const matches = matchesFor(fighter, 6, 4); // 60% win rate, 10 games

    render(<RosterUsage matches={matches} fighterSprites={[fighter]} />);

    expect(screen.getByText('6-4 · 60% (10)')).toBeInTheDocument();
  });

  it('applies the positive tone at 55% or above', () => {
    const fighter = roster[0]!;
    const matches = matchesFor(fighter, 11, 9); // 55%
    render(<RosterUsage matches={matches} fighterSprites={[fighter]} />);
    expect(screen.getByText('11-9 · 55% (20)')).toHaveClass('text-emerald-500');
  });

  it('applies the destructive tone below 45%', () => {
    const fighter = roster[0]!;
    const matches = matchesFor(fighter, 4, 6); // 40%
    render(<RosterUsage matches={matches} fighterSprites={[fighter]} />);
    expect(screen.getByText('4-6 · 40% (10)')).toHaveClass('text-destructive');
  });

  it('applies the neutral tone between 45% and 55%', () => {
    const fighter = roster[0]!;
    const matches = matchesFor(fighter, 1, 1); // 50%
    render(<RosterUsage matches={matches} fighterSprites={[fighter]} />);
    expect(screen.getByText('1-1 · 50% (2)')).toHaveClass('text-muted-foreground');
  });

  it('caps the visible list at 10 rows and offers a "show all" expander', async () => {
    const user = userEvent.setup();
    const matches = roster.flatMap((fighter, i) => matchesFor(fighter, i + 1, 0));

    render(<RosterUsage matches={matches} fighterSprites={roster} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    const expandButton = screen.getByRole('button', { name: /show all/i });
    expect(expandButton).toHaveTextContent('Show all (2 more)');

    await user.click(expandButton);

    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('does not show the expander when there are 10 or fewer fighters', () => {
    const matches = roster.slice(0, 5).flatMap((fighter, i) => matchesFor(fighter, i + 1, 0));

    render(<RosterUsage matches={matches} fighterSprites={roster.slice(0, 5)} />);

    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });
});

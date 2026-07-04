import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { CharactersAndStages } from './CharactersAndStages';
import { SpriteList } from '@/data/sprites';

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi
const fox = SpriteList.find((s) => s.id === 15)!; // Fox

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

describe('CharactersAndStages', () => {
  it('shows empty states for all three cards when there are no matches', () => {
    render(<CharactersAndStages matches={[]} />);
    expect(screen.getAllByText('No games recorded.')).toHaveLength(2);
    expect(screen.getByText('No stage data recorded.')).toBeInTheDocument();
  });

  it('lists your characters with per-character W-L', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id }),
      makeMatch({ id: 'm2', time: 2, win: false, fighter_id: mario.id }),
      makeMatch({ id: 'm3', time: 3, win: true, fighter_id: fox.id }),
    ];
    render(<CharactersAndStages matches={matches} />);

    expect(screen.getByText('Your Characters')).toBeInTheDocument();
    expect(screen.getByText(mario.name)).toBeInTheDocument();
    expect(screen.getByText(fox.name)).toBeInTheDocument();
    expect(screen.getByText('1-1 · 2 games')).toBeInTheDocument();
    expect(screen.getByText('1-0 · 1 game')).toBeInTheDocument();
  });

  it('lists opponents’ characters faced', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 1, win: true, opponent_id: luigi.id }),
      makeMatch({ id: 'm2', time: 2, win: true, opponent_id: fox.id }),
    ];
    render(<CharactersAndStages matches={matches} />);

    expect(screen.getByText(/Opponents/)).toBeInTheDocument();
    expect(screen.getByText(luigi.name)).toBeInTheDocument();
    expect(screen.getByText(fox.name)).toBeInTheDocument();
  });

  it('lists stages played, excluding the unknown-stage sentinel', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
      makeMatch({ id: 'm2', time: 2, win: false, map: { id: 0, name: 'no selection' } }),
    ];
    render(<CharactersAndStages matches={matches} />);

    expect(screen.getByText('Stages Played')).toBeInTheDocument();
    expect(screen.getByText('Battlefield')).toBeInTheDocument();
    expect(screen.queryByText('no selection')).not.toBeInTheDocument();
  });
});

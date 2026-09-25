import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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

function renderCharactersAndStages(
  matches: Match[],
  stageAggregateLinkParams?: (
    stageId: number,
  ) => { eventKey?: string; from?: number; to?: number } | undefined,
  initialPath = '/',
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <CharactersAndStages matches={matches} stageAggregateLinkParams={stageAggregateLinkParams} />
    </MemoryRouter>,
  );
}

describe('CharactersAndStages', () => {
  it('shows empty states for all three cards when there are no matches', () => {
    renderCharactersAndStages([]);
    expect(screen.getAllByText('No games recorded.')).toHaveLength(2);
    expect(screen.getByText('No stage data recorded.')).toBeInTheDocument();
  });

  it('lists your characters with per-character W-L', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id }),
      makeMatch({ id: 'm2', time: 2, win: false, fighter_id: mario.id }),
      makeMatch({ id: 'm3', time: 3, win: true, fighter_id: fox.id }),
    ];
    renderCharactersAndStages(matches);

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
    renderCharactersAndStages(matches);

    expect(screen.getByText(/Opponents/)).toBeInTheDocument();
    expect(screen.getByText(luigi.name)).toBeInTheDocument();
    expect(screen.getByText(fox.name)).toBeInTheDocument();
  });

  it('lists stages played, excluding the unknown-stage sentinel', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
      makeMatch({ id: 'm2', time: 2, win: false, map: { id: 0, name: 'no selection' } }),
    ];
    renderCharactersAndStages(matches);

    expect(screen.getByText('Stages Played')).toBeInTheDocument();
    expect(screen.getByText('Battlefield')).toBeInTheDocument();
    expect(screen.queryByText('no selection')).not.toBeInTheDocument();
  });

  describe('D-14: uniform drillable rows', () => {
    it('a your-character row opens the param-aware Matchups page with the fighter axis', () => {
      const matches = [makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id })];
      renderCharactersAndStages(matches);
      const link = screen.getByRole('link', { name: new RegExp(mario.name) });
      expect(link).toHaveAttribute('href', `/matchups?fighter=${mario.id}`);
    });

    it('an opponent-character row opens the param-aware Matchups page with the vs axis', () => {
      const matches = [makeMatch({ id: 'm1', time: 1, win: true, opponent_id: luigi.id })];
      renderCharactersAndStages(matches);
      const link = screen.getByRole('link', { name: new RegExp(luigi.name) });
      expect(link).toHaveAttribute('href', `/matchups?vs=${luigi.id}`);
    });

    it('a stage row opens the stage detail page with the event axis looked up per-stage (CR-03)', () => {
      const matches = [
        makeMatch({ id: 'm1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
      ];
      renderCharactersAndStages(matches, (stageId) =>
        stageId === 1 ? { eventKey: 'tournament:ultimate singles:1' } : undefined,
      );
      const link = screen.getByRole('link', { name: /Battlefield/ });
      expect(link).toHaveAttribute('href', '/stages/1?event=tournament%3Aultimate+singles%3A1');
    });

    it('a stage row with no resolved anchor for its stage opens the plain stage detail page', () => {
      const matches = [
        makeMatch({ id: 'm1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
      ];
      renderCharactersAndStages(matches, () => undefined);
      const link = screen.getByRole('link', { name: /Battlefield/ });
      expect(link).toHaveAttribute('href', '/stages/1');
    });

    it('carries the coach prefix through every destination', () => {
      const matches = [
        makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
      ];
      renderCharactersAndStages(matches, undefined, '/coach/client-a/tournaments/1');
      expect(screen.getByRole('link', { name: new RegExp(mario.name) })).toHaveAttribute(
        'href',
        `/coach/client-a/matchups?fighter=${mario.id}`,
      );
    });
  });
});

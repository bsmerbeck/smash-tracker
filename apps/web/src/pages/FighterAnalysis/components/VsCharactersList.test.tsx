import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { VsCharactersList } from './VsCharactersList';

const mario = SpriteList.find((s) => s.id === 1)!;

function makeMatch(
  overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win' | 'opponent_id'>,
): Match {
  return {
    fighter_id: mario.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function renderList(fighterMatches: Match[]) {
  return render(
    <MemoryRouter>
      <VsCharactersList fighterId={mario.id} fighterMatches={fighterMatches} />
    </MemoryRouter>,
  );
}

/** 30 distinct opponent characters, each with 6 games — over LIST_INLINE_MAX(25) once combined with the cap-expand ladder, to exercise the terminus branch. */
function manyOpponentsFixture(): Match[] {
  const now = Date.now();
  const matches: Match[] = [];
  let id = 0;
  for (let opponentId = 2; opponentId <= 31; opponentId++) {
    for (let g = 0; g < 6; g++) {
      matches.push(
        makeMatch({
          id: `m${id++}`,
          time: now - (200 - id) * 60 * 60 * 1000,
          win: g % 2 === 0,
          opponent_id: opponentId,
        }),
      );
    }
  }
  return matches;
}

/** A single opponent character with fewer than the abstention floor's worth of recent games (but a real all-time record). */
function subFloorFixture(): Match[] {
  const now = Date.now();
  return Array.from({ length: 5 }, (_, i) =>
    makeMatch({
      id: `s${i}`,
      time: now - (5 - i) * 60 * 60 * 1000,
      win: i % 2 === 0,
      opponent_id: 2,
    }),
  );
}

describe('VsCharactersList', () => {
  it('caps at five rows with a show-all control at more than five opponents', () => {
    renderList(manyOpponentsFixture());
    const rows = document.querySelectorAll('[data-slot="dumbbell-track"]');
    expect(rows.length).toBe(5);
    expect(screen.getByRole('button', { name: /show all/i })).toBeInTheDocument();
  });

  it('expands to a terminus link at more than 25 opponents', () => {
    renderList(manyOpponentsFixture());
    screen.getByRole('button', { name: /show all/i }).click();
    const terminus = screen.getByRole('link', { name: /all .* matchups/i });
    expect(terminus).toBeInTheDocument();
    expect(terminus.getAttribute('href')).toMatch(/\/matchups/);
  });

  it('every row is a link with a non-empty accessible name whose destination carries the fighter axis', () => {
    renderList(manyOpponentsFixture());
    const links = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.includes('/matchups'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('aria-label') ?? link.textContent).toBeTruthy();
      expect(link.getAttribute('href')).toMatch(/fighter=1/);
    }
  });

  it('a row whose recent sample is below the abstention floor renders no recent dot and no range bar', () => {
    renderList(subFloorFixture());
    expect(document.querySelector('[data-slot="dumbbell-recent-dot"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="dumbbell-range"]')).not.toBeInTheDocument();
    // The baseline tick (always shown) is still present.
    expect(document.querySelector('[data-slot="dumbbell-baseline-tick"]')).toBeInTheDocument();
  });

  it('states its sort order and window in the meta line', () => {
    renderList(manyOpponentsFixture());
    expect(screen.getByText(/most games first/i)).toBeInTheDocument();
    expect(screen.getByText(/last 30/i)).toBeInTheDocument();
  });

  it('renders the declared empty copy with no controls when the fighter has no opponents', () => {
    renderList([]);
    expect(screen.getByText(/no character data/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });
});

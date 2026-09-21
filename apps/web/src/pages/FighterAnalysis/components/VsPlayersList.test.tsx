import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { VsPlayersList } from './VsPlayersList';

const mario = SpriteList.find((s) => s.id === 1)!;

function makeMatch(
  overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win' | 'opponent'>,
): Match {
  return {
    fighter_id: mario.id,
    opponent_id: 2,
    map: { id: 1, name: 'Battlefield' },
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function renderList(fighterMatches: Match[], aliasMap: Record<string, string> = {}) {
  return render(
    <MemoryRouter>
      <VsPlayersList fighterId={mario.id} fighterMatches={fighterMatches} aliasMap={aliasMap} />
    </MemoryRouter>,
  );
}

/** 30 distinct opponent tags, each with 6 games. */
function manyOpponentsFixture(): Match[] {
  const now = Date.now();
  const matches: Match[] = [];
  let id = 0;
  for (let n = 0; n < 30; n++) {
    for (let g = 0; g < 6; g++) {
      matches.push(
        makeMatch({
          id: `m${id++}`,
          time: now - (300 - id) * 60 * 60 * 1000,
          win: g % 2 === 0,
          opponent: `rival${n}`,
        }),
      );
    }
  }
  return matches;
}

/** A single opponent under `ABSTENTION_FLOOR_GAMES` (3) — a real all-time record, but too few recent games. */
function subFloorFixture(): Match[] {
  const now = Date.now();
  return Array.from({ length: 2 }, (_, i) =>
    makeMatch({
      id: `s${i}`,
      time: now - (2 - i) * 60 * 60 * 1000,
      win: i % 2 === 0,
      opponent: 'rival',
    }),
  );
}

describe('VsPlayersList', () => {
  it('caps at five rows with a show-all control at more than five opponents', () => {
    renderList(manyOpponentsFixture());
    const rows = document.querySelectorAll('[data-slot="dumbbell-track"]');
    expect(rows.length).toBe(5);
    expect(screen.getByRole('button', { name: /show all/i })).toBeInTheDocument();
  });

  it('expands to a terminus link at more than 25 opponents', () => {
    renderList(manyOpponentsFixture());
    fireEvent.click(screen.getByRole('button', { name: /show all/i }));
    const terminus = screen.getByRole('link', { name: /all .* opponents/i });
    expect(terminus).toBeInTheDocument();
    expect(terminus.getAttribute('href')).toMatch(/\/opponents/);
  });

  it('every row is a link with a non-empty accessible name whose destination carries the fighter axis', () => {
    renderList(manyOpponentsFixture());
    const links = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.includes('/opponents/'));
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
    expect(document.querySelector('[data-slot="dumbbell-baseline-tick"]')).toBeInTheDocument();
  });

  it('states its sort order and window in the meta line', () => {
    renderList(manyOpponentsFixture());
    expect(screen.getByText(/most games first/i)).toBeInTheDocument();
    expect(screen.getByText(/last 30/i)).toBeInTheDocument();
  });

  it('renders the declared empty copy with no controls when the fighter has no opponents', () => {
    renderList([]);
    expect(screen.getByText(/no opponent data/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });
});

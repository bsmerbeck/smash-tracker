import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

/** A single opponent character under `ABSTENTION_FLOOR_GAMES` (3) — a real all-time record, but too few recent games. */
function subFloorFixture(): Match[] {
  const now = Date.now();
  return Array.from({ length: 2 }, (_, i) =>
    makeMatch({
      id: `s${i}`,
      time: now - (2 - i) * 60 * 60 * 1000,
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
    fireEvent.click(screen.getByRole('button', { name: /show all/i }));
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

  it('WR-C01: a locked row (below abstention floor) never renders "Thin" in its delta chip', () => {
    renderList(subFloorFixture());
    expect(screen.queryByText('Thin')).not.toBeInTheDocument();
  });

  describe('plan 39.1-36 (honest-none-chip): sub-floor rows state their window size, never a direction', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function chipOf(): HTMLElement | null {
      return document.querySelector('[data-slot="delta-chip"]');
    }

    it('a row with 2 recent games reads "n 2 · no direction" (the list meta names the horizon)', () => {
      renderList(subFloorFixture());
      const chip = chipOf();
      expect(chip).not.toBeNull();
      expect(chip!.getAttribute('data-state')).toBe('thin');
      expect(chip!.getAttribute('data-recent-games')).toBe('2');
      expect(chip!.textContent).toBe('n 2 · no direction');
    });

    it('a row with 5 recent games reads "n 5 · no direction", never "Thin"', () => {
      const now = Date.now();
      const matches = [
        ...Array.from({ length: 20 }, (_, i) =>
          makeMatch({
            id: `old${i}`,
            time: now - (500 + i) * DAY_MS,
            win: i % 2 === 0,
            opponent_id: 2,
          }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          makeMatch({ id: `new${i}`, time: now - (5 - i) * DAY_MS, win: true, opponent_id: 2 }),
        ),
      ];
      renderList(matches);
      expect(chipOf()!.textContent).toBe('n 5 · no direction');
      expect(screen.queryByText('Thin')).not.toBeInTheDocument();
    });

    it('a stale row (every game older than 12 months) reads "none in the last 12 months", never "no games" (UAT review WR-03, F17)', () => {
      const now = Date.now();
      const matches = Array.from({ length: 12 }, (_, i) =>
        makeMatch({
          id: `stale${i}`,
          time: now - (400 + i) * DAY_MS,
          win: i % 2 === 0,
          opponent_id: 2,
        }),
      );
      renderList(matches);
      const chip = chipOf();
      expect(chip).not.toBeNull();
      expect(chip!.getAttribute('data-state')).toBe('none');
      expect(chip!.textContent).toBe('none in the last 12 months');
      expect(chip!.textContent).not.toMatch(/no games/);
    });
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

describe('plan 39.1-54 (UAT 39.1-26 F2): rows sort by the games they print', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** A: 34 all-time, 13 inside the scoped window; B: 30 in window; C: 9; D: 7; E: 5; F: sub-floor (2 recent, 40 all-time — prints its all-time record). */
  function printedSortFixture(): Match[] {
    const now = Date.now();
    const matches: Match[] = [];
    let id = 0;
    const add = (key: number, recent: number, old: number) => {
      for (let i = 0; i < old; i++) {
        matches.push(
          makeMatch({
            id: `p${id++}`,
            time: now - (400 + i) * DAY_MS,
            win: i % 2 === 0,
            opponent_id: key,
          }),
        );
      }
      for (let i = 0; i < recent; i++) {
        matches.push(
          makeMatch({
            id: `p${id++}`,
            time: now - (recent - i) * DAY_MS,
            win: i % 3 !== 0,
            opponent_id: key,
          }),
        );
      }
    };
    add(2, 13, 21);
    add(3, 30, 0);
    add(4, 9, 0);
    add(5, 7, 0);
    add(6, 5, 0);
    add(7, 2, 38);
    return matches;
  }

  function printedGames(): number[] {
    return Array.from(document.querySelectorAll('[data-slot="record"]')).map((node) => {
      const match = /(\d+)–(\d+)/.exec(node.textContent ?? '');
      expect(match).not.toBeNull();
      return Number(match![1]) + Number(match![2]);
    });
  }

  it('the printed game counts are non-increasing down the list, the sub-floor row by its printed all-time count', () => {
    renderList(printedSortFixture());
    fireEvent.click(screen.getByRole('button', { name: /show all/i }));
    expect(printedGames()).toEqual([40, 30, 13, 9, 7, 5]);
  });
});

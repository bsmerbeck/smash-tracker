import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { PairingOpponents } from './PairingOpponents';

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

function opponentsFixture(count: number): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < count; i++) {
    // Descending game counts (count-i games each) so every opponent is
    // distinct and none tie on total, keeping BoundedList's row ORDER
    // deterministic across a re-render.
    const games = count - i;
    for (let g = 0; g < games; g++) {
      matches.push(makeMatch({ id: `o${i}-${g}`, opponent: `opponent${i}`, win: g % 2 === 0 }));
    }
  }
  return matches;
}

function renderPairing(matches: Match[]) {
  return render(
    <MemoryRouter>
      <PairingOpponents matchupMatches={matches} />
    </MemoryRouter>,
  );
}

describe('PairingOpponents (owner note 11, UIX-02, INS-05)', () => {
  it('with no opponents renders the existing empty copy and no expansion control or insight card', () => {
    renderPairing([]);
    expect(
      screen.getByText('No named opponents recorded for this matchup yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('caps at 8 rows with 12 opponents, expanding inline to all 12 on activation', async () => {
    const user = userEvent.setup();
    renderPairing(opponentsFixture(12));

    expect(screen.getAllByRole('link').length).toBe(8);
    await user.click(screen.getByRole('button', { name: /show all 12/i }));
    expect(screen.getAllByRole('link').length).toBe(12);
  });

  it('with 30 opponents the first activation renders 25 rows and hands off to a terminus link', async () => {
    const user = userEvent.setup();
    renderPairing(opponentsFixture(30));

    expect(screen.getAllByRole('link').length).toBe(8);
    await user.click(screen.getByRole('button', { name: /show all 30/i }));
    // 25 opponent rows + 1 terminus anchor ("All 30 opponents →").
    expect(screen.getAllByRole('link').length).toBe(26);
    expect(screen.getByRole('link', { name: /all 30 opponents/i })).toBeInTheDocument();
  });

  it('WR-C01: a locked opponent row (below abstention floor) never renders "Thin" in its delta chip', () => {
    // A single opponent tag with 2 recorded games -> record.total(2) <
    // ABSTENTION_FLOOR_GAMES(3): the honesty ladder's `locked` state, a
    // different tier than `thin`.
    renderPairing([
      makeMatch({ id: 'r1', opponent: 'rival', win: true }),
      makeMatch({ id: 'r2', opponent: 'rival', win: false }),
    ]);
    expect(screen.queryByText('Thin')).not.toBeInTheDocument();
  });

  it('every rendered row is a link with a non-empty accessible name', () => {
    renderPairing(opponentsFixture(8));
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAccessibleName();
      expect(link.getAttribute('href')).not.toBeNull();
    }
  });

  it("each row's destination contains the fighter and opponent-character axes", () => {
    renderPairing([makeMatch({ opponent: 'onlyOne' })]);
    const link = screen.getByRole('link');
    const href = link.getAttribute('href') ?? '';
    expect(href).toMatch(/fighter=1/);
    expect(href).toMatch(/vs=10/);
    expect(href).toMatch(/^\/opponents\/onlyOne/);
  });

  it('a tag recorded in lower case renders in lower case — no display transform', () => {
    renderPairing([makeMatch({ opponent: 'lowercasetag' })]);
    expect(screen.getByText('lowercasetag')).toBeInTheDocument();
  });

  it('the tag element carries a title with the full string', () => {
    renderPairing([makeMatch({ opponent: 'a-fairly-long-opponent-tag-name' })]);
    const tag = screen.getByText('a-fairly-long-opponent-tag-name');
    expect(tag).toHaveAttribute('title', 'a-fairly-long-opponent-tag-name');
  });

  describe('item 12 (plan 39.1-32): the tag owns its own line above a whole-token metrics line below a 480px row', () => {
    it("every row's li holds one pairing-opponent-body whose children are, in order, the tag then the metrics group; the body is flex-col with the 480px row-cohesion breakpoint; the chevron is the li's last child", () => {
      renderPairing([makeMatch({ opponent: 'onlyOne' })]);
      const li = screen.getByRole('listitem');
      const body = li.querySelector('[data-slot="pairing-opponent-body"]') as HTMLElement;
      expect(body).not.toBeNull();
      expect(body.className).toMatch(/\bflex-col\b/);
      expect(body.className).toMatch(/@min-\[480px\]\/pairing-opponent-row:flex-row/);

      const bodyChildren = Array.from(body.children) as HTMLElement[];
      expect(bodyChildren).toHaveLength(2);
      expect(bodyChildren[0]!.getAttribute('data-slot')).toBe('pairing-opponent-tag');
      expect(bodyChildren[1]!.getAttribute('data-slot')).toBe('pairing-opponent-metrics');

      const metrics = bodyChildren[1]!;
      expect(metrics.className).toMatch(/\bflex-wrap\b/);
      expect(metrics.textContent).toContain('1–0');

      expect(body.contains(bodyChildren[0]!)).toBe(true);
      // The tag is not inside the metrics group.
      expect(metrics.querySelector('[data-slot="pairing-opponent-tag"]')).toBeNull();

      // The chevron (a lucide ChevronRight <svg>, aria-hidden) is the li's
      // last element child.
      expect(li.lastElementChild?.tagName.toLowerCase()).toBe('svg');
      expect(li.lastElementChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('the RecordBar wrapper drops below a 300px row and the Record wrapper drops below a 220px row (§6.5 rule 3 last-resort)', () => {
      renderPairing([makeMatch({ opponent: 'onlyOne' })]);
      const li = screen.getByRole('listitem');
      const metrics = li.querySelector('[data-slot="pairing-opponent-metrics"]')!;
      const recordBarWrapper = metrics.children[0] as HTMLElement;
      const recordWrapper = metrics.children[1] as HTMLElement;
      expect(recordBarWrapper.className).toMatch(/@max-\[300px\]\/pairing-opponent-row:hidden/);
      expect(recordWrapper.className).toMatch(/@max-\[220px\]\/pairing-opponent-row:hidden/);
    });
  });
});

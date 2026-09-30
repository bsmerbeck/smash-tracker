import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { PairingOpponents } from './PairingOpponents';

/** A fixed as-of clock: every "last 12 months" window in these cases is measured from it. */
const NOW_MS = Date.UTC(2026, 8, 25);
const DAY_MS = 24 * 3_600_000;

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

/** One start.gg-shaped game of set `setId` — a parsed set id keeps its own set. */
function setGame(
  setId: string,
  game: number,
  time: number,
  win: boolean,
  opponent = 'rival',
): Match {
  return makeMatch({
    id: `${setId}-g${game}`,
    externalId: `sgg:${setId}:g${game}`,
    source: 'startgg',
    time,
    win,
    opponent,
  });
}

function renderPairing(matches: Match[], nowMs: number = NOW_MS) {
  return render(
    <MemoryRouter>
      <PairingOpponents matchupMatches={matches} nowMs={nowMs} />
    </MemoryRouter>,
  );
}

function rowOf(tag: string): HTMLElement {
  const tagEl = screen.getByText(tag);
  const row = tagEl.closest('[data-slot="pairing-opponent-row"]');
  expect(row, `a ledger row holds "${tag}"`).not.toBeNull();
  return row as HTMLElement;
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
});

describe('PairingOpponents — the rivalry ledger rows (plan 39.1-45, sketch 003 C; rivalry-ledger)', () => {
  it('titles the card "By opponent" and names the ledger scales in its meta line', () => {
    renderPairing([makeMatch({ opponent: 'rival' })]);
    expect(screen.getByText('By opponent')).toBeInTheDocument();
    expect(
      screen.getByText(
        'one tick per set · up = set won · most games first · chip = last 12 months vs all time',
      ),
    ).toBeInTheDocument();
  });

  it('every row is an li[data-slot=pairing-opponent-row] holding the drill overlay to /opponents/<tag>?fighter=&vs=', () => {
    renderPairing([
      makeMatch({ id: 'a', opponent: 'mkleo' }),
      makeMatch({ id: 'b', opponent: 'shuton' }),
    ]);
    for (const tag of ['mkleo', 'shuton']) {
      const row = rowOf(tag);
      expect(row.tagName.toLowerCase()).toBe('li');
      const link = within(row).getByRole('link');
      expect(link.getAttribute('href')).toBe(`/opponents/${tag}?fighter=1&vs=10`);
    }
  });

  it('a tag with URL-significant characters is encoded in the hub path (T-39.1-45-01)', () => {
    renderPairing([makeMatch({ opponent: 'a b/c?d' })]);
    const href = screen.getByRole('link').getAttribute('href') ?? '';
    expect(href).toMatch(/^\/opponents\/a%20b%2Fc%3Fd\?/);
  });

  it('prints the record with the sets record and no RecordBar', () => {
    // 2 sets: one won 2-0, one lost 0-1 -> games 2-1, sets 1-1.
    const matches = [
      setGame('s1', 1, NOW_MS - 40 * DAY_MS, true),
      setGame('s1', 2, NOW_MS - 40 * DAY_MS + 600_000, true),
      setGame('s2', 1, NOW_MS - 20 * DAY_MS, false),
    ];
    renderPairing(matches);
    const row = rowOf('rival');
    expect(row.textContent).toContain('2–1');
    expect(row.textContent).toContain('sets 1–1');
    // The shipped RecordBar drew a role=img win/loss bar inside the row.
    expect(row.querySelector('[data-slot="record-bar"]')).toBeNull();
  });

  it('carries the confidence glyph with its aria-label', () => {
    renderPairing(
      Array.from({ length: 4 }, (_, i) =>
        setGame(`s${i}`, 1, NOW_MS - (50 - i) * DAY_MS, i % 2 === 0),
      ),
    );
    const row = rowOf('rival');
    expect(within(row).getByRole('img', { name: 'low confidence, 4 games' })).toBeInTheDocument();
  });

  it('draws one set-strip tick per set, up = set won, with an aria-label counting sets won and lost', () => {
    const matches = [
      setGame('s1', 1, NOW_MS - 60 * DAY_MS, true),
      setGame('s1', 2, NOW_MS - 60 * DAY_MS + 600_000, true),
      setGame('s2', 1, NOW_MS - 40 * DAY_MS, false),
      setGame('s3', 1, NOW_MS - 20 * DAY_MS, true),
    ];
    renderPairing(matches);
    const row = rowOf('rival');
    const strip = within(row).getByRole('img', { name: '3 sets: 2 won, 1 lost' });
    expect(strip).toHaveAttribute('data-slot', 'set-strip');
    expect(strip.querySelectorAll('[data-slot="set-strip-tick-win"]')).toHaveLength(2);
    expect(strip.querySelectorAll('[data-slot="set-strip-tick-loss"]')).toHaveLength(1);
  });

  it('a single set reads with the singular aria', () => {
    renderPairing([setGame('s1', 1, NOW_MS - 20 * DAY_MS, true)]);
    expect(
      within(rowOf('rival')).getByRole('img', { name: '1 set: 1 won, 0 lost' }),
    ).toBeInTheDocument();
  });

  it('a manual play session is one tick (buildFormStripSetKeys)', () => {
    const matches = [
      makeMatch({ id: 'a', time: NOW_MS - 30 * DAY_MS, win: true }),
      makeMatch({ id: 'b', time: NOW_MS - 30 * DAY_MS + 3_600_000, win: true }),
      makeMatch({ id: 'c', time: NOW_MS - 30 * DAY_MS + 7_200_000, win: false }),
    ];
    renderPairing(matches);
    const strip = within(rowOf('rival')).getByRole('img', { name: /sets?:/ });
    expect(strip.querySelectorAll('[data-slot^="set-strip-tick"]')).toHaveLength(1);
  });

  it('with more than 30 sets draws the newest 30 and says so; totals still describe every set', () => {
    const matches = Array.from({ length: 35 }, (_, i) =>
      setGame(`s${i}`, 1, NOW_MS - (400 - i) * DAY_MS, i % 2 === 0),
    );
    renderPairing(matches);
    const row = rowOf('rival');
    expect(row.querySelectorAll('[data-slot^="set-strip-tick"]')).toHaveLength(30);
    expect(row.textContent).toContain('newest 30 of 35 sets');
    // 18 of 35 sets won.
    expect(row.textContent).toContain('sets 18–17');
  });

  it('prints the first → last month span', () => {
    const matches = [
      setGame('s1', 1, Date.UTC(2021, 3, 15, 12), true),
      setGame('s2', 1, Date.UTC(2026, 5, 15, 12), false),
    ];
    renderPairing(matches);
    expect(rowOf('rival').textContent).toContain('Apr 2021 → Jun 2026');
  });

  it('omits the chip when the opponent has no games in the last 12 months (PD-45-1)', () => {
    // time 1000 is 1970 — outside the window from NOW_MS.
    renderPairing([makeMatch({ opponent: 'rival' })]);
    expect(within(rowOf('rival')).queryByText(/no games/i)).not.toBeInTheDocument();
    expect(rowOf('rival').querySelector('[data-slot="delta-chip"]')).toBeNull();
  });

  it('WR-C01: a row with 2 games inside the window shows the no-direction count chip, never "Thin"', () => {
    // 4 games all-time, 2 of them in the last 12 months: locked (below the floor).
    renderPairing([
      setGame('old1', 1, NOW_MS - 900 * DAY_MS, true),
      setGame('old2', 1, NOW_MS - 800 * DAY_MS, false),
      setGame('new1', 1, NOW_MS - 30 * DAY_MS, true),
      setGame('new2', 1, NOW_MS - 10 * DAY_MS, false),
    ]);
    const row = rowOf('rival');
    const chip = row.querySelector('[data-slot="delta-chip"]')!;
    expect(chip).not.toBeNull();
    expect(chip).toHaveAttribute('data-recent-games', '2');
    expect(chip).toHaveAttribute('data-state', 'thin');
    expect(chip.textContent).toContain('n 2 · no direction');
    expect(screen.queryByText('Thin')).not.toBeInTheDocument();
  });

  it('the chip never names its own horizon — the card meta owns the window', () => {
    renderPairing([
      setGame('old1', 1, NOW_MS - 900 * DAY_MS, true),
      setGame('new1', 1, NOW_MS - 30 * DAY_MS, true),
      setGame('new2', 1, NOW_MS - 10 * DAY_MS, false),
    ]);
    const chip = rowOf('rival').querySelector('[data-slot="delta-chip"]')!;
    expect(chip.textContent).not.toMatch(/last 30/);
  });

  it("a row whose recent window is most of that opponent's games (8 of 8, collapsed) renders no chip", () => {
    renderPairing(
      Array.from({ length: 8 }, (_, i) =>
        setGame(`s${i}`, 1, NOW_MS - (30 - i) * DAY_MS, i % 2 === 0),
      ),
    );
    expect(rowOf('rival').querySelector('[data-slot="delta-chip"]')).toBeNull();
  });

  it('orders rows most games first, tag ascending on ties', () => {
    const matches = [
      ...Array.from({ length: 3 }, (_, i) => setGame(`b${i}`, 1, 1000 + i, true, 'beta')),
      ...Array.from({ length: 3 }, (_, i) => setGame(`a${i}`, 1, 2000 + i, true, 'alpha')),
      setGame('z', 1, 3000, true, 'zeta-most'),
      ...Array.from({ length: 5 }, (_, i) => setGame(`m${i}`, 1, 4000 + i, true, 'most')),
    ];
    renderPairing(matches);
    const tags = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector('[data-slot="pairing-opponent-tag"]')?.textContent);
    expect(tags).toEqual(['most', 'alpha', 'beta', 'zeta-most']);
  });

  it("the layout: the li is a row container; the body is the ledger grid (tag line, chip cell, sets line); the chevron is the li's last child", () => {
    renderPairing([setGame('s1', 1, NOW_MS - 20 * DAY_MS, true)]);
    const li = screen.getByRole('listitem');
    expect(li.className).toMatch(/@container\/pairing-opponent-row/);
    const body = li.querySelector('[data-slot="pairing-opponent-body"]') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.className).toMatch(/\bgrid\b/);
    // One column below the 420px row container, the chip under line 1 left-aligned.
    expect(body.className).toMatch(
      /@max-\[419px\]\/pairing-opponent-row:grid-cols-\[minmax\(0,1fr\)\]/,
    );
    const slots = Array.from(body.children).map((child) => child.getAttribute('data-slot'));
    expect(slots).toEqual([
      'pairing-opponent-who',
      'pairing-opponent-chip',
      'pairing-opponent-sets',
    ]);
    const who = body.children[0] as HTMLElement;
    expect(who.className).toMatch(/\bflex-wrap\b/);
    expect(who.querySelector('[data-slot="pairing-opponent-tag"]')).not.toBeNull();
    const chipCell = body.children[1] as HTMLElement;
    // An empty chip cell is hidden so it cannot hold a phantom grid column or row gap.
    expect(chipCell.className).toMatch(/\bempty:hidden\b/);
    expect(chipCell.className).toMatch(/@max-\[419px\]\/pairing-opponent-row:justify-self-start/);
    const sets = body.children[2] as HTMLElement;
    expect(sets.className).toMatch(/col-span-full/);
    expect(sets.querySelector('[data-slot="set-strip"]')).not.toBeNull();
    // The chevron (a lucide ChevronRight <svg>, aria-hidden) is the li's last element child.
    expect(li.lastElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(li.lastElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

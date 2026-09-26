import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fighter, Match } from '@smash-tracker/shared';
import { ROSTER_MAIN_MIN_GAMES, ROSTER_SECONDARY_MIN_GAMES } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { RosterUsage } from './RosterUsage';

const roster = SpriteList;

let matchIdCounter = 0;

function makeMatch(fighterId: number, win: boolean): Match {
  matchIdCounter += 1;
  return {
    id: `m-${matchIdCounter}`,
    fighter_id: fighterId,
    opponent_id: roster[0]!.id,
    time: 1_700_000_000_000 + matchIdCounter,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win,
  };
}

function matchesFor(fighter: Fighter, wins: number, losses: number): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < wins; i++) matches.push(makeMatch(fighter.id, true));
  for (let i = 0; i < losses; i++) matches.push(makeMatch(fighter.id, false));
  return matches;
}

function renderRoster(matches: Match[]) {
  return render(
    <MemoryRouter>
      <RosterUsage matches={matches} />
    </MemoryRouter>,
  );
}

/** Below `ROSTER_SECONDARY_MIN_GAMES`/`ROSTER_SECONDARY_MIN_SHARE` — pools into pockets. */
const SMALL_GAMES = 3;

describe('RosterUsage', () => {
  it('shows an empty state when there is no match data', () => {
    renderRoster([]);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('reads the roster model from the shared engine — no share-threshold literal in the component', () => {
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'RosterUsage.tsx'),
      'utf8',
    );
    expect(source).toMatch(/buildRosterModel/);
    // ROSTER_SECONDARY_MIN_SHARE's own value (0.08) — a re-derived threshold
    // would need this literal; the component only ever reads the engine's
    // exported constant/model, never restates the number itself.
    expect(source).not.toMatch(/0\.08/);
  });

  it('renders exactly one main row, two secondary rows and one pooled pocket row', () => {
    const [main, secA, secB, ...small] = roster;
    const matches = [
      ...matchesFor(main!, 60, 0),
      ...matchesFor(secA!, 25, 0),
      ...matchesFor(secB!, 25, 0),
      ...small.slice(0, 5).flatMap((fighter) => matchesFor(fighter, SMALL_GAMES, 0)),
    ];
    // Sanity: secondaries clear both floors, small fighters clear neither.
    expect(25).toBeGreaterThanOrEqual(ROSTER_SECONDARY_MIN_GAMES);
    expect(SMALL_GAMES).toBeLessThan(ROSTER_SECONDARY_MIN_GAMES);

    renderRoster(matches);

    const groups = document.querySelectorAll('[data-slot="roster-group-header"]');
    expect([...groups].map((g) => g.textContent)).toEqual(['Main', 'Secondaries', 'Pockets']);

    const rows = document.querySelectorAll('[data-slot="roster-row"]');
    expect(rows).toHaveLength(3); // main + 2 secondaries (pockets is a summary, not individual rows)
    expect(document.querySelectorAll('[data-slot="roster-pocket-summary"]')).toHaveLength(1);
  });

  it('renders the main group and zero other group headers when only a main exists', () => {
    const [main] = roster;
    const matches = matchesFor(main!, 60, 0);

    renderRoster(matches);

    const groups = document.querySelectorAll('[data-slot="roster-group-header"]');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.textContent).toBe('Main');
    expect(document.querySelectorAll('[data-slot="roster-row"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-slot="roster-pocket-summary"]')).toHaveLength(0);
  });

  it('renders the main-not-established line and a plain share list, zero group headers, under the model minimum', () => {
    const [a, b] = roster;
    const matches = [...matchesFor(a!, 5, 0), ...matchesFor(b!, 3, 0)];
    expect(5).toBeLessThan(ROSTER_MAIN_MIN_GAMES);

    renderRoster(matches);

    expect(screen.getByText('Main not established yet')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="roster-group-header"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-slot="roster-row"]')).toHaveLength(2);
  });

  it('every usage bar carries the same identity colour class regardless of row position', () => {
    const [main, secA, secB] = roster;
    const matches = [
      ...matchesFor(main!, 60, 0),
      ...matchesFor(secA!, 25, 0),
      ...matchesFor(secB!, 25, 0),
    ];

    renderRoster(matches);

    const fills = document.querySelectorAll('[data-slot="roster-usage-bar-fill"]');
    expect(fills.length).toBeGreaterThanOrEqual(3);
    const colors = [...fills].map((el) => (el as HTMLElement).style.backgroundColor);
    expect(new Set(colors).size).toBe(1);
    expect(colors[0]).toBe('var(--viz-series-1)');
  });

  it('states the games count exactly once per row', () => {
    const [main] = roster;
    const matches = matchesFor(main!, 20, 5);

    renderRoster(matches);

    const row = document.querySelector('[data-slot="roster-row"]')!;
    const occurrences = row.textContent!.match(/\b25\b/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('every row is a link with a non-empty accessible name and a destination carrying the fighter axis', () => {
    const [main, secA] = roster;
    const matches = [...matchesFor(main!, 60, 0), ...matchesFor(secA!, 25, 0)];

    renderRoster(matches);

    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link).toHaveAccessibleName();
      expect(link.getAttribute('href')).toMatch(/fighter-analysis\?fighter=\d+/);
    }
  });

  it("the pocket row's show-all control expands inline to at most the inline cap", async () => {
    const user = userEvent.setup();
    const [main, ...pocketFighters] = roster;
    const matches = [
      ...matchesFor(main!, 60, 0),
      ...pocketFighters.slice(0, 30).flatMap((fighter) => matchesFor(fighter, 1, 0)),
    ];

    renderRoster(matches);

    const groups = document.querySelectorAll('[data-slot="roster-group"]');
    const pocketGroup = groups[groups.length - 1] as HTMLElement;
    const showAllButton = within(pocketGroup).getByRole('button', { name: /show all/i });
    await user.click(showAllButton);

    const expandedRows = within(pocketGroup).getAllByRole('listitem');
    // The pooled summary `<li>` stays; the inline-expanded rows are capped.
    expect(expandedRows.length - 1).toBeLessThanOrEqual(25);
    expect(expandedRows.length - 1).toBe(25);
  });
});

/**
 * Plan 39.1-49 (OOS-3's same-class find: the Roster name starved to 0px at
 * 390; UI-SPEC §8.4): each roster row keeps its `@container/roster-row`; the
 * name, share and chevron sit in a line-1 wrapper and the usage bar and
 * Record in a line-2 wrapper that drops under the name below a 480px row
 * width; at or above 480px both wrappers are `display: contents`.
 */
describe('RosterUsage — two-line rows below a 480px row width (plan 39.1-49)', () => {
  it('roster row two-line: line-1 name + share + chevron, line-2 bar + record, contents at 480px and wider', () => {
    const [a, b] = [roster[1]!, roster[2]!];
    renderRoster([...matchesFor(a, 30, 10), ...matchesFor(b, 12, 8)]);
    const rows = Array.from(document.querySelectorAll('li[data-slot="roster-row"]'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.className.split(/\s+/)).toContain('@container/roster-row');
      const line1 = row.querySelector('[data-slot="roster-row-line1"]');
      const line2 = row.querySelector('[data-slot="roster-row-line2"]');
      expect(line1).not.toBeNull();
      expect(line2).not.toBeNull();
      const name = line1!.querySelector('span[title]');
      expect(name!.className).toMatch(/\bmin-w-0\b/);
      expect(name!.className).toMatch(/\btruncate\b/);
      expect(line1!.textContent).toMatch(/\d+%/);
      expect(line1!.querySelector('svg.lucide-chevron-right')).not.toBeNull();
      expect(line2!.querySelector('[data-slot="roster-usage-bar-track"]')).not.toBeNull();
      expect(line2!.querySelector('[data-slot="record"]')).not.toBeNull();
      expect(line1!.className.split(/\s+/)).toContain('@min-[480px]/roster-row:contents');
      expect(line2!.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['basis-full', '@min-[480px]/roster-row:contents']),
      );
      expect(row.querySelectorAll('a')).toHaveLength(1);
    }
  });
});

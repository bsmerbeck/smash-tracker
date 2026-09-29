import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { StageBreakdown } from './StageBreakdown';

let matchIdCounter = 0;

function makeMatch(stageId: number, fighterId = 1): Match {
  matchIdCounter += 1;
  return {
    id: `m-${matchIdCounter}`,
    fighter_id: fighterId,
    opponent_id: 10,
    time: 1_700_000_000_000 + matchIdCounter,
    map: { id: stageId, name: `Stage ${stageId}` },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
  };
}

function renderCard(matches: Match[]) {
  return render(
    <MemoryRouter>
      <StageBreakdown matches={matches} />
    </MemoryRouter>,
  );
}

/** Real stage ids 1..count (StageList has 123 entries) so getStageById resolves names/art. */
function stagesFixture(count: number): Match[] {
  const matches: Match[] = [];
  for (let stageId = 1; stageId <= count; stageId++) {
    matches.push(makeMatch(stageId));
  }
  return matches;
}

describe('StageBreakdown', () => {
  it('shows an empty state when there is no match data', () => {
    renderCard([]);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('caps the list at 8 with a show-all control, and fully expands within the inline cap', async () => {
    const user = userEvent.setup();
    renderCard(stagesFixture(20));

    expect(document.querySelectorAll('[data-slot="stage-row"]')).toHaveLength(8);
    const showAll = screen.getByRole('button', { name: /show all/i });
    await user.click(showAll);
    expect(document.querySelectorAll('[data-slot="stage-row"]')).toHaveLength(20);
    expect(screen.getByRole('button', { name: /show fewer/i })).toBeInTheDocument();
  });

  it('expands to the inline cap and then shows a terminus anchor beyond 25 stages', async () => {
    const user = userEvent.setup();
    renderCard(stagesFixture(30));

    const showAll = screen.getByRole('button', { name: /show all/i });
    await user.click(showAll);
    expect(document.querySelectorAll('[data-slot="stage-row"]')).toHaveLength(25);
    expect(screen.getByRole('button', { name: /all 30 stages/i })).toBeInTheDocument();
  });

  it('every stage row is a link with a non-empty accessible name and a destination carrying the stage identifier', () => {
    renderCard(stagesFixture(3));

    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      expect(link).toHaveAccessibleName();
      expect(link.getAttribute('href')).toMatch(/\/stages\/\d+/);
    }
  });

  it('the stage name element carries the truncation-guard attribute and a title with the full string', () => {
    renderCard(stagesFixture(1));

    const name = document.querySelector('[data-truncate-guard]')!;
    expect(name).toHaveAttribute('title');
    expect(name.getAttribute('title')).toBe(name.textContent);
  });

  it('renders no per-fighter split, even for a fixture whose stage has multiple fighters', () => {
    const matches = [makeMatch(1, 1), makeMatch(1, 2), makeMatch(1, 3)];
    renderCard(matches);

    expect(document.querySelectorAll('table')).toHaveLength(0);
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it("the card's meta line states the sort order", () => {
    renderCard(stagesFixture(3));

    expect(screen.getByText('Most games')).toBeInTheDocument();
  });
});

/**
 * Plan 39.1-49 (OOS-3; UI-SPEC §8.4 "the usage bar drops below the name
 * line", §6.5 rules 1-2): each stage row is a named row container whose name
 * and chevron sit in a line-1 wrapper and whose RecordBar and Record sit in a
 * line-2 wrapper — below a 480px row width line 2 moves under line 1 at the
 * name's left edge; at or above 480px both wrappers are `display: contents`,
 * so the one-line desktop row is unchanged.
 */
describe('StageBreakdown — two-line rows below a 480px row width (plan 39.1-49, OOS-3)', () => {
  it('stage row two-line: a named row container, line-1 name + chevron, line-2 bar + record, contents at 480px and wider', () => {
    renderCard(stagesFixture(3));
    const rows = Array.from(document.querySelectorAll('li[data-slot="stage-row"]'));
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.className.split(/\s+/)).toContain('@container/stage-row');
      const line1 = row.querySelector('[data-slot="stage-row-line1"]');
      const line2 = row.querySelector('[data-slot="stage-row-line2"]');
      expect(line1).not.toBeNull();
      expect(line2).not.toBeNull();
      const name = line1!.querySelector('span[title]');
      expect(name).not.toBeNull();
      expect(name!.className).toMatch(/\bmin-w-0\b/);
      expect(name!.className).toMatch(/\btruncate\b/);
      expect(line1!.querySelector('svg.lucide-chevron-right')).not.toBeNull();
      expect(line2!.querySelector('[data-slot="record-bar"]')).not.toBeNull();
      expect(line2!.querySelector('[data-slot="record"]')).not.toBeNull();
      expect(line1!.className.split(/\s+/)).toContain('@min-[480px]/stage-row:contents');
      expect(line2!.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['basis-full', '@min-[480px]/stage-row:contents']),
      );
    }
  });

  it('stage row two-line: each row keeps exactly its one overlay link, destination and accessible name', () => {
    renderCard(stagesFixture(3));
    const rows = Array.from(document.querySelectorAll('li[data-slot="stage-row"]'));
    rows.forEach((row, index) => {
      const links = row.querySelectorAll('a');
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute('href', `/stages/${index + 1}`);
      expect(links[0]!.getAttribute('aria-label')).toMatch(/1–0/);
    });
  });
});

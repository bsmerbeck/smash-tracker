import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { MatchupStageGuide } from './MatchupStageGuide';
import { SpriteList } from '@/data/sprites';

/**
 * Plan 38-06 Task 2 (ADV-03/H-05): `MatchupStageGuide.tsx` already reads
 * gated engine output for its best/worst stage cells — this file's own job
 * is asserting the NEW behaviour this plan adds, that a best/worst stage
 * cell is a real link carrying the opposing-character axis, and that a
 * cell with no qualifying record stays plain text. This component's only
 * host (`FighterAnalysisPage.tsx`) wraps in a Router, so this harness does
 * too (H-01's third-party-host constraint applies to `StageMastery`, not
 * this component — see `MatchupStageGuide.tsx`'s own doc comment).
 */

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const fox = SpriteList.find((s) => s.id === 15)!; // Fox

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: fox.id,
    opponent: '',
    notes: '',
    matchType: 'none',
    map: { id: 1, name: 'Battlefield' },
    ...overrides,
  };
}

function renderGuide(matches: Match[]) {
  return render(
    <MemoryRouter>
      <MatchupStageGuide fighterMatches={matches} />
    </MemoryRouter>,
  );
}

describe('MatchupStageGuide', () => {
  it('renders a best-stage cell as an anchor carrying the opposing-character (vs) axis, and a cell with no qualifying record as plain text with no anchor', () => {
    const matches: Match[] = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
      makeMatch({ id: 'm3', time: 3, win: true }),
    ];
    renderGuide(matches);

    // Only one stage (Battlefield, id 1) has enough games to qualify — it is
    // reported as the best-stage cell only, matching `getBestWorstStages`'s
    // "can't be both the recommendation and the warning" rule; the
    // worst-stage cell has no record.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', `/stages/1?vs=${fox.id}`);

    // The worst-stage cell (no qualifying record) is the em-dash placeholder
    // — plain text, no anchor.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('caps rows at 8 with a show-all control, no nested scroller, when more than 8 opponents are faced (T-39.1-14, UI-SPEC §6.4)', () => {
    const matches: Match[] = [];
    for (let opponentId = 20; opponentId < 32; opponentId++) {
      for (let g = 0; g < 3; g++) {
        matches.push(
          makeMatch({
            id: `m${opponentId}-${g}`,
            time: opponentId * 10 + g,
            win: true,
            opponent_id: opponentId,
          }),
        );
      }
    }
    renderGuide(matches);
    const rows = screen.getAllByRole('row');
    // Header + at most 8 capped body rows.
    expect(rows.length).toBeLessThanOrEqual(9);
    expect(screen.getByRole('button', { name: /show all/i })).toBeInTheDocument();
  });

  it('WR-C06 (39.1-REVIEW.md): the show-all/show-fewer toggle carries aria-expanded and aria-controls pointing at the table', () => {
    const matches: Match[] = [];
    for (let opponentId = 20; opponentId < 32; opponentId++) {
      for (let g = 0; g < 3; g++) {
        matches.push(
          makeMatch({
            id: `m${opponentId}-${g}`,
            time: opponentId * 10 + g,
            win: true,
            opponent_id: opponentId,
          }),
        );
      }
    }
    renderGuide(matches);
    const toggle = screen.getByRole('button', { name: /show all/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const controlsId = toggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    const table = document.getElementById(controlsId!);
    expect(table).not.toBeNull();
    expect(table?.tagName.toLowerCase()).toBe('table');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /show fewer/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('IN-06 (review iteration 2): the min-matches select is named by its visible label (label-in-name), with no aria-label override', () => {
    renderGuide([makeMatch({ id: 'm1', time: 1, win: true })]);
    const select = screen.getByRole('combobox', { name: 'Min matches per stage' });
    expect(select).not.toHaveAttribute('aria-label');
    const label = screen.getByText('Min matches per stage');
    expect(label.tagName.toLowerCase()).toBe('label');
    expect(label).toHaveAttribute('for', select.id);
  });
});

/**
 * Plan 39.1-49 (UI-SPEC §6.6, §6.5 rules 1-2): below 640px the guide renders
 * stacked two-line rows — the same rows, the same best and worst stage links,
 * every value — and its header stacks the min-matches control under the title.
 */
const normText = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

function guideFixture(): Match[] {
  const matches: Match[] = [];
  const add = (
    opponentId: number,
    stage: { id: number; name: string },
    win: boolean,
    n: number,
  ) => {
    for (let g = 0; g < n; g++) {
      matches.push(
        makeMatch({
          id: `m-${opponentId}-${stage.id}-${win}-${g}`,
          time: matches.length + 1,
          win,
          opponent_id: opponentId,
          map: stage,
        }),
      );
    }
  };
  const battlefield = { id: 1, name: 'Battlefield' };
  const other = { id: 3, name: 'Final Destination' };
  // Fox: wins on Battlefield, losses on the other stage (best + worst links).
  add(fox.id, battlefield, true, 3);
  add(fox.id, other, false, 3);
  // Opponent 20: only Battlefield qualifies (best link, worst em-dash).
  add(20, battlefield, true, 3);
  return matches;
}

function renderGuideLayout(matches: Match[], layout: 'table' | 'stack') {
  return render(
    <MemoryRouter>
      <MatchupStageGuide fighterMatches={matches} layout={layout} />
    </MemoryRouter>,
  );
}

describe('MatchupStageGuide — stacked rows below 640px (plan 39.1-49)', () => {
  it('stack versus table parity: same rows, the same best and worst stage links per row, every table value in its stacked row', () => {
    const matches = guideFixture();
    const table = renderGuideLayout(matches, 'table');
    const tableEl = table.container.querySelector('table[data-slot="matchup-stage-guide"]');
    expect(tableEl).not.toBeNull();
    const tableRows = Array.from(tableEl!.querySelectorAll('tbody tr'))
      .filter((tr) => tr.querySelectorAll('td').length > 1)
      .map((tr) => ({
        hrefs: Array.from(tr.querySelectorAll('a')).map((a) => a.getAttribute('href')),
        cells: Array.from(tr.querySelectorAll('td'))
          .map((td) => normText(td.textContent))
          .filter(Boolean),
      }));
    expect(tableRows.length).toBeGreaterThanOrEqual(2);
    table.unmount();

    const stack = renderGuideLayout(matches, 'stack');
    expect(stack.container.querySelector('table')).toBeNull();
    const list = stack.container.querySelector('ul[data-slot="matchup-stage-guide"]');
    expect(list).not.toBeNull();
    const stackRows = Array.from(
      list!.querySelectorAll(':scope > li[data-slot="stage-guide-row"]'),
    );
    expect(stackRows).toHaveLength(tableRows.length);
    stackRows.forEach((li, index) => {
      expect(Array.from(li.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(
        tableRows[index]!.hrefs,
      );
      const text = normText(li.textContent);
      for (const cell of tableRows[index]!.cells) {
        expect(text).toContain(cell);
      }
    });
    // Two same-typed values are told apart by visible labels.
    expect(stack.getAllByText('Best Stage').length).toBeGreaterThan(0);
    expect(stack.getAllByText('Worst Stage').length).toBeGreaterThan(0);
  });

  it('the stacked opponent slot truncates in one flexible slot with the full name as its title', () => {
    const { container } = renderGuideLayout(guideFixture(), 'stack');
    const slot = container.querySelector(`[title="${fox.name}"]`);
    expect(slot).not.toBeNull();
    expect(slot!.className).toMatch(/\btruncate\b/);
    expect(slot!.className).toMatch(/\bmin-w-0\b/);
  });

  it('the cap and Show all / Show fewer behave the same in both layouts, and the toggle controls the root', () => {
    const matches: Match[] = [];
    for (let opponentId = 20; opponentId < 32; opponentId++) {
      for (let g = 0; g < 3; g++) {
        matches.push(
          makeMatch({
            id: `m${opponentId}-${g}`,
            time: opponentId * 10 + g,
            win: true,
            opponent_id: opponentId,
          }),
        );
      }
    }
    for (const layout of ['table', 'stack'] as const) {
      const view = renderGuideLayout(matches, layout);
      const count = () =>
        layout === 'table'
          ? view.container.querySelectorAll('tbody tr').length
          : view.container.querySelectorAll(
              'ul[data-slot="matchup-stage-guide"] > li[data-slot="stage-guide-row"]',
            ).length;
      expect(count()).toBe(8);
      const toggle = screen.getByRole('button', { name: /show all/i });
      expect(
        document.getElementById(toggle.getAttribute('aria-controls')!)?.getAttribute('data-slot'),
      ).toBe('matchup-stage-guide');
      fireEvent.click(toggle);
      expect(count()).toBe(12);
      fireEvent.click(screen.getByRole('button', { name: /show fewer/i }));
      expect(count()).toBe(8);
      view.unmount();
    }
  });

  it('header: below 640px the min-matches control stacks under the title; sm: classes restore the row', () => {
    const { container } = renderGuide(guideFixture());
    const header = container.querySelector('[data-slot="card-header"]');
    expect(header).not.toBeNull();
    const classes = header!.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        'flex',
        'flex-col',
        'sm:flex-row',
        'sm:items-center',
        'sm:justify-between',
      ]),
    );
    expect(classes).not.toContain('flex-row');
    expect(classes).not.toContain('items-center');
    expect(classes).not.toContain('justify-between');
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { MatchupStats, RankedMatchup } from '@/lib/stats';
import { WhatTheyPlayTable } from './WhatTheyPlayTable';

function makeRow(overrides: Partial<RankedMatchup> = {}): RankedMatchup {
  return {
    opponentFighterId: 41, // Sonic
    wins: 3,
    losses: 1,
    ratio: 75,
    totalMatches: 4,
    ...overrides,
  } as RankedMatchup;
}

describe('WhatTheyPlayTable', () => {
  it('with a rowHref supplied, a row is a real anchor carrying the opposing-character axis', () => {
    const rows = [makeRow()];
    render(
      <MemoryRouter>
        <WhatTheyPlayTable
          byTheirFighter={rows}
          rowHref={(row) => `/matchups?vs=${row.opponentFighterId}`}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/matchups?vs=41');
  });

  it('an unknown-fighter row renders plain text — no chevron, no link', () => {
    const rows = [makeRow({ opponentFighterId: 999_999 })];
    render(
      <MemoryRouter>
        <WhatTheyPlayTable
          byTheirFighter={rows}
          rowHref={(row) => `/matchups?vs=${row.opponentFighterId}`}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('with no rowHref supplied, renders no anchor at all — the third-party-host configuration, WITHOUT a MemoryRouter or QueryClientProvider', () => {
    const rows = [makeRow()];
    render(<WhatTheyPlayTable byTheirFighter={rows} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('preserves the evidence-ranked row order', () => {
    const rows = [
      makeRow({ opponentFighterId: 1, totalMatches: 2 }),
      makeRow({ opponentFighterId: 41, totalMatches: 9 }),
    ];
    render(<WhatTheyPlayTable byTheirFighter={rows} />);
    const cells = screen.getAllByRole('cell');
    // 4 cells per row; first cell of each row is the character column.
    expect(cells[0]!.textContent).toContain('Mario');
    expect(cells[4]!.textContent).toContain('Sonic');
  });
});

/**
 * Plan 39.1-49 (UI-SPEC §6.6): below 640px the same rows render as stacked
 * two-line rows — one overlay link per row when rowHref resolves, none
 * without it — and the stack root keeps `data-slot="what-they-play"` so the
 * hub's clip target still resolves.
 */
const wtpText = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('WhatTheyPlayTable — stacked rows below 640px (plan 39.1-49)', () => {
  const rows = [
    makeRow(),
    makeRow({ opponentFighterId: 1, wins: 1, losses: 4, ratio: 20, totalMatches: 5 }),
    makeRow({ opponentFighterId: 999_999, wins: 2, losses: 2, ratio: 50, totalMatches: 4 }),
  ];
  const rowHref = (row: MatchupStats) => `/matchups?vs=${row.opponentFighterId}`;

  it('stack versus table parity: same rows, same links per row, every table value in its stacked row', () => {
    const table = render(
      <MemoryRouter>
        <WhatTheyPlayTable byTheirFighter={rows} rowHref={rowHref} layout="table" />
      </MemoryRouter>,
    );
    const tableRows = Array.from(
      table.container.querySelectorAll('table[data-slot="what-they-play"] tbody tr'),
    ).map((tr) => ({
      hrefs: Array.from(tr.querySelectorAll('a')).map((a) => a.getAttribute('href')),
      cells: Array.from(tr.querySelectorAll('td'))
        .map((td) => wtpText(td))
        .filter(Boolean),
    }));
    expect(tableRows).toHaveLength(3);
    table.unmount();

    const stack = render(
      <MemoryRouter>
        <WhatTheyPlayTable byTheirFighter={rows} rowHref={rowHref} layout="stack" />
      </MemoryRouter>,
    );
    expect(stack.container.querySelector('table')).toBeNull();
    const items = Array.from(
      stack.container.querySelectorAll('ul[data-slot="what-they-play"] > li'),
    );
    expect(items).toHaveLength(3);
    items.forEach((li, index) => {
      expect(Array.from(li.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(
        tableRows[index]!.hrefs,
      );
      for (const cell of tableRows[index]!.cells) {
        expect(wtpText(li)).toContain(cell);
      }
    });
    expect(items.map((li) => li.querySelectorAll('a').length)).toEqual([1, 1, 0]);
  });

  it('the Scout host (no rowHref) renders zero anchors in the stack layout, and the character slot truncates with a title', () => {
    const { container } = render(<WhatTheyPlayTable byTheirFighter={rows} layout="stack" />);
    expect(container.querySelector('ul[data-slot="what-they-play"]')).not.toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
    const slot = container.querySelector('[title="Sonic"]');
    expect(slot).not.toBeNull();
    expect(slot!.className).toMatch(/\btruncate\b/);
  });
});

/**
 * 38-10 (38-UAT 13/22, F18): a thin-data opponent — every character below
 * the evidence floor — must still list the characters it was recorded on,
 * as muted "Not enough data yet (n games)" rows with no record, rate or
 * verdict, still drilling through the host's rowHref.
 */
describe('WhatTheyPlayTable — sub-floor rows (38-10)', () => {
  const belowFloor: MatchupStats[] = [
    { opponentFighterId: 41, wins: 1, losses: 0, totalMatches: 1, ratio: 100 }, // Sonic
    { opponentFighterId: 57, wins: 0, losses: 1, totalMatches: 1, ratio: 0 }, // Palutena
  ];
  const rowHref = (row: MatchupStats) => `/matchups?vs=${row.opponentFighterId}`;

  it.each(['table', 'stack'] as const)(
    '%s layout: lists both characters as Not enough data rows, drilling, with no record or rate — never the empty copy',
    (layout) => {
      const { container } = render(
        <MemoryRouter>
          <WhatTheyPlayTable
            byTheirFighter={[]}
            belowFloor={belowFloor}
            rowHref={rowHref}
            layout={layout}
          />
        </MemoryRouter>,
      );
      expect(screen.queryByText('No characters recorded yet.')).not.toBeInTheDocument();
      const root = container.querySelector('[data-slot="what-they-play"]');
      expect(root).not.toBeNull();
      const rowEls = Array.from(
        root!.querySelectorAll(layout === 'table' ? 'tbody tr' : ':scope > li'),
      );
      expect(rowEls).toHaveLength(2);
      expect(wtpText(rowEls[0])).toContain('Sonic');
      expect(wtpText(rowEls[1])).toContain('Palutena');
      for (const el of rowEls) {
        expect(wtpText(el)).toContain('Not enough data yet (1 game)');
        expect(wtpText(el)).not.toContain('%');
        expect(wtpText(el)).not.toMatch(/\d+-\d+/);
      }
      expect(rowEls.map((el) => el.querySelector('a')?.getAttribute('href'))).toEqual([
        '/matchups?vs=41',
        '/matchups?vs=57',
      ]);
    },
  );

  it('evidenced rows lead, sub-floor rows follow', () => {
    const { container } = render(
      <WhatTheyPlayTable
        byTheirFighter={[makeRow({ opponentFighterId: 1, totalMatches: 5 })]}
        belowFloor={[belowFloor[1]!]}
        layout="table"
      />,
    );
    const rowEls = Array.from(container.querySelectorAll('tbody tr'));
    expect(rowEls.map((el) => wtpText(el))).toEqual([
      expect.stringContaining('Mario'),
      expect.stringContaining('Palutena'),
    ]);
  });

  it('with both lists empty the empty copy renders', () => {
    render(<WhatTheyPlayTable byTheirFighter={[]} belowFloor={[]} />);
    expect(screen.getByText('No characters recorded yet.')).toBeInTheDocument();
  });
});

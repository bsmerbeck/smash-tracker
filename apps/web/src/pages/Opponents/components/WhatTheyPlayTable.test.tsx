import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { RankedMatchup } from '@/lib/stats';
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
  const rowHref = (row: RankedMatchup) => `/matchups?vs=${row.opponentFighterId}`;

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

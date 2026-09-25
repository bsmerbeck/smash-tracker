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

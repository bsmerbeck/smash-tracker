import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { OpponentTable, type OpponentTableRow } from './OpponentTable';

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeRow(overrides: Partial<OpponentTableRow> = {}): OpponentTableRow {
  return {
    key: 'mkleo',
    displayLabel: 'mkleo',
    wins: 3,
    losses: 1,
    total: 4,
    winRate: 75,
    ...overrides,
  };
}

/**
 * Phase 38-07 Task 1 (H-02/Q11.4): `OpponentTable` is now presentational —
 * it has no test file today, so the identity-migration + two-host-shape
 * assertions live here.
 */
describe('OpponentTable', () => {
  it('renders no opponent-table row when the fixture is empty', () => {
    render(<OpponentTable rows={[]} />);
    expect(screen.getByText('No named opponents recorded yet.')).toBeInTheDocument();
  });

  it('renders a hub link per row when hubHref is supplied', () => {
    const rows = [makeRow()];
    renderWithRouter(<OpponentTable rows={rows} hubHref={(row) => `/opponents/${row.key}`} />);
    const link = screen.getByRole('link', { name: /mkleo — Opponents, opens details/ });
    expect(link).toHaveAttribute('href', '/opponents/mkleo');
    expect(screen.getByText('mkleo')).toBeInTheDocument();
  });

  it('carries the active character axis and coach prefix through the destination builder', () => {
    const rows = [makeRow()];
    renderWithRouter(
      <OpponentTable
        rows={rows}
        hubHref={(row) => `/coach/client-a/opponents/${row.key}?fighter=1`}
      />,
    );
    const link = screen.getByRole('link', { name: /mkleo/ });
    expect(link).toHaveAttribute('href', '/coach/client-a/opponents/mkleo?fighter=1');
  });

  it('a two-raw-tag-resolving-to-one-identity fixture renders ONE row whose total is the combined count', () => {
    // The identity resolution itself happens at the HOST (buildOpponentEvidence)
    // — this asserts the component renders exactly what it's handed: one row
    // for one identity, total already merged by the caller.
    const rows: OpponentTableRow[] = [makeRow({ key: 'mkleo', total: 7, wins: 5, losses: 2 })];
    renderWithRouter(<OpponentTable rows={rows} hubHref={() => '/opponents/mkleo'} />);
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + 1 data row
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('renders an unaddressable row as plain text with no chevron and no link', () => {
    const rows = [makeRow({ key: 'unknown', displayLabel: 'unknown' })];
    render(<OpponentTable rows={rows} hubHref={() => undefined} />);
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders no anchor at all when no hubHref is supplied — the third-party-host configuration, WITHOUT a MemoryRouter or QueryClientProvider', () => {
    const rows = [makeRow({ key: 'PowPow', displayLabel: 'PowPow' })];
    render(<OpponentTable rows={rows} />);
    expect(screen.getByText('PowPow')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('caps rows at 8 with a show-all control, no nested scroller, when more than 8 opponents exist (T-39.1-14, UI-SPEC §6.4)', () => {
    const rows: OpponentTableRow[] = Array.from({ length: 12 }, (_, i) =>
      makeRow({ key: `opp${i}`, displayLabel: `opp${i}`, total: 12 - i }),
    );
    render(<OpponentTable rows={rows} />);
    const dataRows = screen.getAllByRole('row').length - 1; // minus header
    expect(dataRows).toBeLessThanOrEqual(8);
    expect(screen.getByRole('button', { name: /show all/i })).toBeInTheDocument();
  });

  it('preserves the row order given by the caller (no internal re-sort)', () => {
    const rows = [
      makeRow({ key: 'a', displayLabel: 'alice', total: 2 }),
      makeRow({ key: 'b', displayLabel: 'bob', total: 9 }),
      makeRow({ key: 'c', displayLabel: 'cara', total: 5 }),
    ];
    render(<OpponentTable rows={rows} />);
    const cells = screen.getAllByRole('cell');
    // First cell of each row (opponent column) — 5 columns per row.
    const opponentLabels = [cells[0], cells[5], cells[10]].map((c) => c!.textContent);
    expect(opponentLabels).toEqual(['alice', 'bob', 'cara']);
  });
});

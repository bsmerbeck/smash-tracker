import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConfidenceTier, SampleMeta } from '@smash-tracker/shared';
import { MatrixHeat, type MatrixHeatAxis, type MatrixHeatCell } from './MatrixHeat';

function makeSample(overrides: Partial<SampleMeta> = {}): SampleMeta {
  return {
    rawSampleSize: 5,
    eligibleDenominator: 5,
    knownFieldCoverage: 1,
    dateRange: { firstMs: 1000, lastMs: 2000 },
    refreshedAt: 3000,
    evidencePolicyVersion: 1,
    recencyTreatment: 'unweighted',
    confidenceTier: 'low',
    ...overrides,
  };
}

function makeCell(overrides: Partial<MatrixHeatCell> = {}): MatrixHeatCell {
  return {
    rowKey: 'r1',
    colKey: 'c1',
    wins: 4,
    losses: 1,
    total: 5,
    confidenceTier: 'low',
    sample: makeSample(),
    ...overrides,
  };
}

const rows: MatrixHeatAxis[] = [
  { key: 'r1', label: 'Fox vs Falco' },
  { key: 'r2', label: 'Fox vs Marth' },
];

const cols: MatrixHeatAxis[] = [
  { key: 'c1', label: 'Battlefield' },
  { key: 'c2', label: 'Final Destination' },
  { key: 'c3', label: 'Unknown stage', isUnknown: true },
];

function tieredCell(
  rowKey: string,
  colKey: string,
  wins: number,
  losses: number,
  tier: ConfidenceTier,
): MatrixHeatCell {
  const total = wins + losses;
  return makeCell({
    rowKey,
    colKey,
    wins,
    losses,
    total,
    confidenceTier: tier,
    sample: makeSample({ eligibleDenominator: total, confidenceTier: tier }),
  });
}

function subFloorCell(rowKey: string, colKey: string, total: number): MatrixHeatCell {
  return makeCell({
    rowKey,
    colKey,
    wins: Math.ceil(total / 2),
    losses: Math.floor(total / 2),
    total,
    confidenceTier: null,
    sample: makeSample({ eligibleDenominator: total, confidenceTier: null }),
  });
}

// Sparse: 2 rows x 3 cols = 6 possible combinations, only 4 supplied.
const sparseCells: MatrixHeatCell[] = [
  tieredCell('r1', 'c1', 4, 1, 'low'), // above floor, win-leaning
  subFloorCell('r1', 'c2', 2), // below floor
  tieredCell('r2', 'c1', 2, 2, 'low'), // above floor, exactly even
  tieredCell('r1', 'c3', 25, 0, 'high'), // unknown column, high count
];

describe('MatrixHeat', () => {
  it('renders the GRID form under jsdom (no matchMedia) with one button per supplied cell, not rows times cols', () => {
    const { container } = render(
      <MatrixHeat rows={rows} cols={cols} cells={sparseCells} emptyMessage="none" />,
    );
    const grid = container.querySelector('[data-slot="matrix-heat-grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.querySelectorAll('button')).toHaveLength(sparseCells.length);
    expect(rows.length * cols.length).toBeGreaterThan(sparseCells.length);
  });

  it('renders the STACK form when the layout override is explicit, one tab per row', () => {
    const { container } = render(
      <MatrixHeat rows={rows} cols={cols} cells={sparseCells} emptyMessage="none" layout="stack" />,
    );
    const stack = container.querySelector('[data-slot="matrix-heat-stack"]');
    expect(stack).not.toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(rows.length);

    const activePanel = container.querySelector('[data-state="active"][role="tabpanel"]');
    expect(activePanel).not.toBeNull();
    // r1 (the default-active first row) has 3 supplied cells (c1, c2, c3).
    expect(activePanel?.querySelectorAll('button')).toHaveLength(3);
  });

  it('a cell above the floor renders its win-losses pair with a win hue; an exactly-even tiered cell is neutral', () => {
    render(<MatrixHeat rows={rows} cols={cols} cells={sparseCells} emptyMessage="none" />);
    const winCell = screen.getByRole('button', { name: /Fox vs Falco on Battlefield: 4-1/ });
    expect(winCell.textContent).toBe('4–1');
    expect(winCell.className).toMatch(/emerald/);
    expect(winCell.className).not.toMatch(/destructive/);

    const evenCell = screen.getByRole('button', { name: /Fox vs Marth on Battlefield: 2-2/ });
    expect(evenCell.textContent).toBe('2–2');
    expect(evenCell.className).not.toMatch(/emerald/);
    expect(evenCell.className).not.toMatch(/destructive/);
  });

  it('a cell below the floor renders its count with no hue and demoted weight, and stays focusable and enabled', () => {
    render(<MatrixHeat rows={rows} cols={cols} cells={sparseCells} emptyMessage="none" />);
    const subFloorButton = screen.getByRole('button', {
      name: /Fox vs Falco on Final Destination: 1-1/,
    });
    expect(subFloorButton.textContent).toBe('2');
    expect(subFloorButton.className).not.toMatch(/emerald/);
    expect(subFloorButton.className).not.toMatch(/destructive/);
    expect(subFloorButton.className).toMatch(/font-normal/);
    expect(subFloorButton).not.toBeDisabled();
    subFloorButton.focus();
    expect(subFloorButton).toHaveFocus();
  });

  it('the unknown column header is the last column header, and a high-count cell inside it still renders sub-floor-neutral', () => {
    const { container } = render(
      <MatrixHeat rows={rows} cols={cols} cells={sparseCells} emptyMessage="none" />,
    );
    const headerCells = container.querySelectorAll('thead th');
    // First `th` is the empty corner cell; the remaining ones are the column headers.
    const columnHeaders = Array.from(headerCells).slice(1);
    expect(columnHeaders[columnHeaders.length - 1]?.textContent).toBe('Unknown stage');

    const unknownColCell = screen.getByRole('button', {
      name: /Fox vs Falco on Unknown stage: 25-0/,
    });
    expect(unknownColCell.textContent).toBe('25');
    expect(unknownColCell.className).not.toMatch(/emerald/);
    expect(unknownColCell.className).not.toMatch(/destructive/);
  });

  it('activating a cell calls the selection callback with that cell (row key and column key)', async () => {
    const user = userEvent.setup();
    const onSelectCell = vi.fn();
    render(
      <MatrixHeat
        rows={rows}
        cols={cols}
        cells={sparseCells}
        emptyMessage="none"
        onSelectCell={onSelectCell}
      />,
    );
    const winCell = screen.getByRole('button', { name: /Fox vs Falco on Battlefield: 4-1/ });
    await user.click(winCell);
    expect(onSelectCell).toHaveBeenCalledWith(
      expect.objectContaining({ rowKey: 'r1', colKey: 'c1' }),
    );
  });

  it('a zero-row matrix renders the supplied empty message and no table', () => {
    const { container } = render(
      <MatrixHeat rows={[]} cols={cols} cells={[]} emptyMessage="No games recorded yet." />,
    );
    expect(screen.getByText('No games recorded yet.')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
  });

  it('a zero-column matrix renders the supplied empty message and no table', () => {
    const { container } = render(
      <MatrixHeat rows={rows} cols={[]} cells={[]} emptyMessage="No games recorded yet." />,
    );
    expect(screen.getByText('No games recorded yet.')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
  });

  it('a one-row-by-one-column matrix renders a single cell with no special layout branch', () => {
    const oneRow: MatrixHeatAxis[] = [{ key: 'r1', label: 'Fox vs Falco' }];
    const oneCol: MatrixHeatAxis[] = [{ key: 'c1', label: 'Battlefield' }];
    const oneCell = [tieredCell('r1', 'c1', 3, 0, 'low')];
    const { container } = render(
      <MatrixHeat rows={oneRow} cols={oneCol} cells={oneCell} emptyMessage="none" />,
    );
    const grid = container.querySelector('[data-slot="matrix-heat-grid"]');
    expect(grid?.querySelectorAll('button')).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActivityHeatCell, ConfidenceTier, SampleMeta } from '@smash-tracker/shared';
import { careerGamesFill, volumeHeatStep } from './careerTimelineLayout';
import {
  MatrixHeat,
  type MatrixHeatAxis,
  type MatrixHeatCell,
  type MatrixHeatVolumeProps,
} from './MatrixHeat';

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

// Plan 39.1-39 (design audit 7.4): the grid sits at the card's content edge —
// no centring — so the card hugs its content; the narrow Tabs stack is unchanged.
describe('MatrixHeat — the grid hugs the card content edge (plan 39.1-39)', () => {
  it('the grid table carries no mx-auto (and keeps w-max)', () => {
    const { container } = render(
      <MatrixHeat rows={rows} cols={cols} cells={sparseCells} emptyMessage="none" />,
    );
    const table = container.querySelector('[data-slot="matrix-heat-grid"] table') as HTMLElement;
    expect(table).not.toBeNull();
    const classes = table.className.split(/\s+/);
    expect(classes).not.toContain('mx-auto');
    expect(classes).toContain('w-max');
  });

  it('the narrow stack still renders its tabs', () => {
    const { container } = render(
      <MatrixHeat rows={rows} cols={cols} cells={sparseCells} emptyMessage="none" layout="stack" />,
    );
    expect(container.querySelector('[data-slot="matrix-heat-stack"]')).not.toBeNull();
  });
});

/**
 * Plan 39.1-49 (OOS-5): at 390px on the opponent hub the stack's third
 * pairing tab was cut at the card edge by the tab list's sideways scroller.
 * The tab list now wraps whole tabs; the desktop grid is unchanged.
 */
describe('MatrixHeat stack tab list wraps whole tabs (plan 39.1-49, OOS-5)', () => {
  const many: MatrixHeatAxis[] = [
    { key: 'r1', label: 'Fox vs Falco' },
    { key: 'r2', label: 'Fox vs Marth' },
    { key: 'r3', label: 'Captain Falcon vs Falco' },
  ];
  const manyCells = many.flatMap((row) =>
    cols
      .filter((col) => !col.isUnknown)
      .map((col) => makeCell({ rowKey: row.key, colKey: col.key })),
  );

  it('wrapping tab list: flex-wrap, no overflow-x-auto, every tab label whole with its aria-label; the third tab shows its panel', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MatrixHeat rows={many} cols={cols} cells={manyCells} emptyMessage="none" layout="stack" />,
    );
    const list = screen.getByRole('tablist');
    const classes = list.className.split(/\s+/);
    expect(classes).toContain('flex-wrap');
    expect(classes).not.toContain('overflow-x-auto');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(many.map((row) => row.label));
    for (const tab of tabs) {
      expect(tab.getAttribute('aria-label')).toBeTruthy();
    }
    await user.click(tabs[2]!);
    const panel = container.querySelector('[data-state="active"][role="tabpanel"]');
    expect(panel?.getAttribute('aria-labelledby')).toBe(tabs[2]!.id);
  });

  it('the grid layout is unchanged: matrix-heat-grid keeps its overflow-x-auto', () => {
    const { container } = render(
      <MatrixHeat rows={many} cols={cols} cells={manyCells} emptyMessage="none" layout="grid" />,
    );
    const grid = container.querySelector('[data-slot="matrix-heat-grid"]');
    expect(grid).not.toBeNull();
    expect(grid!.className.split(/\s+/)).toContain('overflow-x-auto');
  });
});

/**
 * DD-41-06 / UI-SPEC 7.3 / Pitfall 5: `scale` omitted leaves record mode byte-identical. The two
 * markup strings below were captured from the component BEFORE the volume mode was added (same
 * fixture, `layout` forced), so a drift in record mode - a class, an attribute, a wrapper - fails here.
 * Radix's generated ids are normalised (`radix-ID-`): their counter depends on test order.
 */
const RECORD_BASELINE_GRID =
  '<div class="overflow-x-auto" data-slot="matrix-heat-grid"><table class="w-max border-separate border-spacing-0 text-sm"><thead><tr><th class="sticky left-0 z-10 w-32 border-r border-border bg-card p-2 text-left"></th><th class="w-32 truncate px-2 py-1 text-left text-xs text-muted-foreground" title="Battlefield">Battlefield</th><th class="w-32 truncate px-2 py-1 text-left text-xs text-muted-foreground" title="Unknown stage">Unknown stage</th></tr></thead><tbody><tr><th scope="row" class="sticky left-0 z-10 border-r border-border bg-card p-2 text-left font-normal w-32 truncate px-2 py-1 text-left text-xs text-muted-foreground" title="Fox vs Falco">Fox vs Falco</th><td class="p-1 text-center"><button type="button" class="flex size-12 items-center justify-center rounded text-sm font-semibold transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring bg-emerald-500/15 text-emerald-300" aria-label="Fox vs Falco on Battlefield: 4-1" title="5 games \u00b7 low confidence">4\u20131</button></td><td class="p-1 text-center"><button type="button" class="flex size-12 items-center justify-center rounded text-sm transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring bg-muted/50 text-muted-foreground font-normal" aria-label="Fox vs Falco on Unknown stage: 1-1" title="Not enough data yet (2 games)">2</button></td></tr><tr><th scope="row" class="sticky left-0 z-10 border-r border-border bg-card p-2 text-left font-normal w-32 truncate px-2 py-1 text-left text-xs text-muted-foreground" title="Fox vs Marth">Fox vs Marth</th><td class="p-1 text-center"><button type="button" class="flex size-12 items-center justify-center rounded text-sm font-semibold transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring bg-muted text-foreground" aria-label="Fox vs Marth on Battlefield: 2-2" title="4 games \u00b7 medium confidence">2\u20132</button></td><td class="p-1 text-center"><button type="button" class="flex size-12 items-center justify-center rounded text-sm transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring bg-muted/50 text-muted-foreground font-normal" aria-label="Fox vs Marth on Unknown stage: 1-9" title="Not enough data yet (10 games)">10</button></td></tr></tbody></table></div>';
const RECORD_BASELINE_STACK =
  '<div dir="ltr" data-orientation="horizontal" data-slot="matrix-heat-stack" class="flex flex-col gap-2"><div role="tablist" aria-orientation="horizontal" data-slot="tabs-list" class="items-center gap-1 flex h-auto w-full flex-wrap justify-start" tabindex="0" data-orientation="horizontal" style="outline: none;"><button type="button" role="tab" aria-selected="true" aria-controls="radix-ID-content-r1" data-state="active" id="radix-ID-trigger-r1" data-slot="tabs-trigger" class="inline-flex items-center justify-center gap-1.5 border-b-2 border-transparent px-4 py-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:font-semibold [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*=\'size-\'])]:size-4" aria-label="Fox vs Falco\'s stage breakdown" tabindex="-1" data-orientation="horizontal" data-radix-collection-item="">Fox vs Falco</button><button type="button" role="tab" aria-selected="false" aria-controls="radix-ID-content-r2" data-state="inactive" id="radix-ID-trigger-r2" data-slot="tabs-trigger" class="inline-flex items-center justify-center gap-1.5 border-b-2 border-transparent px-4 py-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:font-semibold [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*=\'size-\'])]:size-4" aria-label="Fox vs Marth\'s stage breakdown" tabindex="-1" data-orientation="horizontal" data-radix-collection-item="">Fox vs Marth</button></div><div data-state="active" data-orientation="horizontal" role="tabpanel" aria-labelledby="radix-ID-trigger-r1" id="radix-ID-content-r1" tabindex="0" data-slot="tabs-content" class="flex-1 outline-none data-[state=inactive]:hidden" style="animation-duration: 0s;"><ul class="flex flex-col gap-2"><li class="flex items-center justify-between gap-2"><span class="text-sm text-muted-foreground">Battlefield</span><button type="button" class="flex size-12 items-center justify-center rounded text-sm font-semibold transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring bg-emerald-500/15 text-emerald-300" aria-label="Fox vs Falco on Battlefield: 4-1" title="5 games \u00b7 low confidence">4\u20131</button></li><li class="flex items-center justify-between gap-2"><span class="text-sm text-muted-foreground">Unknown stage</span><button type="button" class="flex size-12 items-center justify-center rounded text-sm transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring bg-muted/50 text-muted-foreground font-normal" aria-label="Fox vs Falco on Unknown stage: 1-1" title="Not enough data yet (2 games)">2</button></li></ul></div><div data-state="inactive" data-orientation="horizontal" role="tabpanel" aria-labelledby="radix-ID-trigger-r2" hidden="" id="radix-ID-content-r2" tabindex="0" data-slot="tabs-content" class="flex-1 outline-none data-[state=inactive]:hidden"></div></div>';

function baselineSample(tier: ConfidenceTier | null, total: number): SampleMeta {
  return makeSample({ rawSampleSize: total, eligibleDenominator: total, confidenceTier: tier });
}

const baselineRows: MatrixHeatAxis[] = [
  { key: 'r1', label: 'Fox vs Falco' },
  { key: 'r2', label: 'Fox vs Marth' },
];
const baselineCols: MatrixHeatAxis[] = [
  { key: 'c1', label: 'Battlefield' },
  { key: 'c2', label: 'Unknown stage', isUnknown: true },
];
const baselineCells: MatrixHeatCell[] = [
  makeCell({
    rowKey: 'r1',
    colKey: 'c1',
    wins: 4,
    losses: 1,
    total: 5,
    sample: baselineSample('low', 5),
  }),
  makeCell({
    rowKey: 'r1',
    colKey: 'c2',
    wins: 1,
    losses: 1,
    total: 2,
    confidenceTier: null,
    sample: baselineSample(null, 2),
  }),
  makeCell({
    rowKey: 'r2',
    colKey: 'c1',
    wins: 2,
    losses: 2,
    total: 4,
    confidenceTier: 'medium',
    sample: baselineSample('medium', 4),
  }),
  makeCell({
    rowKey: 'r2',
    colKey: 'c2',
    wins: 1,
    losses: 9,
    total: 10,
    confidenceTier: 'high',
    sample: baselineSample('high', 10),
  }),
];

describe('MatrixHeat record mode is unchanged when scale is omitted (DD-41-06)', () => {
  it('the grid form renders the exact pre-volume-mode markup, with scale omitted and with scale="record"', () => {
    const omitted = render(
      <MatrixHeat
        rows={baselineRows}
        cols={baselineCols}
        cells={baselineCells}
        emptyMessage="none"
        layout="grid"
      />,
    ).container.innerHTML;
    expect(omitted).toBe(RECORD_BASELINE_GRID);
    const explicit = render(
      <MatrixHeat
        scale="record"
        rows={baselineRows}
        cols={baselineCols}
        cells={baselineCells}
        emptyMessage="none"
        layout="grid"
      />,
    ).container.innerHTML;
    expect(explicit).toBe(RECORD_BASELINE_GRID);
  });

  it('the stack form renders the exact pre-volume-mode markup', () => {
    const html = render(
      <MatrixHeat
        rows={baselineRows}
        cols={baselineCols}
        cells={baselineCells}
        emptyMessage="none"
        layout="stack"
      />,
    ).container.innerHTML.replace(/radix-_r_[0-9a-z]+_-/g, 'radix-ID-');
    expect(html).toBe(RECORD_BASELINE_STACK);
  });
});

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function heatCell(year: number, month: number, total: number): ActivityHeatCell {
  return {
    year,
    month,
    total,
    fromMs: Date.UTC(year, month - 1, 1),
    toMs: Date.UTC(year, month, 1) - 1,
  };
}

function renderVolume(
  years: number[],
  cells: ActivityHeatCell[],
  overrides: Partial<MatrixHeatVolumeProps> = {},
) {
  const maxCellValue = cells.reduce((max, cell) => Math.max(max, cell.total), 0);
  return render(
    <MatrixHeat
      scale="volume"
      years={years}
      cells={cells}
      maxCellValue={maxCellValue}
      monthLabels={MONTH_NAMES}
      monthLabelsNarrow={MONTH_NAMES.map((name) => name.slice(0, 2))}
      yearLabel={(year, narrow) => (narrow ? `'${String(year).slice(2)}` : String(year))}
      cellAria={(cell) => `${MONTH_NAMES[cell.month - 1]} ${cell.year}: ${cell.total} games`}
      emptyAria={(year, month) => `${MONTH_NAMES[month - 1]} ${year}: no games`}
      formatCount={(n) => String(n)}
      legend={{ fewer: 'fewer', more: 'more', unit: '= games in the month' }}
      {...overrides}
    />,
  );
}

describe('MatrixHeat scale="volume" (DD-41-06)', () => {
  const cells = [heatCell(2026, 3, 100), heatCell(2026, 4, 1), heatCell(2025, 12, 25)];

  it('renders one button per supplied cell and a placeholder for every other month', () => {
    const { container } = renderVolume([2026, 2025], cells);
    const root = container.querySelector('[data-slot="matrix-heat-volume"]')!;
    expect(root.querySelectorAll('button')).toHaveLength(cells.length);
    const placeholders = root.querySelectorAll('.bg-muted\\/20');
    expect(placeholders).toHaveLength(12 * 2 - cells.length);
    // A placeholder is not a control and is not announced.
    for (const placeholder of placeholders) {
      expect(placeholder.tagName).toBe('DIV');
      expect(placeholder.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('never renders the record-mode Tabs stack, table, or a record tint', () => {
    const { container } = renderVolume([2026, 2025], cells);
    expect(container.querySelector('[data-slot="matrix-heat-stack"]')).toBeNull();
    expect(container.querySelector('[data-slot="matrix-heat-grid"]')).toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
    expect(container.innerHTML).not.toMatch(/emerald|destructive/);
  });

  it('tints by the shared games ramp: the busiest month is step 5, one game beside 100 is step 1', () => {
    expect(volumeHeatStep(100, 100)).toBe(5);
    expect(volumeHeatStep(1, 100)).toBe(1);
    renderVolume([2026, 2025], cells);
    expect(screen.getByRole('button', { name: 'Mar 2026: 100 games' })).toHaveStyle({
      backgroundColor: careerGamesFill(5),
    });
    expect(screen.getByRole('button', { name: 'Apr 2026: 1 games' })).toHaveStyle({
      backgroundColor: careerGamesFill(1),
    });
  });

  it('the tint step is monotone in the month count', () => {
    let previous = 0;
    for (let n = 1; n <= 100; n += 1) {
      const step = volumeHeatStep(n, 100);
      expect(step).toBeGreaterThanOrEqual(previous);
      expect(step).toBeGreaterThanOrEqual(1);
      expect(step).toBeLessThanOrEqual(5);
      previous = step;
    }
    expect(previous).toBe(5);
  });

  it('gives every cell its host-built aria-label and tooltip', () => {
    renderVolume([2026, 2025], cells);
    const button = screen.getByRole('button', { name: 'Dec 2025: 25 games' });
    expect(button).toHaveAttribute('title', 'Dec 2025: 25 games');
  });

  it('a click hands the host the exact month cell (its fromMs / toMs)', async () => {
    const user = userEvent.setup();
    const onSelectCell = vi.fn();
    renderVolume([2026, 2025], cells, { onSelectCell });
    await user.click(screen.getByRole('button', { name: 'Dec 2025: 25 games' }));
    expect(onSelectCell).toHaveBeenCalledTimes(1);
    expect(onSelectCell).toHaveBeenCalledWith(
      expect.objectContaining({
        year: 2025,
        month: 12,
        fromMs: Date.UTC(2025, 11, 1),
        toMs: Date.UTC(2026, 0, 1) - 1,
      }),
    );
  });

  it('prints the count inside a cell only from the 480px container query, never as its accessible name', () => {
    renderVolume([2026], [heatCell(2026, 3, 100)]);
    const button = screen.getByRole('button', { name: 'Mar 2026: 100 games' });
    const count = within(button).getByText('100');
    expect(count.className).toContain('hidden');
    expect(count.className).toContain('@[480px]:inline');
  });

  it('keeps both month-label forms in the header: the narrow two-letter labels show below a 300px container', () => {
    const { container } = renderVolume([2026], [heatCell(2026, 3, 5)]);
    const narrow = Array.from(
      container.querySelectorAll('[data-slot="matrix-heat-volume"] span.hidden'),
    ).filter((el) => (el.className ?? '').includes('@max-[300px]:inline'));
    expect(narrow.map((el) => el.textContent)).toEqual(MONTH_NAMES.map((name) => name.slice(0, 2)));
    const full = container.querySelectorAll('span.\\@max-\\[300px\\]\\:hidden');
    expect(Array.from(full).map((el) => el.textContent)).toEqual(MONTH_NAMES);
  });

  it('shows the year as a full and a two-digit form, the two-digit one only below 640px', () => {
    const { container } = renderVolume([2026], [heatCell(2026, 3, 5)]);
    expect(container.textContent).toContain('2026');
    expect(container.textContent).toContain("'26");
    const row = screen.getByLabelText('2026');
    expect(within(row).getByText('2026').className).toContain('max-sm:hidden');
    expect(within(row).getByText("'26").className).toContain('max-sm:inline');
  });

  it('prints the legend: fewer, five swatches, more, unit', () => {
    const { container } = renderVolume([2026], [heatCell(2026, 3, 5)]);
    const legend = container.querySelector('[data-slot="matrix-heat-legend"]')!;
    expect(legend.textContent).toBe('fewermore= games in the month');
    expect(legend.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(5);
  });

  it('a single year renders a single row of twelve squares', () => {
    const { container } = renderVolume([2026], [heatCell(2026, 3, 5)]);
    const root = container.querySelector('[data-slot="matrix-heat-volume"]')!;
    expect(root.querySelectorAll('button')).toHaveLength(1);
    expect(root.querySelectorAll('.bg-muted\\/20')).toHaveLength(11);
  });

  it('uses no hex literal and no raw chart variable', () => {
    const { container } = renderVolume([2026, 2025], cells);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(container.innerHTML).not.toContain('var(--chart-');
  });
});

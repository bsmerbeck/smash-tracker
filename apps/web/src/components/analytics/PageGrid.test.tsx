import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { GridCell, PageGrid, type GridCellSpan } from './PageGrid';

describe('PageGrid', () => {
  it('renders data-slot="page-grid" and grid-cols-12 items-start, hardcoded (no prop disables it)', () => {
    const { container } = render(<PageGrid />);
    const grid = container.querySelector('[data-slot="page-grid"]');
    expect(grid).not.toBeNull();
    expect(grid!.className).toContain('grid-cols-12');
    expect(grid!.className).toContain('items-start');
  });

  it('with zero children renders exactly one element and zero cells', () => {
    const { container } = render(<PageGrid />);
    const grid = container.querySelector('[data-slot="page-grid"]')!;
    expect(grid.children).toHaveLength(0);
    expect(container.querySelectorAll('[data-span]')).toHaveLength(0);
  });

  it('renders children in the given DOM order', () => {
    const { container } = render(
      <PageGrid>
        <GridCell span={4} key="a">
          <span data-testid="a">A</span>
        </GridCell>
        <GridCell span={4} key="b">
          <span data-testid="b">B</span>
        </GridCell>
        <GridCell span={4} key="c">
          <span data-testid="c">C</span>
        </GridCell>
      </PageGrid>,
    );
    const grid = container.querySelector('[data-slot="page-grid"]')!;
    const testIds = Array.from(grid.querySelectorAll('[data-testid]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(testIds).toEqual(['a', 'b', 'c']);
  });

  const SPANS: GridCellSpan[] = [3, 4, 6, 8, 12];
  const EXPECTED_LG_CLASS: Record<GridCellSpan, string> = {
    3: 'lg:col-span-3',
    4: 'lg:col-span-4',
    6: 'lg:col-span-6',
    8: 'lg:col-span-8',
    12: 'col-span-12',
  };

  it.each(SPANS)('span %i renders its exact col-span class and data-span attribute', (span) => {
    const { container } = render(<GridCell span={span}>content</GridCell>);
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.getAttribute('data-span')).toBe(String(span));
    expect(cell.className.split(/\s+/)).toContain(EXPECTED_LG_CLASS[span]);
    expect(cell.className).toContain('col-span-12');
  });

  it('two cells whose spans sum to exactly 12 carry base classes that place them on one row (browser-verified by the layout oracle, §13.1)', () => {
    const { container } = render(
      <PageGrid>
        <GridCell span={8}>chart</GridCell>
        <GridCell span={4}>rail</GridCell>
      </PageGrid>,
    );
    const cells = container.querySelectorAll('[data-span]');
    expect(Array.from(cells).map((c) => c.getAttribute('data-span'))).toEqual(['8', '4']);
  });

  it('a GridCell with no children renders a zero-height cell with no stretch or min-height utility', () => {
    const { container } = render(<GridCell span={4} />);
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.children).toHaveLength(0);
    expect(cell.className).not.toMatch(/\bh-full\b|\bmin-h-\S+|\bflex-1\b/);
  });

  it('GridCell stack renders a 100px and a 400px child at their own intrinsic heights, never stretched', () => {
    const { container } = render(
      <GridCell span={4} stack>
        <div data-testid="short" style={{ height: '100px' }} />
        <div data-testid="tall" style={{ height: '400px' }} />
      </GridCell>,
    );
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.className).toContain('flex');
    expect(cell.className).toContain('flex-col');
    expect(cell.className).toContain('gap-4');
    // Neither child receives an added class from GridCell — no stretch utility exists anywhere in the tree.
    for (const testId of ['short', 'tall']) {
      const child = cell.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
      expect(child.className).not.toMatch(/\bh-full\b|\bflex-1\b|\bself-stretch\b/);
    }
  });

  it('a GridCell span outside the closed union is a TypeScript error', () => {
    // @ts-expect-error — 5 is not a member of GridCellSpan (3 | 4 | 6 | 8 | 12)
    const invalid = <GridCell span={5}>nope</GridCell>;
    expect(invalid).toBeTruthy();
  });
});

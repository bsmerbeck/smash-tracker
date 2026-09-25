import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';

/**
 * Plan 39.1-38 (design-audit item 6 / P5; UI-SPEC §6.1, §10.4; sketch 001-C /
 * 002-C `.filters`): the ONE unboxed page filter row — title (h1 on the
 * `figure` role), leading slot, a flex spacer, trailing slot. The module is
 * imported dynamically so the RED run fails on an assertion, not at import.
 */
const MODULE_SPECIFIER = './PageFilterRow';

interface PageFilterRowProps {
  title?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}

async function loadPageFilterRow(): Promise<ComponentType<PageFilterRowProps>> {
  const mod = (await import(/* @vite-ignore */ MODULE_SPECIFIER).catch(() => null)) as {
    PageFilterRow?: ComponentType<PageFilterRowProps>;
  } | null;
  expect(mod?.PageFilterRow, 'PageFilterRow is exported').toBeTypeOf('function');
  return mod!.PageFilterRow!;
}

describe('PageFilterRow (plan 39.1-38, UI-SPEC §10.4)', () => {
  it('renders data-slot="page-filter-row" with the h1 on the figure role, then leading, a flex-1 spacer, then trailing', async () => {
    const PageFilterRow = await loadPageFilterRow();
    const { container } = render(
      <PageFilterRow
        title="Fighter Analysis"
        leading={<button type="button">picker</button>}
        trailing={<div data-testid="switch">switch</div>}
      />,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row).toHaveAttribute('data-slot', 'page-filter-row');

    const h1 = screen.getByRole('heading', { level: 1, name: 'Fighter Analysis' });
    const h1Classes = h1.className.split(/\s+/);
    expect(h1Classes).toEqual(expect.arrayContaining(['text-xl', 'leading-6', 'font-semibold']));
    expect(h1.className).not.toMatch(/text-2xl|text-center/);

    const kids = Array.from(row.children);
    expect(kids[0]).toBe(h1);
    expect(kids[1]).toBe(screen.getByRole('button', { name: 'picker' }));
    expect(kids[2]).toHaveAttribute('aria-hidden');
    expect(kids[2].className).toMatch(/\bflex-1\b/);
    expect(kids[3]).toBe(screen.getByTestId('switch'));
  });

  it('is unboxed: no card, no border, no background and no padding of its own', async () => {
    const PageFilterRow = await loadPageFilterRow();
    const { container } = render(<PageFilterRow title="Trends" trailing={<span>switch</span>} />);
    const row = container.firstElementChild as HTMLElement;
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    expect(row.className).not.toMatch(/(^|\s)(border|rounded|bg-|shadow|p-\d|px-\d|py-\d|pt-\d)/);
  });

  it('omits the h1 when no title is given (the Dashboard has no page title)', async () => {
    const PageFilterRow = await loadPageFilterRow();
    const { container } = render(
      <PageFilterRow leading={<span>picker</span>} trailing={<span>switch</span>} />,
    );
    expect(container.querySelector('h1')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('data-slot', 'page-filter-row');
  });
});

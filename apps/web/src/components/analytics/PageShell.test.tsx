import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageShell } from './PageShell';

describe('PageShell', () => {
  it('caps content at 1440px and renders the filter row before the children', () => {
    const { container } = render(
      <PageShell filterRow={<div data-testid="filter-row">Filters</div>}>
        <div data-testid="content">Body</div>
      </PageShell>,
    );

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('max-w-[1440px]');
    expect(root.className).toContain('mx-auto');

    const children = Array.from(root.children);
    expect(children[0]).toBe(screen.getByTestId('filter-row'));
    expect(children[1]).toBe(screen.getByTestId('content'));
  });

  it('renders only the children when no filter row is given', () => {
    render(
      <PageShell>
        <div data-testid="content">Body</div>
      </PageShell>,
    );
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('plan 39.1-38: carries data-slot="page-shell" and the named inline-size container `page` (the StatRow / list-pair collapse keys on it)', () => {
    const { container } = render(
      <PageShell>
        <div>Body</div>
      </PageShell>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('data-slot', 'page-shell');
    expect(root.className.split(/\s+/)).toContain('@container/page');
  });
});

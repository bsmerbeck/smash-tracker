import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CardSkeleton, PageSkeleton } from './CardSkeleton';

describe('CardSkeleton', () => {
  it('stat-row variant renders 2 blocks per pair (label + figure)', () => {
    const { container } = render(
      <CardSkeleton variant="stat-row" rows={3} statusLabel="Loading stats" />,
    );
    expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(6);
  });

  it('chart variant renders a title bar plus one plot-height block, regardless of rows', () => {
    const { container } = render(<CardSkeleton variant="chart" statusLabel="Loading chart" />);
    expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(2);
  });

  it('list variant renders a title plus one block per row', () => {
    const { container } = render(
      <CardSkeleton variant="list" rows={4} statusLabel="Loading list" />,
    );
    expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(5);
  });

  it('insight variant renders a chip, two text lines and a door (4 blocks)', () => {
    const { container } = render(<CardSkeleton variant="insight" statusLabel="Loading insight" />);
    expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(4);
  });

  it('wrapper carries role="status" and aria-busy="true" with the visually hidden status label', () => {
    render(<CardSkeleton variant="chart" statusLabel="Loading chart" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading chart')).toBeInTheDocument();
  });

  it('every block is aria-hidden and pairs the pulse utility with its reduced-motion counterpart', () => {
    const { container } = render(<CardSkeleton variant="chart" statusLabel="Loading chart" />);
    const blocks = container.querySelectorAll('[data-slot="skeleton-block"]');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.getAttribute('aria-hidden')).toBe('true');
      expect(block.className).toContain('animate-pulse');
      expect(block.className).toContain('motion-reduce:animate-none');
    }
  });
});

describe('PageSkeleton', () => {
  it('renders the given children unchanged (a thin PageGrid-shaped wrapper)', () => {
    render(
      <PageSkeleton>
        <div data-testid="skeleton-child">child</div>
      </PageSkeleton>,
    );
    expect(screen.getByTestId('skeleton-child')).toBeInTheDocument();
  });
});

describe('CardSkeleton source contract', () => {
  it('imports no shadcn Skeleton component', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/CardSkeleton.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/@\/components\/ui\/skeleton/);
  });
});

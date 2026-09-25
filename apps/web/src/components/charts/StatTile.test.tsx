import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatTile } from './StatTile';

describe('StatTile', () => {
  // Plan 39.1-20 (UIX-04): StatTile is now a thin wrapper over the one stat
  // idiom (StatRow/StatFigure) — the old per-stat `.flex.flex-col.items-
  // center.text-center` wrapper class is gone, replaced by StatFigure's own
  // markup. Updated to scope on StatFigure's exported shape instead: exactly
  // one `[data-slot="page-grid"]`-free StatRow (no justify-evenly collision)
  // rendering exactly N figures, each a label + value pair.
  it('renders one label/value pair per stat through the StatRow idiom, and no trend row when none is given', () => {
    const { container } = render(
      <StatTile
        stats={[
          { label: 'Wins', value: 4 },
          { label: 'Total Matches', value: 7 },
          { label: 'Losses', value: 3 },
        ]}
      />,
    );

    expect(screen.getByText('Wins')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Total Matches')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Losses')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // §13.3: no flex-distribution collision anywhere in this render.
    expect(container.querySelector('.justify-evenly, .justify-around')).toBeNull();
    // Exactly 3 stat figures render inside the one StatRow grid, no extra
    // (trend) row.
    const statRow = container.querySelector('.grid');
    expect(statRow).not.toBeNull();
    expect(statRow?.children).toHaveLength(3);
  });

  it('renders the trend node beneath the stats row when given one', () => {
    render(
      <StatTile
        stats={[{ label: 'Wins', value: 1 }]}
        trend={<span data-testid="trend-node">recent form</span>}
      />,
    );

    expect(screen.getByTestId('trend-node')).toBeInTheDocument();
  });
});

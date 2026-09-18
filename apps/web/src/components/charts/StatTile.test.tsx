import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatTile } from './StatTile';

describe('StatTile', () => {
  it('renders one label/value pair per stat and no trend row when none is given', () => {
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
    // Exactly 3 stat cells, no extra (trend) row.
    expect(container.querySelectorAll('.flex.flex-col.items-center.text-center')).toHaveLength(3);
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

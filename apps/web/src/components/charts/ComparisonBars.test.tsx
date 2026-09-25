import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComparisonBars, type ComparisonBarsDumbbellRow } from './ComparisonBars';

describe('ComparisonBars', () => {
  it('renders one list item per row with a track and a filled meter sized to the value', () => {
    const { container } = render(
      <ComparisonBars
        tone="emerald"
        rows={[
          { key: 'a', label: <span>Battlefield</span>, value: 80, valueLabel: '4-1 (80% over 5)' },
          { key: 'b', label: <span>Smashville</span>, value: 40, valueLabel: '2-3 (40% over 5)' },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const tracks = container.querySelectorAll('[data-slot="comparison-bar-track"]');
    const fills = container.querySelectorAll('[data-slot="comparison-bar-fill"]');
    expect(tracks).toHaveLength(2);
    expect(fills).toHaveLength(2);
    expect((fills[0] as HTMLElement).style.width).toBe('80%');
    expect((fills[1] as HTMLElement).style.width).toBe('40%');
    expect(screen.getByText('4-1 (80% over 5)')).toBeInTheDocument();
  });

  it('calls onSelectRow with the clicked row when a click handler is given', async () => {
    const user = userEvent.setup();
    const onSelectRow = vi.fn();
    render(
      <ComparisonBars
        tone="destructive"
        rows={[
          {
            key: 'a',
            label: <span>Battlefield</span>,
            value: 20,
            valueLabel: '1-4 (20% over 5)',
          },
        ]}
        onSelectRow={onSelectRow}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(onSelectRow).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }));
  });

  it('renders no clickable button when no onSelectRow handler is given', () => {
    render(
      <ComparisonBars
        tone="emerald"
        rows={[
          {
            key: 'a',
            label: <span>Battlefield</span>,
            value: 80,
            valueLabel: '4-1 (80% over 5)',
          },
        ]}
      />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

function dumbbellRow(
  overrides: Partial<ComparisonBarsDumbbellRow> = {},
): ComparisonBarsDumbbellRow {
  return {
    key: 'a',
    label: <span>Battlefield</span>,
    recentRecordNode: <span>3-2</span>,
    deltaNode: <span>+5%</span>,
    baselineRate: 50,
    recentRate: 60,
    recentRange: [45, 75],
    recentTotal: 5,
    href: '/matchups/battlefield',
    ariaLabel: 'vs Battlefield: recent 3-2, 60%, 5 games',
    ...overrides,
  };
}

describe('ComparisonBars mode="dumbbell"', () => {
  it('renders a healthy row with the four track elements plus the recent dot', () => {
    const { container } = render(<ComparisonBars mode="dumbbell" rows={[dumbbellRow()]} />);
    expect(container.querySelectorAll('[data-slot="dumbbell-rail"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="dumbbell-midline"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="dumbbell-range"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="dumbbell-baseline-tick"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="dumbbell-recent-dot"]')).toHaveLength(1);
  });

  it('omits the recent dot and range bar when recentTotal is one below the abstention floor', () => {
    const { container } = render(
      <ComparisonBars mode="dumbbell" rows={[dumbbellRow({ recentTotal: 2 })]} />,
    );
    expect(container.querySelectorAll('[data-slot="dumbbell-baseline-tick"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="dumbbell-recent-dot"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-slot="dumbbell-range"]')).toHaveLength(0);
  });

  it('renders only the baseline tick and an empty delta slot when collapsed', () => {
    const { container } = render(
      <ComparisonBars mode="dumbbell" rows={[dumbbellRow({ collapsed: true })]} />,
    );
    expect(container.querySelectorAll('[data-slot="dumbbell-baseline-tick"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="dumbbell-recent-dot"]')).toHaveLength(0);
    const deltaSlot = container.querySelector('[data-slot="dumbbell-delta"]') as HTMLElement;
    expect(deltaSlot.textContent).toBe('');
  });

  it('renders rows in the order given, never sorted', () => {
    render(
      <ComparisonBars
        mode="dumbbell"
        rows={[
          dumbbellRow({ key: 'b', label: <span>Small Battlefield</span> }),
          dumbbellRow({ key: 'a', label: <span>Battlefield</span> }),
        ]}
      />,
    );
    const labels = screen.getAllByText(/Battlefield/).map((node) => node.textContent);
    expect(labels).toEqual(['Small Battlefield', 'Battlefield']);
  });

  it('renders the row as one link carrying the supplied accessible label', () => {
    render(<ComparisonBars mode="dumbbell" rows={[dumbbellRow()]} />);
    expect(
      screen.getByRole('link', { name: 'vs Battlefield: recent 3-2, 60%, 5 games' }),
    ).toBeInTheDocument();
  });
});

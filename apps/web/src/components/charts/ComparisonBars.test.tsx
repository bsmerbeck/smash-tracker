import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComparisonBars } from './ComparisonBars';

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

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

describe('ComparisonBars tone="series" (plan 39.1-46, PD-46-1: sketch 003 A .cmp rows)', () => {
  function seriesRows() {
    return [
      {
        key: 'a',
        label: 'Smashville',
        labelTitle: 'Smashville',
        value: 80,
        valueLabel: '4–1 · 80% · 5',
        valueNode: <b data-testid="node-a">4–1</b>,
      },
      {
        key: 'b',
        label: 'Battlefield',
        value: 50,
        valueLabel: '1–1 · 2',
        subFloor: true,
      },
    ];
  }

  it('series-rows: fills with the identity series token on a muted 6px track', () => {
    const { container } = render(<ComparisonBars tone="series" rows={seriesRows()} />);
    const tracks = container.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-track"]');
    const fills = container.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-fill"]');
    expect(tracks).toHaveLength(2);
    expect(tracks[0]!.className).toContain('bg-muted');
    expect(tracks[0]!.className).toContain('h-1.5');
    expect(fills[0]!.style.backgroundColor).toBe('var(--viz-series-1)');
    expect(fills[0]!.style.width).toBe('80%');
    // No status colour anywhere in the neutral tone.
    expect(container.innerHTML).not.toMatch(/emerald|destructive/);
  });

  it('series-rows: referenceRate draws one 2px all-time tick per row at that percentage', () => {
    const { container } = render(
      <ComparisonBars tone="series" referenceRate={63} rows={seriesRows()} />,
    );
    const ticks = container.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-reference"]');
    expect(ticks).toHaveLength(2);
    expect(ticks[0]!.style.left).toBe('63%');
    expect(ticks[0]!.style.width).toBe('2px');
    expect(ticks[0]!.style.backgroundColor).toBe('var(--viz-context)');
  });

  it('series-rows: no referenceRate draws no tick', () => {
    const { container } = render(<ComparisonBars tone="series" rows={seriesRows()} />);
    expect(container.querySelector('[data-slot="comparison-bar-reference"]')).toBeNull();
  });

  it('series-rows: a subFloor row fills with the strong de-emphasis token and mutes its label', () => {
    const { container } = render(<ComparisonBars tone="series" rows={seriesRows()} />);
    const fills = container.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-fill"]');
    expect(fills[1]!.style.backgroundColor).toBe('var(--viz-context-strong)');
    const labels = container.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-label"]');
    expect(labels[0]!.className).not.toContain('text-muted-foreground');
    expect(labels[1]!.className).toContain('text-muted-foreground');
  });

  it('series-rows: valueNode renders in place of valueLabel, which stays the accessible text', () => {
    render(<ComparisonBars tone="series" rows={seriesRows()} />);
    const node = screen.getByTestId('node-a');
    expect(node.closest('[aria-hidden="true"]')).not.toBeNull();
    // The accessible sentence is still in the DOM (screen-reader only).
    const sr = screen.getByText('4–1 · 80% · 5');
    expect(sr.className).toContain('sr-only');
    // A row without a valueNode prints its valueLabel visibly.
    expect(screen.getByText('1–1 · 2').className).not.toContain('sr-only');
  });

  it('series-rows: a long label truncates and carries its full text as a title', () => {
    const { container } = render(<ComparisonBars tone="series" rows={seriesRows()} />);
    const label = container.querySelector<HTMLElement>('[data-slot="comparison-bar-label"]')!;
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('min-w-0');
    expect(label.getAttribute('title')).toBe('Smashville');
  });

  it('series-rows: clickable rows are buttons carrying the hover wash; static rows are not', async () => {
    const user = userEvent.setup();
    const onSelectRow = vi.fn();
    const { rerender } = render(
      <ComparisonBars tone="series" rows={seriesRows()} onSelectRow={onSelectRow} />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.className).toContain('hover:bg-muted/40');
    await user.click(buttons[0]!);
    expect(onSelectRow).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }));
    rerender(<ComparisonBars tone="series" rows={seriesRows()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('series-rows: divided draws hairlines between rows; the default does not', () => {
    const { container, rerender } = render(<ComparisonBars tone="series" rows={seriesRows()} />);
    expect(container.querySelector('ul')!.className).not.toContain('divide-y');
    rerender(<ComparisonBars tone="series" divided rows={seriesRows()} />);
    expect(container.querySelector('ul')!.className).toContain('divide-y');
  });

  it('series-rows: the status tones keep their byte-identical layout (no series slots)', () => {
    const { container } = render(
      <ComparisonBars
        tone="emerald"
        rows={[{ key: 'a', label: <span>x</span>, value: 10, valueLabel: '1-0' }]}
      />,
    );
    expect(container.querySelector('[data-slot="comparison-bar-label"]')).toBeNull();
    expect(container.querySelector('[data-slot="comparison-bar-reference"]')).toBeNull();
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

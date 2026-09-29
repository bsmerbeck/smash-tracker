import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatFigure, StatRow } from './StatRow';

describe('StatRow', () => {
  it('the default grid carries data-slot="stat-row", no data-fixed-columns, and the existing 860px two-column collapse class', () => {
    const { container } = render(
      <StatRow
        figures={[
          <StatFigure key="a" label="Wins" value="1" />,
          <StatFigure key="b" label="Losses" value="2" />,
        ]}
      />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid).toHaveAttribute('data-slot', 'stat-row');
    expect(grid).not.toHaveAttribute('data-fixed-columns');
    expect(grid.className).toMatch(/@max-\[860px\]\/page:grid-cols-2/);
  });

  it('fixedColumns with 3 figures: grid-cols-3, no 860px collapse class, data-fixed-columns, hyphens-auto and break-words', () => {
    const { container } = render(
      <StatRow
        fixedColumns
        figures={[
          <StatFigure key="a" label="Current" value="1" />,
          <StatFigure key="b" label="Longest Win" value="3" />,
          <StatFigure key="c" label="Longest Loss" value="2" />,
        ]}
      />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid-cols-3');
    expect(grid.className).not.toMatch(/grid-cols-2/);
    expect(grid).toHaveAttribute('data-fixed-columns', '');
    expect(grid.className).toContain('hyphens-auto');
    expect(grid.className).toContain('break-words');
  });

  it('fixedColumns with 2 figures: grid-cols-2 and no collapse class', () => {
    const { container } = render(
      <StatRow
        fixedColumns
        figures={[
          <StatFigure key="a" label="Wins" value="1" />,
          <StatFigure key="b" label="Losses" value="2" />,
        ]}
      />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid-cols-2');
    expect(grid.className).not.toMatch(/\/page:grid-cols-2/);
    expect(grid).toHaveAttribute('data-fixed-columns', '');
  });

  it('fixedColumns is ignored with 4 figures: the collapse class stays and there is no data-fixed-columns', () => {
    const { container } = render(
      <StatRow
        fixedColumns
        figures={[
          <StatFigure key="a" label="A" value="1" />,
          <StatFigure key="b" label="B" value="2" />,
          <StatFigure key="c" label="C" value="3" />,
          <StatFigure key="d" label="D" value="4" />,
        ]}
      />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toMatch(/@max-\[860px\]\/page:grid-cols-2/);
    expect(grid).not.toHaveAttribute('data-fixed-columns');
  });

  it('fixedColumns is ignored with leadWidth: the collapse class stays and there is no data-fixed-columns', () => {
    const { container } = render(
      <StatRow
        fixedColumns
        leadWidth
        figures={[
          <StatFigure key="a" label="Overall" value="72%" lead />,
          <StatFigure key="b" label="Wins" value="18" />,
          <StatFigure key="c" label="Losses" value="7" />,
        ]}
      />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toMatch(/@max-\[860px\]\/page:grid-cols-2/);
    // Plan 39.1-38: leadWidth alone no longer spans the lead on a phone (sketches 001-C / 003-A).
    expect(grid.className).not.toMatch(/col-span-2/);
    expect(grid).not.toHaveAttribute('data-fixed-columns');
  });

  it('renders 5 columns for 5 figures, in the order given (lead first)', () => {
    const { container } = render(
      <StatRow
        leadWidth
        figures={[
          <StatFigure key="a" label="Overall" value="72%" lead />,
          <StatFigure key="b" label="Wins" value="18" />,
          <StatFigure key="c" label="Losses" value="7" />,
          <StatFigure key="d" label="Matches" value="25" />,
          <StatFigure key="e" label="Streak" value="3" />,
        ]}
      />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))]');
    const labels = Array.from(grid.querySelectorAll('span')).map((el) => el.textContent);
    expect(labels[0]).toBe('Overall');
    expect(screen.getByText('Overall')).toBeInTheDocument();
    expect(screen.getByText('Streak')).toBeInTheDocument();
  });

  it('never uses justify-evenly or justify-around (§13.3)', () => {
    const { container } = render(
      <StatRow
        figures={[
          <StatFigure key="a" label="Wins" value="1" />,
          <StatFigure key="b" label="Losses" value="2" />,
        ]}
      />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).not.toMatch(/justify-evenly|justify-around/);
    expect(grid.className).toContain('grid-cols-2');
  });
});

describe('StatFigure', () => {
  it('renders an em dash and the caption prop in the empty state — never a zero or a percent sign', () => {
    render(
      <StatFigure label="Recent" state="empty" value="0%" emptyCaption="Unlocks at 3 games" />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Unlocks at 3 games')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText('%', { exact: false })).not.toBeInTheDocument();
  });

  it('with onSelect renders a button with aria-pressed, and the pressed indicator carries no colour token', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <StatFigure label="Last 30" value="72%" onSelect={onSelect} pressed support="18–7 · 25" />,
    );
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await user.click(button);
    expect(onSelect).toHaveBeenCalledOnce();

    const label = screen.getByText('Last 30');
    expect(label.className).toContain('border-b-2');
    expect(label.className).toContain('border-foreground');
    expect(label.className).not.toMatch(/text-(win|loss|steady|primary|destructive)\b/);
    expect(label.className).not.toMatch(/bg-(win|loss|steady|primary|destructive)\b/);
  });

  it('renders a plain (non-button) figure with no onSelect', () => {
    render(<StatFigure label="Wins" value="18" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });
});

/**
 * Plan 39.1-38 (design-audit item 9 / P6; UI-SPEC §6.6, §7.3; sketches 001-C /
 * 003-A `.statrow`, 002-C `.statrow.kpi .lead`). Root cause (real Chrome,
 * recorded in 39.1-38-SUMMARY): the row was its OWN `@container`, and an
 * element never queries itself — its `@max-[860px]:grid-cols-2` resolved
 * against ancestors (none are containers) and never applied, while the
 * first-child span resolved against the row and did. The collapse now keys on
 * PageShell's NAMED `page` container. A StatRow outside any PageShell keeps
 * its N columns because a named container query (`@container page (...)`)
 * cannot match without an ancestor named `page` — the base N-column template
 * is the only rule that applies there.
 */
describe('StatRow — the page-container collapse contract (plan 39.1-38)', () => {
  const four = [
    <StatFigure key="a" label="Win rate" value="52%" lead />,
    <StatFigure key="b" label="Games" value="40" />,
    <StatFigure key="c" label="Record" value="21-19" />,
    <StatFigure key="d" label="90 days" value="48%" />,
  ];

  it('collapses to a PLAIN two-column grid on the named page container, with no first-child span', () => {
    const { container } = render(<StatRow leadWidth figures={four} />);
    const grid = container.firstElementChild as HTMLElement;
    const classes = grid.className.split(/\s+/);
    expect(classes).toContain('@max-[860px]/page:grid-cols-2');
    expect(grid.className).not.toMatch(/col-span-2/);
    expect(classes).not.toContain('@max-[860px]:grid-cols-2');
    expect(grid).not.toHaveAttribute('data-lead-span');
  });

  it('keeps its N-column base template for a StatRow outside any PageShell (the collapse is only a named-container variant)', () => {
    const { container } = render(<StatRow figures={four} />);
    const grid = container.firstElementChild as HTMLElement;
    const classes = grid.className.split(/\s+/);
    expect(classes).toContain('grid-cols-4');
    // Every two-column rule is a `/page` container variant, never a bare class.
    expect(classes.filter((c) => c.endsWith('grid-cols-2'))).toEqual([
      '@max-[860px]/page:grid-cols-2',
    ]);
  });

  it('fixedColumns still omits the collapse', () => {
    const { container } = render(
      <StatRow
        fixedColumns
        figures={[
          <StatFigure key="a" label="W" value="1" />,
          <StatFigure key="b" label="L" value="2" />,
          <StatFigure key="c" label="N" value="3" />,
        ]}
      />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).not.toMatch(/\/page:grid-cols-2/);
    expect(grid).toHaveAttribute('data-fixed-columns', '');
  });

  it('leadSpanOnPhone (sketch 002-C KPI row only) spans the lead across both columns under the collapse and renders data-lead-span', () => {
    const { container } = render(<StatRow leadWidth leadSpanOnPhone figures={four} />);
    const grid = container.firstElementChild as HTMLElement;
    const classes = grid.className.split(/\s+/);
    expect(classes).toContain('@max-[860px]/page:grid-cols-2');
    expect(classes).toContain('@max-[860px]/page:[&>*:first-child]:col-span-2');
    expect(grid).toHaveAttribute('data-lead-span', '');
  });
});

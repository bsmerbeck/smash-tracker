import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InsightCard } from './InsightCard';
import { UnlocksNext, type UnlocksNextMeters } from './UnlocksNext';
import { InsightRail, type InsightRailCard, type InsightRailShape } from './InsightRail';

const LABELS = {
  dismissedCount: (count: number) => `${count} dismissed on this device`,
  allDismissed: 'Every read on this rail is dismissed.',
  restore: 'Restore',
  railError: <p>Insights could not be computed for this view. Reload to try again.</p>,
};

function makeCard(id: string, name: string): InsightRailCard {
  return {
    id,
    render: ({ onDismiss }) => (
      <InsightCard
        chip={<span>chip</span>}
        name={name}
        verdict={`verdict for ${name}`}
        evidence="evidence"
        onDismiss={onDismiss}
        dismissLabel="Dismiss this read"
        doors={[
          <a key="1" href={`/games/${id}`}>
            See the games
          </a>,
        ]}
      />
    ),
  };
}

function makeThrowingCard(id: string): InsightRailCard {
  return {
    id,
    render: () => {
      throw new Error(`engine read failed for ${id}`);
    },
  };
}

function emptyRail(): InsightRailShape {
  return { cards: [], unlocksNext: null, lines: [], promotionQueue: [] };
}

describe('InsightRail', () => {
  it('given 4 card candidates renders exactly 3, and dismissing one promotes the 4th into its place', () => {
    const four = [makeCard('a', 'A'), makeCard('b', 'B'), makeCard('c', 'C'), makeCard('d', 'D')];
    const rail: InsightRailShape = {
      cards: four.slice(0, 3),
      unlocksNext: null,
      lines: [],
      promotionQueue: [four[3]!],
    };

    const { container, rerender } = render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(container.querySelectorAll('[data-slot="insight-rail-card"]')).toHaveLength(3);
    expect(screen.queryByText('verdict for D')).not.toBeInTheDocument();

    rerender(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={['a']}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(container.querySelectorAll('[data-slot="insight-rail-card"]')).toHaveLength(3);
    expect(screen.getByText('verdict for D')).toBeInTheDocument();
    expect(screen.queryByText('verdict for A')).not.toBeInTheDocument();
  });

  it('given 0 cards and a non-null unlock result, exactly 1 card renders and it is the unlock card', () => {
    const meters: UnlocksNextMeters = [
      { sentence: 'Play 5 more games with Terry.', have: 3, need: 8, countLabel: '3 of 8 games' },
    ];
    const unlocksNext: InsightRailCard = {
      id: 'unlocks',
      render: () => <UnlocksNext chip={<span>chip</span>} name="Unlocks next" meters={meters} />,
    };
    const rail: InsightRailShape = { cards: [], unlocksNext, lines: [], promotionQueue: [] };
    const { container } = render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(container.querySelectorAll('[data-slot="insight-rail-card"]')).toHaveLength(1);
    expect(screen.getByText('Play 5 more games with Terry.')).toBeInTheDocument();
  });

  it('given an entirely empty rail shape, exactly 1 card renders and it is the fallbackCard node', () => {
    const { container } = render(
      <InsightRail
        rail={emptyRail()}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fallback content</div>}
      />,
    );
    expect(container.querySelectorAll('[data-slot="insight-rail-card"]')).toHaveLength(1);
    expect(screen.getByText('fallback content')).toBeInTheDocument();
  });

  it('lines render below the cards and the rendered card count is unchanged by adding lines', () => {
    const cards = [makeCard('a', 'A'), makeCard('b', 'B'), makeCard('c', 'C')];
    const rail: InsightRailShape = {
      cards,
      unlocksNext: null,
      lines: [<p key="1">line one</p>, <p key="2">line two</p>],
      promotionQueue: [],
    };
    const { container } = render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(container.querySelectorAll('[data-slot="insight-rail-card"]')).toHaveLength(3);
    expect(screen.getByText('line one')).toBeInTheDocument();
    expect(screen.getByText('line two')).toBeInTheDocument();
  });

  it('with every card dismissed, exactly 1 card renders and it carries labels.allDismissed and a restore control', () => {
    const cards = [makeCard('a', 'A'), makeCard('b', 'B')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue: [] };
    const { container } = render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={['a', 'b']}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(container.querySelectorAll('[data-slot="insight-rail-card"]')).toHaveLength(1);
    expect(screen.getByText(LABELS.allDismissed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LABELS.restore })).toBeInTheDocument();
  });

  it('the rail foot shows the dismissed-count label and a restore control whenever a card is dismissed', () => {
    const cards = [makeCard('a', 'A'), makeCard('b', 'B'), makeCard('c', 'C')];
    const promotionQueue = [makeCard('d', 'D')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue };
    render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={['a']}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(screen.getByText('1 dismissed on this device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LABELS.restore })).toBeInTheDocument();
  });

  it('renders no dismissed-count foot when nothing is dismissed', () => {
    const cards = [makeCard('a', 'A')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue: [] };
    render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(screen.queryByRole('button', { name: LABELS.restore })).not.toBeInTheDocument();
  });

  it('the legend row is hidden from assistive technology', () => {
    const { container } = render(
      <InsightRail
        rail={emptyRail()}
        header="h"
        legend={<span>legend content</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    const legend = container.querySelector('[data-slot="insight-rail-legend"]')!;
    expect(legend.getAttribute('aria-hidden')).toBe('true');
    expect(legend.textContent).toBe('legend content');
  });

  it("calls onDismiss with the dismissed card's id when its dismiss button is clicked", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const cards = [makeCard('a', 'A')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue: [] };
    render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={onDismiss}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss this read' }));
    expect(onDismiss).toHaveBeenCalledWith('a');
  });

  it('calls onRestore when the restore control is clicked', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    const cards = [makeCard('a', 'A')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue: [] };
    render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={['a']}
        onDismiss={vi.fn()}
        onRestore={onRestore}
        fallbackCard={<div>fb</div>}
      />,
    );
    await user.click(screen.getByRole('button', { name: LABELS.restore }));
    expect(onRestore).toHaveBeenCalled();
  });

  it("tab order over a rail visits a visible card's doors then its dismiss, then the foot restore", () => {
    const cards = [makeCard('a', 'A'), makeCard('b', 'B')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue: [] };
    const { container } = render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={['a']}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    const focusable = Array.from(container.querySelectorAll('button, a[href]'));
    const names = focusable.map((el) => el.textContent || el.getAttribute('aria-label'));
    expect(names).toEqual(['See the games', 'Dismiss this read', LABELS.restore]);
  });

  it('never re-ranks — renders rail.cards in the exact order given', () => {
    const cards = [makeCard('a', 'A'), makeCard('b', 'B'), makeCard('c', 'C')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue: [] };
    const { container } = render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    const names = Array.from(container.querySelectorAll('[data-slot="insight-rail-card"]')).map(
      (el) => el.textContent,
    );
    expect(names?.[0]).toContain('verdict for A');
    expect(names?.[1]).toContain('verdict for B');
    expect(names?.[2]).toContain('verdict for C');
  });

  it('a rail with 4 candidates where the first throws renders 3 cards with the 4th promoted', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cards = [makeThrowingCard('a'), makeCard('b', 'B'), makeCard('c', 'C')];
    const promotionQueue = [makeCard('d', 'D')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue };
    const { container } = render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(container.querySelectorAll('[data-slot="insight-rail-card"]')).toHaveLength(3);
    expect(screen.getByText('verdict for D')).toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('a rail where every candidate throws renders exactly one node carrying labels.railError', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cards = [makeThrowingCard('a'), makeThrowingCard('b')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue: [] };
    const { container } = render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={vi.fn()}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(container.querySelectorAll('[data-slot="insight-rail-card"]')).toHaveLength(1);
    expect(
      screen.getByText('Insights could not be computed for this view. Reload to try again.'),
    ).toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('onDismiss is never called as a result of a crash', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onDismiss = vi.fn();
    const cards = [makeThrowingCard('a')];
    const rail: InsightRailShape = { cards, unlocksNext: null, lines: [], promotionQueue: [] };
    render(
      <InsightRail
        rail={rail}
        header="h"
        legend={<span>l</span>}
        labels={LABELS}
        dismissedIds={[]}
        onDismiss={onDismiss}
        onRestore={vi.fn()}
        fallbackCard={<div>fb</div>}
      />,
    );
    expect(onDismiss).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('neither InsightRail nor UnlocksNext reads a salience field anywhere in their own source', () => {
    const railSource = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/InsightRail.tsx'),
      'utf8',
    );
    const unlocksNextSource = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/UnlocksNext.tsx'),
      'utf8',
    );
    expect(railSource).not.toMatch(/salience/i);
    expect(unlocksNextSource).not.toMatch(/salience/i);
  });
});

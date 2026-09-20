import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InsightCard, type InsightCardDoors } from './InsightCard';

const REGION_SLOTS = [
  'insight-card-header',
  'insight-card-verdict',
  'insight-card-evidence',
  'insight-card-span',
  'insight-card-mark',
  'insight-card-sub',
  'insight-card-caveat',
  'insight-card-doors',
];

function renderedRegionSlots(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot]'))
    .map((el) => el.getAttribute('data-slot'))
    .filter((slot): slot is string => REGION_SLOTS.includes(slot ?? ''));
}

describe('InsightCard', () => {
  it('renders all eight regions in the declared DOM order on a full-props render', () => {
    const doors: InsightCardDoors = [
      <a key="1" href="/games">
        See the 30 games
      </a>,
      <a key="2" href="/matchup">
        Open matchup
      </a>,
    ];
    const { container } = render(
      <InsightCard
        chip={<span>chip</span>}
        name="CharacterMovers"
        verdict="vs Terry — win rate up 24 pts over the last 30 games."
        evidence="30–0 last 30 · 76% all time over 89 · high confidence"
        span="Those 30 games span Apr 2021 – Dec 2025."
        mark={<div>mark-content</div>}
        sub="No other notable change across the other 31 matchups."
        caveat="Bracket depth also rises late in a session."
        doors={doors}
      />,
    );

    expect(renderedRegionSlots(container)).toEqual(REGION_SLOTS);
  });

  it('a minimal render produces exactly three content regions and no empty placeholder for the omitted ones', () => {
    const { container } = render(
      <InsightCard
        chip={<span>chip</span>}
        name="FormNow"
        verdict="Win rate is holding steady."
        evidence="12–8 last 20 · 60% all time over 89"
      />,
    );

    expect(renderedRegionSlots(container)).toEqual([
      'insight-card-header',
      'insight-card-verdict',
      'insight-card-evidence',
    ]);
  });

  it('with three doors exactly one rendered button carries the filled primary variant and two carry outline', () => {
    const doors: InsightCardDoors = [
      <a key="1" href="/a">
        A
      </a>,
      <a key="2" href="/b">
        B
      </a>,
      <a key="3" href="/c">
        C
      </a>,
    ];
    const { container } = render(
      <InsightCard chip={<span>chip</span>} name="n" verdict="v" evidence="e" doors={doors} />,
    );

    expect(container.querySelectorAll('[data-slot="button"][data-variant="default"]')).toHaveLength(
      1,
    );
    expect(container.querySelectorAll('[data-slot="button"][data-variant="outline"]')).toHaveLength(
      2,
    );
  });

  it('a four-door prop is rejected by the type checker', () => {
    // @ts-expect-error — InsightCardDoors caps at three entries
    const doors: InsightCardDoors = [
      <a key="1">1</a>,
      <a key="2">2</a>,
      <a key="3">3</a>,
      <a key="4">4</a>,
    ];
    expect(doors).toBeTruthy();
  });

  it("the dismiss button's accessible name comes from the dismissLabel prop", () => {
    const onDismiss = vi.fn();
    render(
      <InsightCard
        chip={<span>chip</span>}
        name="n"
        verdict="v"
        evidence="e"
        onDismiss={onDismiss}
        dismissLabel="Dismiss this read"
      />,
    );
    expect(screen.getByRole('button', { name: 'Dismiss this read' })).toBeInTheDocument();
  });

  it('renders no dismiss button when onDismiss is not supplied', () => {
    render(<InsightCard chip={<span>chip</span>} name="n" verdict="v" evidence="e" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('places the dismiss control last in DOM/tab order, after the doors row (UI-SPEC §14.5 rule 5)', () => {
    const doors: InsightCardDoors = [
      <a key="1" href="/a">
        A
      </a>,
    ];
    render(
      <InsightCard
        chip={<span>chip</span>}
        name="n"
        verdict="v"
        evidence="e"
        doors={doors}
        onDismiss={vi.fn()}
        dismissLabel="Dismiss this read"
      />,
    );
    const focusable = Array.from(document.querySelectorAll('a[href], button'));
    const names = focusable.map((el) => el.textContent || el.getAttribute('aria-label'));
    expect(names).toEqual(['A', 'Dismiss this read']);
  });

  it('the verdict element carries no truncation utility and no line-clamp below three lines', () => {
    const { container } = render(
      <InsightCard chip={<span>chip</span>} name="n" verdict="v" evidence="e" />,
    );
    const verdict = container.querySelector('[data-slot="insight-card-verdict"]')!;
    expect(verdict.className).not.toMatch(/\btruncate\b/);
    expect(verdict.className).not.toMatch(/\bline-clamp-[12]\b/);
  });

  it("the component's prop type contains no salience, ranking, score, tracking or watchlist member", () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/InsightCard.tsx'),
      'utf8',
    );
    const propsBlock = source.slice(
      source.indexOf('export interface InsightCardProps'),
      source.indexOf('\n}', source.indexOf('export interface InsightCardProps')),
    );
    expect(propsBlock).not.toMatch(/salience|ranking|score|tracking|watchlist/i);
  });
});

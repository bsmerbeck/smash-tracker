import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import {
  buildTierSplitStats,
  type Insight,
  type Match,
  type TierSplitEntry,
  type TierSplitStats,
} from '@smash-tracker/shared';
import i18n from '@/i18n';
import { TierInsightCard } from './TierInsightCard';
import { buildTierGapInsight } from './tierGapInsight';

/**
 * TIER-03 / DD-11 / D-16 (UI-SPEC 7.5, 13 E5): the tier insight card renders the
 * REAL `tierGap` template output over the REAL `buildTierSplitStats` cohorts, so
 * a change in either shape fails here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1);
const NOW_MS = BASE + 400 * DAY_MS;

function entry(index: number, overrides: Partial<TierSplitEntry> = {}): TierSplitEntry {
  return {
    entryKey: `ti${index}`,
    eventName: `Tier Event ${index}`,
    tournamentName: `Tier Tournament ${index}`,
    firstSetAt: BASE + index * 30 * DAY_MS,
    lastSetAt: BASE + index * 30 * DAY_MS + DAY_MS / 2,
    isOnline: false,
    ...overrides,
  };
}

function gamesFor(target: TierSplitEntry, wins: number, losses: number): Match[] {
  return Array.from({ length: wins + losses }, (_, i) => ({
    id: `${target.entryKey}-g${i}`,
    time: target.firstSetAt + i * 1000,
    win: i < wins,
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'offline-tourney',
    eventName: target.eventName,
    tournamentName: target.tournamentName ?? undefined,
  })) as Match[];
}

const MANUAL = (tier: 'supermajor' | 'local') => ({
  tierOverride: { contractVersion: 1 as const, tier, setAtMs: 1 },
});

interface Built {
  stats: TierSplitStats;
  insight: Insight;
}

function build(input: {
  entries: TierSplitEntry[];
  matches: Match[];
  includeSideEvents?: boolean;
}): Built {
  const includeSideEvents = input.includeSideEvents ?? false;
  const stats = buildTierSplitStats({
    entries: input.entries,
    matches: input.matches,
    includeSideEvents,
  });
  const insight = buildTierGapInsight({
    stats,
    matches: input.matches,
    includeSideEvents,
    nowMs: NOW_MS,
  });
  if (insight == null) {
    throw new Error('the tier insight fixture produced no insight');
  }
  return { stats, insight };
}

/** Cohort A 26-7 (33 games, both events estimated), cohort B 4-8 (12 games): a notable gap. */
function trendFixture(): Built {
  const supermajor = entry(1, { numEntrants: 2048 });
  const local = entry(2, { numEntrants: 20 });
  return build({
    entries: [supermajor, local],
    matches: [...gamesFor(supermajor, 26, 7), ...gamesFor(local, 4, 8)],
  });
}

function renderCard(
  built: Built,
  {
    initialEntry = '/tournaments',
    onDismiss = () => undefined,
  }: { initialEntry?: string; onDismiss?: () => void } = {},
) {
  const router = createMemoryRouter(
    [
      {
        path: '/tournaments',
        element: (
          <TierInsightCard
            insight={built.insight}
            coverage={built.stats.coverage}
            onDismiss={onDismiss}
          />
        ),
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return render(<RouterProvider router={router} />);
}

describe('TierInsightCard', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
    vi.restoreAllMocks();
  });

  describe('E5 populated', () => {
    it('a notable gap is a Trend: the verdict, both records and the confidence cue of the smaller cohort', () => {
      const { container } = renderCard(trendFixture());
      expect(
        screen.getByText('Majors and above — 79% over 33 vs 33% at smaller events.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Trend')).toBeInTheDocument();
      const evidence = container.querySelector('[data-slot="insight-card-evidence"]')!.textContent;
      expect(evidence).toContain('26–7 at majors and above');
      expect(evidence).toContain('4–8 at smaller events');
      // The 12-game cohort is the thinner side, so its tier names the cue.
      expect(evidence).toContain('12 games');
      expect(container.querySelector('[data-slot="tier-insight-card"]')).not.toBeNull();
    });

    it('offers the counted-games door (primary, claim axis) and Show these events (outline)', () => {
      const { container } = renderCard(trendFixture());
      const doors = container.querySelector('[data-slot="insight-card-doors"]')!;
      const links = within(doors as HTMLElement).getAllByRole('link');
      expect(links.map((link) => link.textContent)).toEqual([
        'See the 45 games',
        'Show these events',
      ]);
      const games = new URL(links[0]!.getAttribute('href')!, 'http://x/tournaments');
      expect(games.searchParams.get('claim')).toBe('tierGap:tier:side-excluded:last30');
      expect(games.hash).toBe('#games');
      const events = new URL(links[1]!.getAttribute('href')!, 'http://x/tournaments');
      expect(events.searchParams.get('tier')).toBe('supermajor,major');
      expect(events.hash).toBe('');
      expect(events.searchParams.get('claim')).toBeNull();
    });

    it('both doors keep the setting and side filters, and never carry a stale drill axis', () => {
      const { container } = renderCard(trendFixture(), {
        initialEntry: '/tournaments?setting=offline&side=include&vs=4&stage=1&claim=other',
      });
      const links = within(
        container.querySelector('[data-slot="insight-card-doors"]') as HTMLElement,
      ).getAllByRole('link');
      const games = new URL(links[0]!.getAttribute('href')!, 'http://x/tournaments');
      expect(games.searchParams.get('setting')).toBe('offline');
      expect(games.searchParams.get('side')).toBe('include');
      expect(games.searchParams.get('vs')).toBeNull();
      expect(games.searchParams.get('stage')).toBeNull();
      expect(games.searchParams.get('claim')).toBe('tierGap:tier:side-excluded:last30');
      const events = new URL(links[1]!.getAttribute('href')!, 'http://x/tournaments');
      expect(events.searchParams.get('setting')).toBe('offline');
      expect(events.searchParams.get('side')).toBe('include');
      expect(events.searchParams.get('vs')).toBeNull();
    });

    it('a non-notable gap is a steady Fact with the steady sentence', () => {
      const supermajor = entry(1, { numEntrants: 2048 });
      const local = entry(2, { numEntrants: 20 });
      const built = build({
        entries: [supermajor, local],
        matches: [...gamesFor(supermajor, 17, 16), ...gamesFor(local, 6, 6)],
      });
      renderCard(built);
      expect(
        screen.getByText('Majors and above — 52% over 33; no notable gap vs smaller events (50%).'),
      ).toBeInTheDocument();
      expect(screen.getByText('Fact')).toBeInTheDocument();
      expect(screen.queryByText('Trend')).toBeNull();
    });

    it('always carries the coverage line', () => {
      const { container } = renderCard(trendFixture());
      expect(container.querySelector('[data-slot="tier-coverage"]')?.textContent).toBe(
        'Tier known for 2 of 2 events · 0 recorded · 2 estimated · 0 unknown',
      );
    });

    it('is dismissible through its own control', async () => {
      const onDismiss = vi.fn();
      renderCard(trendFixture(), { onDismiss });
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  describe('the estimated-tier sub line', () => {
    it('states how many events carry an estimated tier (plural)', () => {
      const { container } = renderCard(trendFixture());
      expect(container.querySelector('[data-slot="insight-card-sub"]')?.textContent).toBe(
        '2 of those events carry an estimated tier.',
      );
    });

    it('uses the singular form for one estimated event', () => {
      const supermajor = entry(1, { numEntrants: 2048 });
      const local = entry(2, { numEntrants: 20, ...MANUAL('local') });
      const built = build({
        entries: [supermajor, local],
        matches: [...gamesFor(supermajor, 26, 7), ...gamesFor(local, 4, 8)],
      });
      const { container } = renderCard(built);
      expect(container.querySelector('[data-slot="insight-card-sub"]')?.textContent).toBe(
        '1 of those events carries an estimated tier.',
      );
    });

    it('is omitted when no event carries an estimated tier', () => {
      const supermajor = entry(1, { numEntrants: 2048, ...MANUAL('supermajor') });
      const local = entry(2, { numEntrants: 20, ...MANUAL('local') });
      const built = build({
        entries: [supermajor, local],
        matches: [...gamesFor(supermajor, 26, 7), ...gamesFor(local, 4, 8)],
      });
      const { container } = renderCard(built);
      expect(container.querySelector('[data-slot="insight-card-sub"]')).toBeNull();
    });
  });

  describe('E5 empty and abstained (D-16): never blank, never a direction below the floor', () => {
    it('no known tier: the noTiers Fact, no door, no evidence claim', () => {
      const unknown = entry(1);
      const built = build({ entries: [unknown], matches: gamesFor(unknown, 4, 4) });
      const { container } = renderCard(built);
      expect(screen.getByText('Tier — no event has a known tier yet.')).toBeInTheDocument();
      expect(screen.getByText('Fact')).toBeInTheDocument();
      expect(within(container).queryAllByRole('link')).toHaveLength(0);
      expect(container.querySelector('[data-slot="insight-card-doors"]')).toBeNull();
      expect(container.querySelector('[data-slot="tier-coverage"]')).not.toBeNull();
    });

    it('cohort A under the floor: the abstained sentence with its count, as a meter, and no direction', () => {
      const supermajor = entry(1, { numEntrants: 2048 });
      const local = entry(2, { numEntrants: 20 });
      const built = build({
        entries: [supermajor, local],
        matches: [...gamesFor(supermajor, 3, 2), ...gamesFor(local, 4, 8)],
      });
      const { container } = renderCard(built);
      expect(screen.getByText('Not enough games at majors (5).')).toBeInTheDocument();
      expect(container.querySelector('[data-card-kind="unlocks-next"]')).not.toBeNull();
      expect(screen.getByRole('img', { name: '5 of 8 games' })).toBeInTheDocument();
      expect(screen.queryByText('Trend')).toBeNull();
      expect(container.querySelector('[data-slot="tier-coverage"]')).not.toBeNull();
    });

    it('cohort B under the floor: the smaller-events variant', () => {
      const supermajor = entry(1, { numEntrants: 2048 });
      const local = entry(2, { numEntrants: 20 });
      const built = build({
        entries: [supermajor, local],
        matches: [...gamesFor(supermajor, 26, 7), ...gamesFor(local, 1, 2)],
      });
      renderCard(built);
      expect(screen.getByText('Not enough games at smaller events (3).')).toBeInTheDocument();
    });
  });

  describe('E5 partial: side=include changes the cohort, the scope key and the claim together', () => {
    it('a hand-tiered side event joins cohort A only when included, and the claim id differs', () => {
      const supermajor = entry(1, { numEntrants: 2048 });
      const local = entry(2, { numEntrants: 20 });
      const side = entry(3, {
        eventName: 'Squad Strike',
        numEntrants: 300,
        ...MANUAL('supermajor'),
      });
      const matches = [
        ...gamesFor(supermajor, 26, 7),
        ...gamesFor(local, 4, 8),
        ...gamesFor(side, 6, 0),
      ];
      const excluded = build({ entries: [supermajor, local, side], matches });
      const included = build({
        entries: [supermajor, local, side],
        matches,
        includeSideEvents: true,
      });
      expect(excluded.insight.window.games).toBe(45);
      expect(included.insight.window.games).toBe(51);
      expect(excluded.insight.id).toBe('tierGap:tier:side-excluded:last30');
      expect(included.insight.id).toBe('tierGap:tier:side-included:last30');
      expect(excluded.insight.countedMatchIds).not.toEqual(included.insight.countedMatchIds);
      expect(included.stats.coverage.sideExcluded).toBe(0);
      expect(excluded.stats.coverage.sideExcluded).toBe(1);
    });

    it('unknown-tier games never enter either cohort', () => {
      const supermajor = entry(1, { numEntrants: 2048 });
      const local = entry(2, { numEntrants: 20 });
      const unknown = entry(3);
      const unknownGames = gamesFor(unknown, 40, 0);
      const built = build({
        entries: [supermajor, local, unknown],
        matches: [...gamesFor(supermajor, 26, 7), ...gamesFor(local, 4, 8), ...unknownGames],
      });
      const counted = new Set(built.insight.countedMatchIds);
      expect(unknownGames.some((game) => counted.has(game.id))).toBe(false);
      expect(built.insight.window.games).toBe(45);
    });
  });

  describe('E5 error', () => {
    it('a render failure removes the card and logs the template id only', () => {
      const broken = { ...trendFixture() } as Built;
      broken.insight = { ...broken.insight, copy: null as never };
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { container } = renderCard(broken);
      expect(container.querySelector('[data-slot="insight-card"]')).toBeNull();
      expect(container.querySelector('[data-slot="tier-insight-card"]')?.childElementCount).toBe(0);
      const logged = spy.mock.calls.map((call) => String(call[0]));
      expect(logged).toContain('InsightCard render failed for template "tierGap"');
    });
  });
});

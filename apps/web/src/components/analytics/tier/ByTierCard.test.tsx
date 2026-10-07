import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import {
  buildTierSplitStats,
  type Match,
  type TierSplitEntry,
  type TierSplitStats,
} from '@smash-tracker/shared';
import i18n from '@/i18n';
import { ByTierCard } from './ByTierCard';

/**
 * TIER-03 / T-05 / T-06 (UI-SPEC §7.4, §13 E4): the By-tier card renders the
 * REAL `buildTierSplitStats` output (never a hand-built stub), so a change in
 * the engine's shape, ordering or coverage arithmetic fails here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1);

function entry(index: number, overrides: Partial<TierSplitEntry> = {}): TierSplitEntry {
  return {
    entryKey: `e${index}`,
    eventName: `Event ${index}`,
    tournamentName: `Tournament ${index}`,
    firstSetAt: BASE + index * 30 * DAY_MS,
    lastSetAt: BASE + index * 30 * DAY_MS + DAY_MS / 2,
    isOnline: false,
    ...overrides,
  };
}

/** `wins`-`losses` games linked to `target` (matched by event name, tournament name and window). */
function gamesFor(target: TierSplitEntry, wins: number, losses: number, online = false): Match[] {
  return Array.from({ length: wins + losses }, (_, i) => ({
    id: `${target.entryKey}-g${i}`,
    time: target.firstSetAt + i * 1000,
    win: i < wins,
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: online ? 'online-tourney' : 'offline-tourney',
    eventName: target.eventName,
    tournamentName: target.tournamentName ?? undefined,
  })) as Match[];
}

const SUPERMAJOR = entry(1, { numEntrants: 2048 });
const MINOR = entry(2, { numEntrants: 300 });
const LOCAL = entry(3, { numEntrants: 20 });
const ONLINE_A = entry(4, { isOnline: true, numEntrants: 40 });
const ONLINE_B = entry(5, { isOnline: true, numEntrants: 44 });
const SIDE = entry(6, { eventName: 'Squad Strike', numEntrants: 300 });

function sparg0Stats(includeSideEvents = false): TierSplitStats {
  const entries = [SUPERMAJOR, MINOR, LOCAL, ONLINE_A, ONLINE_B, SIDE];
  const matches = [
    ...gamesFor(SUPERMAJOR, 26, 7),
    // Two games: below the abstention floor, so a record and no rate or bar.
    ...gamesFor(MINOR, 1, 1),
    ...gamesFor(LOCAL, 8, 2),
    ...gamesFor(ONLINE_A, 5, 5, true),
    ...gamesFor(SIDE, 2, 1),
  ];
  return buildTierSplitStats({ entries, matches, includeSideEvents });
}

function Location() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderCard(
  stats: TierSplitStats,
  {
    initialEntry = '/tournaments',
    sideEventCount = 1,
    overallRate = 0.62,
  }: { initialEntry?: string; sideEventCount?: number; overallRate?: number | null } = {},
) {
  const router = createMemoryRouter(
    [
      {
        path: '/tournaments',
        element: (
          <>
            <ByTierCard stats={stats} sideEventCount={sideEventCount} overallRate={overallRate} />
            <Location />
          </>
        ),
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

function rowFor(container: HTMLElement, tier: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-slot="by-tier-row"][data-tier="${tier}"]`);
}

describe('ByTierCard', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  describe('E4 populated', () => {
    it('renders one row per tier that has an event, in vocabulary order, and Unknown last in its own inset', () => {
      const { container } = renderCard(sparg0Stats());
      const rows = Array.from(container.querySelectorAll('[data-slot="by-tier-row"]'));
      expect(rows.map((row) => row.getAttribute('data-tier'))).toEqual([
        'supermajor',
        'minor',
        'local',
        'unknown',
      ]);
      // A tier with 0 events has no row at all (never a 0-0).
      expect(rowFor(container, 'major')).toBeNull();
      expect(rowFor(container, 'regional')).toBeNull();
      const inset = container.querySelector('[data-slot="by-tier-unknown"]');
      expect(inset).not.toBeNull();
      expect(inset?.querySelector('[data-tier="unknown"]')).not.toBeNull();
      expect(inset?.className).toContain('bg-muted/40');
    });

    it('shows the sparg0-shaped headline: Supermajor 26–7 with its rate and a bar', () => {
      const { container } = renderCard(sparg0Stats());
      const row = rowFor(container, 'supermajor')!;
      expect(within(row).getByText('Supermajor')).toBeInTheDocument();
      expect(row.textContent).toContain('26–7');
      expect(row.textContent).toContain('79%');
      expect(row.querySelector('[data-slot="by-tier-bar"]')).not.toBeNull();
      const fill = row.querySelector<HTMLElement>('[data-slot="by-tier-bar-fill"]')!;
      expect(fill.style.width).toBe(`${(26 / 33) * 100}%`);
      expect(row.querySelector('[data-slot="by-tier-bar"]')).toHaveAttribute('aria-hidden', 'true');
    });

    it('draws the overall rate as a reference tick, and none when there is no overall rate', () => {
      const withTick = renderCard(sparg0Stats(), { overallRate: 0.62 });
      const tick = withTick.container.querySelector<HTMLElement>(
        '[data-slot="by-tier-bar-reference"]',
      );
      expect(tick?.style.left).toBe('62%');
      withTick.unmount();
      const without = renderCard(sparg0Stats(), { overallRate: null });
      expect(without.container.querySelector('[data-slot="by-tier-bar-reference"]')).toBeNull();
    });

    it('holds the Unknown bucket apart: last row, the excluded text, no bar', () => {
      const { container } = renderCard(sparg0Stats());
      const rows = container.querySelectorAll('[data-slot="by-tier-row"]');
      const last = rows[rows.length - 1] as HTMLElement;
      expect(last.getAttribute('data-tier')).toBe('unknown');
      expect(within(last).getByText('excluded from the comparison')).toBeInTheDocument();
      expect(within(last).getByText('Tier unknown')).toBeInTheDocument();
      expect(last.querySelector('[data-slot="by-tier-bar"]')).toBeNull();
    });
  });

  describe('E4 partial: per-tier abstention', () => {
    it('a two-game tier states its record and how many more games it needs, and draws no bar', () => {
      const { container } = renderCard(sparg0Stats());
      const row = rowFor(container, 'minor')!;
      expect(within(row).getByText('Minor — 1 more game needed for a rate.')).toBeInTheDocument();
      expect(row.querySelector('[data-slot="by-tier-bar"]')).toBeNull();
      expect(row.querySelector('[data-slot="by-tier-bar-fill"]')).toBeNull();
      // Below the floor the record prints without a rate.
      expect(row.textContent).toContain('1–1');
      expect(row.textContent).not.toContain('%');
    });

    it('a tier with events but no linked games states the need and prints no fabricated 0–0', () => {
      const stats = buildTierSplitStats({
        entries: [entry(9, { numEntrants: 300 })],
        matches: [],
        includeSideEvents: false,
      });
      const { container } = renderCard(stats, { sideEventCount: 0 });
      const row = rowFor(container, 'minor')!;
      expect(within(row).getByText('Minor — 3 more games needed for a rate.')).toBeInTheDocument();
      expect(row.textContent).not.toContain('0–0');
      expect(row.querySelector('[data-slot="by-tier-bar"]')).toBeNull();
    });
  });

  describe('T-05 coverage line', () => {
    it('states the four tokens with zero values rendered ("0 recorded")', () => {
      const { container } = renderCard(sparg0Stats());
      const line = container.querySelector('[data-slot="tier-coverage"]');
      // Known 3 (supermajor, minor, local), unknown 2 online, side event left out.
      expect(line?.textContent).toBe(
        'Tier known for 3 of 5 events · 0 recorded · 3 estimated · 2 unknown',
      );
    });

    it('keeps known = recorded + estimated visible when a tier was set by hand', () => {
      const manual = entry(7, {
        numEntrants: 20,
        tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 1 },
      });
      const stats = buildTierSplitStats({
        entries: [manual],
        matches: gamesFor(manual, 3, 1),
        includeSideEvents: false,
      });
      const { container } = renderCard(stats, { sideEventCount: 0 });
      expect(container.querySelector('[data-slot="tier-coverage"]')?.textContent).toBe(
        'Tier known for 1 of 1 event · 0 recorded · 1 set manually · 0 estimated · 0 unknown',
      );
    });
  });

  describe('E4 empty: all-unknown', () => {
    it('renders the Unknown row, the coverage line and the all-unknown sentence, never an empty frame', () => {
      const online = [entry(1, { isOnline: true }), entry(2, { isOnline: true })];
      const stats = buildTierSplitStats({
        entries: online,
        matches: [...gamesFor(online[0]!, 4, 2, true)],
        includeSideEvents: false,
      });
      const { container } = renderCard(stats, { sideEventCount: 0 });
      expect(container.querySelectorAll('[data-slot="by-tier-row"]')).toHaveLength(1);
      expect(rowFor(container, 'unknown')).not.toBeNull();
      expect(
        screen.getByText("No event has a known tier yet — set one from an event's page."),
      ).toBeInTheDocument();
      expect(container.querySelector('[data-slot="tier-coverage"]')?.textContent).toBe(
        'Tier known for 0 of 2 events · 0 recorded · 0 estimated · 2 unknown',
      );
    });

    it('omits the Unknown inset when nothing is unknown', () => {
      const stats = buildTierSplitStats({
        entries: [SUPERMAJOR],
        matches: gamesFor(SUPERMAJOR, 5, 1),
        includeSideEvents: false,
      });
      const { container } = renderCard(stats, { sideEventCount: 0 });
      expect(container.querySelector('[data-slot="by-tier-unknown"]')).toBeNull();
      expect(container.querySelector('[data-slot="by-tier-all-unknown"]')).toBeNull();
    });
  });

  describe('E4 zero-one-many', () => {
    it('one known tier renders one bar row and no comparison claim of its own', () => {
      const stats = buildTierSplitStats({
        entries: [SUPERMAJOR],
        matches: gamesFor(SUPERMAJOR, 5, 1),
        includeSideEvents: false,
      });
      const { container } = renderCard(stats, { sideEventCount: 0 });
      expect(container.querySelectorAll('[data-slot="by-tier-row"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-slot="by-tier-bar"]')).toHaveLength(1);
    });

    it('states the side-event count in the header meta: excluded by default, singular and plural', () => {
      const one = renderCard(sparg0Stats(), { sideEventCount: 1 });
      expect(screen.getByText('1 side event excluded')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Include' })).toBeInTheDocument();
      one.unmount();
      renderCard(sparg0Stats(), { sideEventCount: 3 });
      expect(screen.getByText('3 side events excluded')).toBeInTheDocument();
    });

    it('says nothing about side events when the page shows none', () => {
      renderCard(sparg0Stats(), { sideEventCount: 0 });
      expect(screen.queryByText(/side event/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Include' })).not.toBeInTheDocument();
    });
  });

  describe('side events (T-06)', () => {
    it('with side=include the header switches to the included form, offers Exclude, and the side event joins Unknown', () => {
      const { container } = renderCard(sparg0Stats(true), {
        initialEntry: '/tournaments?side=include',
      });
      expect(screen.getByText('1 side event included')).toBeInTheDocument();
      expect(screen.queryByText(/excluded$/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Exclude' })).toBeInTheDocument();
      // The side event resolves Unknown, so it lands in the Unknown bucket and never a real tier.
      const unknown = rowFor(container, 'unknown')!;
      expect(unknown.textContent).toContain('7–6');
    });

    it('Include sets side=include and keeps the other params, replacing the URL (a filter, not a navigation)', async () => {
      const user = userEvent.setup();
      const { router } = renderCard(sparg0Stats(), {
        initialEntry: '/tournaments?setting=offline',
      });
      await user.click(screen.getByRole('button', { name: 'Include' }));
      expect(router.state.historyAction).toBe('REPLACE');
      const params = new URLSearchParams(
        screen.getByTestId('location').textContent!.split('?')[1] ?? '',
      );
      expect(params.get('side')).toBe('include');
      expect(params.get('setting')).toBe('offline');
    });

    it('Exclude drops the side param and keeps the rest, also replacing the URL', async () => {
      const user = userEvent.setup();
      const { router } = renderCard(sparg0Stats(true), {
        initialEntry: '/tournaments?side=include&tier=major',
      });
      await user.click(screen.getByRole('button', { name: 'Exclude' }));
      expect(router.state.historyAction).toBe('REPLACE');
      const params = new URLSearchParams(
        screen.getByTestId('location').textContent!.split('?')[1] ?? '',
      );
      expect(params.has('side')).toBe(false);
      expect(params.get('tier')).toBe('major');
    });
  });

  describe('DD-12 scoped doors', () => {
    it('a row links to ?tier=<word> and keeps an existing setting=offline param', () => {
      const { container } = renderCard(sparg0Stats(), {
        initialEntry: '/tournaments?setting=offline',
      });
      const link = rowFor(container, 'supermajor')!.querySelector('a')!;
      const href = link.getAttribute('href')!;
      const params = new URLSearchParams(href.split('?')[1]);
      expect(params.get('tier')).toBe('supermajor');
      expect(params.get('setting')).toBe('offline');
      expect(href).not.toContain('#');
    });

    it('a row target is a filter of this page: it carries no drill-down axis and never a list', () => {
      const { container } = renderCard(sparg0Stats());
      for (const link of Array.from(container.querySelectorAll('[data-slot="by-tier-row"] a'))) {
        const params = new URLSearchParams(link.getAttribute('href')!.split('?')[1]);
        for (const key of ['fighter', 'vs', 'stage', 'event', 'from', 'to', 'claim']) {
          expect(params.has(key), `${key} on a by-tier door`).toBe(false);
        }
      }
    });

    it('the Unknown row goes to ?tier=unknown', () => {
      const { container } = renderCard(sparg0Stats());
      const link = rowFor(container, 'unknown')!.querySelector('a')!;
      expect(new URLSearchParams(link.getAttribute('href')!.split('?')[1]).get('tier')).toBe(
        'unknown',
      );
    });

    it('a row press pushes the filter (a navigation), so Back returns to the unfiltered card', async () => {
      const user = userEvent.setup();
      const { container, router } = renderCard(sparg0Stats());
      await user.click(rowFor(container, 'minor')!.querySelector('a')!);
      expect(screen.getByTestId('location').textContent).toBe('/tournaments?tier=minor');
      expect(router.state.historyAction).toBe('PUSH');
    });

    it('Include leaves an unrelated drill axis in the URL untouched', async () => {
      const user = userEvent.setup();
      renderCard(sparg0Stats(), { initialEntry: '/tournaments?vs=2' });
      await user.click(screen.getByRole('button', { name: 'Include' }));
      expect(screen.getByTestId('location').textContent).toContain('vs=2');
    });
  });

  describe('accessibility', () => {
    it('every row has a whole accessible name that states tier, record, games and where it opens', () => {
      const { container } = renderCard(sparg0Stats());
      const link = rowFor(container, 'supermajor')!.querySelector('a')!;
      expect(link).toHaveAttribute(
        'aria-label',
        'Supermajor: 26–7, 79%, 33 games; opens the tournaments filtered to this tier',
      );
      // Below the floor the accessible record carries no rate either.
      expect(rowFor(container, 'minor')!.querySelector('a')).toHaveAttribute(
        'aria-label',
        'Minor: 1–1, 2 games; opens the tournaments filtered to this tier',
      );
    });

    it('uses a heading for the overline and plain text for the coverage line', () => {
      const { container } = renderCard(sparg0Stats());
      expect(screen.getByRole('heading', { name: 'By tier' })).toBeInTheDocument();
      expect(
        container.querySelector('[data-slot="tier-coverage"]')?.querySelector('a, button'),
      ).toBeNull();
    });
  });

  it('never reaches for device-local storage', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    const { container } = renderCard(sparg0Stats());
    await user.click(rowFor(container, 'minor')!.querySelector('a')!);
    // The data router keeps its own transition bookkeeping in sessionStorage; nothing else may.
    const ownKeys = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map(([key]) => String(key)).filter((key) => !key.startsWith('remix-router'));
    expect(ownKeys(getItem)).toEqual([]);
    expect(ownKeys(setItem)).toEqual([]);
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

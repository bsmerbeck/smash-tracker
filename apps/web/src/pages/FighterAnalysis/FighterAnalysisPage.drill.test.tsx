import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PeriodPoint } from '@smash-tracker/shared';
import type { TrendLineProps } from '@/components/charts/TrendLine';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FighterAnalysisPage } from './FighterAnalysisPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

/**
 * Plan 39.1-25 (gap closure, SC6/TRND-04): a SEPARATE file from
 * `FighterAnalysisPage.test.tsx` — this one mocks `@/components/charts/TrendLine`
 * (prop-capture, `StageDetailPage.test.tsx`'s pattern — Recharts has no
 * clickable geometry in jsdom without explicit width), which must not leak
 * into the existing page test file. Everything else — `buildInsightDoors`,
 * `resolveInsightClaim`, `FilteredMatchList`, `FormStrip` — is the REAL
 * implementation.
 */
let capturedTrendLineProps: TrendLineProps | undefined;
vi.mock('@/components/charts/TrendLine', async () => {
  const actual = await vi.importActual<typeof import('@/components/charts/TrendLine')>(
    '@/components/charts/TrendLine',
  );
  return {
    ...actual,
    TrendLine: (props: TrendLineProps) => {
      capturedTrendLineProps = props;
      return <div data-testid="trend-line-stub" />;
    },
  };
});

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    getRedirectResult: mock.getRedirectResult,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const getFighters = vi.fn();
const listMatches = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(
  overrides: Partial<Record<string, unknown>> & { id: string; time: number; win: boolean },
) {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

const SETS_COUNT = 10;
const GAMES_PER_SET = 7;

/**
 * 70 games across 10 REAL start.gg sets (`sgg:evset<i>:g<j>`), one uniquely
 * named event per set, one day apart — `buildPeriodSeries`'s ladder picks
 * the finest grain whose point count is <= 60 (`MARK_BOUND_LINE_POINTS`):
 * `game` grain would emit 70 points (> 60), so it re-grains to `set`,
 * emitting exactly 10 points (>= 8 periods) each with `total === 7` (>= 2).
 * Every set's games share one timestamp-ascending block, so set 9 (the
 * newest) is also the LAST `[data-slot="form-strip-set"]` element rendered.
 */
function drillFixture(): ReturnType<typeof makeMatch>[] {
  const now = Date.now();
  const matches: ReturnType<typeof makeMatch>[] = [];
  for (let setIdx = 0; setIdx < SETS_COUNT; setIdx++) {
    const setBaseMs = now - (SETS_COUNT - setIdx) * 24 * 60 * 60 * 1000;
    for (let gameIdx = 0; gameIdx < GAMES_PER_SET; gameIdx++) {
      matches.push(
        makeMatch({
          id: `s${setIdx}g${gameIdx}`,
          time: setBaseMs + gameIdx * 60 * 1000,
          win: gameIdx % 2 === 0,
          eventName: `Event ${setIdx}`,
          externalId: `sgg:evset${setIdx}:g${gameIdx + 1}`,
        }),
      );
    }
  }
  return matches;
}

/**
 * CR-02 (39.1-REVIEW): 25 tournaments one day apart; each has three 3-game
 * "Ultimate Singles" sets with one 3-game "Redemption" set interleaved
 * between Singles sets 1 and 2 (100 sets > 60, so the ladder picks
 * `eventSession`, 50 points). Every Singles point counts 9 games, but its
 * `[startMs, endMs]` window also holds that tournament's 3 Redemption games.
 */
function interleavedEventFixture(): ReturnType<typeof makeMatch>[] {
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const start = Date.now() - 30 * day;
  const matches: ReturnType<typeof makeMatch>[] = [];
  for (let t = 0; t < 25; t++) {
    const base = start + t * day;
    const sets = [
      { event: `T${t} Ultimate Singles`, offsetH: 0 },
      { event: `T${t} Redemption`, offsetH: 1 },
      { event: `T${t} Ultimate Singles`, offsetH: 2 },
      { event: `T${t} Ultimate Singles`, offsetH: 3 },
    ];
    sets.forEach(({ event, offsetH }, s) => {
      for (let g = 0; g < 3; g++) {
        matches.push(
          makeMatch({
            id: `t${t}s${s}g${g}`,
            time: base + offsetH * hour + g * 60 * 1000,
            win: (t + s + g) % 2 === 0,
            eventName: event,
            externalId: `sgg:t${t}set${s}:g${g + 1}`,
          }),
        );
      }
    });
  }
  return matches;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div
      data-testid="location-probe"
      data-pathname={location.pathname}
      data-search={location.search}
      data-hash={location.hash}
    />
  );
}

function renderFighterAnalysisAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route
                  path="/fighter-analysis"
                  element={
                    <>
                      <LocationProbe />
                      <FighterAnalysisPage />
                    </>
                  }
                />
                <Route
                  path="/coach/:clientId/fighter-analysis"
                  element={
                    <>
                      <LocationProbe />
                      <FighterAnalysisPage />
                    </>
                  }
                />
                <Route path="/choose-primary" element={<div>Choose primary page</div>} />
                <Route path="/choose-secondary" element={<div>Choose secondary page</div>} />
                <Route path="/dashboard" element={<div>Dashboard page</div>} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function locationProbe(): HTMLElement {
  return screen.getByTestId('location-probe');
}

/** The captured `PeriodPoint` with the largest `total` — proven non-trivial (>= 2). */
function largestPeriodPoint(): PeriodPoint {
  expect(capturedTrendLineProps).toBeDefined();
  expect(capturedTrendLineProps!.mode).toBe('period');
  const points = (capturedTrendLineProps as { points: PeriodPoint[] }).points;
  expect(points.length).toBeGreaterThanOrEqual(8);
  const largest = points.reduce((max, p) => (p.total > max.total ? p : max), points[0]!);
  expect(largest.total).toBeGreaterThanOrEqual(2);
  return largest;
}

describe('FighterAnalysisPage drill-down (39.1-25 gap closure, SC6/TRND-04)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    capturedTrendLineProps = undefined;
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue(drillFixture());
  });

  it("a period-point drill narrows the terminus to exactly the point's own games, writes event=<point.key> and the #games hash, and scrolls into view", async () => {
    const scrollIntoViewSpy = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;

    try {
      renderFighterAnalysisAt('/fighter-analysis');
      await screen.findByRole('heading', { name: mario.name, level: 2 });
      await waitFor(() => expect(capturedTrendLineProps).toBeDefined());

      const point = largestPeriodPoint();

      act(() => {
        (capturedTrendLineProps as { onSelectPoint?: (p: PeriodPoint) => void }).onSelectPoint?.(
          point,
        );
      });

      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      const table = within(gamesCard).getByRole('table');
      expect(Number(table.getAttribute('data-total-rows'))).toBe(point.total);

      const probe = locationProbe();
      const search = new URLSearchParams(probe.dataset.search ?? '');
      // CR-02 (39.1-REVIEW): a point drills by its own key, never a window.
      expect(search.get('event')).toBe(point.key);
      expect(search.has('from')).toBe(false);
      expect(search.has('to')).toBe(false);
      expect(probe.dataset.hash).toBe('#games');

      expect(scrollIntoViewSpy).toHaveBeenCalled();
      const lastIndex = scrollIntoViewSpy.mock.contexts.length - 1;
      expect(scrollIntoViewSpy.mock.contexts[lastIndex]).toBe(gamesCard);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('CR-02 (39.1-REVIEW): an eventSession point over interleaved events lands on exactly its own total, not every game inside its time window', async () => {
    const fixture = interleavedEventFixture();
    listMatches.mockResolvedValue(fixture);
    HTMLElement.prototype.scrollIntoView = vi.fn();

    renderFighterAnalysisAt('/fighter-analysis');
    await screen.findByRole('heading', { name: mario.name, level: 2 });
    await waitFor(() => expect(capturedTrendLineProps).toBeDefined());

    const points = (capturedTrendLineProps as { points: PeriodPoint[] }).points;
    expect(points).toHaveLength(50);
    expect(points[0]!.grain).toBe('eventSession');
    // Non-vacuous by construction: the chosen point's window holds MORE games
    // than it counts (the pre-fix from/to drill listed 12, not 9), and its
    // count differs from the page's unfiltered 300.
    const point = points.find(
      (p) => fixture.filter((m) => m.time >= p.startMs && m.time <= p.endMs).length > p.total,
    )!;
    expect(point).toBeDefined();
    expect(point.total).toBe(9);
    expect(point.total).not.toBe(fixture.length);

    act(() => {
      (capturedTrendLineProps as { onSelectPoint?: (p: PeriodPoint) => void }).onSelectPoint?.(
        point,
      );
    });

    await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
    const gamesCard = document.getElementById('games') as HTMLElement;
    await waitFor(() => {
      const table = within(gamesCard).getByRole('table');
      expect(Number(table.getAttribute('data-total-rows'))).toBe(point.total);
    });
  });

  it("clicking the newest form-strip set narrows the terminus to exactly that set's games and writes the event= axis", async () => {
    const user = userEvent.setup();
    renderFighterAnalysisAt('/fighter-analysis');
    await screen.findByRole('heading', { name: mario.name, level: 2 });

    const stripRoot = document.querySelector('[data-slot="fighter-hero-strip"]') as HTMLElement;
    const allSets = stripRoot.querySelectorAll('[data-slot="form-strip-set"]');
    expect(allSets.length).toBeGreaterThan(0);
    const newestSet = allSets[allSets.length - 1] as HTMLElement;
    const tickCount = newestSet.querySelectorAll('[data-slot="form-strip-tick"]').length;
    expect(tickCount).toBeGreaterThan(0);

    await user.click(newestSet);

    await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
    const gamesCard = document.getElementById('games') as HTMLElement;
    const table = within(gamesCard).getByRole('table');
    expect(Number(table.getAttribute('data-total-rows'))).toBe(tickCount);

    const probe = locationProbe();
    const search = new URLSearchParams(probe.dataset.search ?? '');
    expect(search.get('event')).toBe(`evset${SETS_COUNT - 1}`);
  });

  it('keyboard parity: focusing a set and pressing Enter drills identically to a click', async () => {
    const user = userEvent.setup();
    renderFighterAnalysisAt('/fighter-analysis');
    await screen.findByRole('heading', { name: mario.name, level: 2 });

    const stripRoot = document.querySelector('[data-slot="fighter-hero-strip"]') as HTMLElement;
    const allSets = stripRoot.querySelectorAll('[data-slot="form-strip-set"]');
    const newestSet = allSets[allSets.length - 1] as HTMLElement;
    const tickCount = newestSet.querySelectorAll('[data-slot="form-strip-tick"]').length;

    newestSet.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
    const gamesCard = document.getElementById('games') as HTMLElement;
    const table = within(gamesCard).getByRole('table');
    expect(Number(table.getAttribute('data-total-rows'))).toBe(tickCount);
  });

  it('a drill replaces a prior claim axis, never composes with it', async () => {
    renderFighterAnalysisAt(
      `/fighter-analysis?claim=${encodeURIComponent(`formNow:character:${mario.id}:last30`)}`,
    );
    await screen.findByRole('heading', { name: mario.name, level: 2 });
    await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
    expect(locationProbe().dataset.search ?? '').toContain('claim=');

    await waitFor(() => expect(capturedTrendLineProps).toBeDefined());
    const point = largestPeriodPoint();

    act(() => {
      (capturedTrendLineProps as { onSelectPoint?: (p: PeriodPoint) => void }).onSelectPoint?.(
        point,
      );
    });

    await waitFor(() => {
      const probe = locationProbe();
      const search = new URLSearchParams(probe.dataset.search ?? '');
      expect(search.has('claim')).toBe(false);
    });

    const gamesCard = document.getElementById('games') as HTMLElement;
    const table = within(gamesCard).getByRole('table');
    expect(Number(table.getAttribute('data-total-rows'))).toBe(point.total);
  });

  it("coach mount: a period-point drill keeps the /coach/:clientId prefix and narrows to exactly the point's games", async () => {
    renderFighterAnalysisAt('/coach/test-client/fighter-analysis');
    await screen.findByRole('heading', { name: mario.name, level: 2 });
    await waitFor(() => expect(capturedTrendLineProps).toBeDefined());

    const point = largestPeriodPoint();

    act(() => {
      (capturedTrendLineProps as { onSelectPoint?: (p: PeriodPoint) => void }).onSelectPoint?.(
        point,
      );
    });

    await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
    const gamesCard = document.getElementById('games') as HTMLElement;
    const table = within(gamesCard).getByRole('table');
    expect(Number(table.getAttribute('data-total-rows'))).toBe(point.total);

    const probe = locationProbe();
    expect(probe.dataset.pathname).toBe('/coach/test-client/fighter-analysis');
  });

  describe('WR-01 (39.1-REVIEW): the terminus can be reset, and a fighter/horizon change never leaves a stale axis', () => {
    it('Clear filters removes every drill axis and the #games hash, unmounting the terminus', async () => {
      const user = userEvent.setup();
      HTMLElement.prototype.scrollIntoView = vi.fn();
      renderFighterAnalysisAt(
        `/fighter-analysis?event=evset9&claim=${encodeURIComponent(`formNow:character:${mario.id}:last30`)}#games`,
      );
      await screen.findByRole('heading', { name: mario.name, level: 2 });
      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());

      await user.click(await screen.findByRole('button', { name: 'Clear filters' }));

      await waitFor(() => {
        const search = new URLSearchParams(locationProbe().dataset.search ?? '');
        expect(search.has('event')).toBe(false);
        expect(search.has('claim')).toBe(false);
      });
      expect(locationProbe().dataset.hash).toBe('');
      expect(document.getElementById('games')).not.toBeInTheDocument();
    });

    it('switching fighter after a set drill drops the event axis instead of narrowing the new fighter to an unrelated set', async () => {
      const user = userEvent.setup();
      HTMLElement.prototype.scrollIntoView = vi.fn();
      getFighters.mockResolvedValue({ primary: [mario.id, luigi.id], secondary: [] });
      listMatches.mockResolvedValue([
        ...drillFixture(),
        ...Array.from({ length: 3 }, (_, i) =>
          makeMatch({ id: `lg${i}`, fighter_id: luigi.id, time: Date.now() - i * 1000, win: true }),
        ),
      ]);
      renderFighterAnalysisAt('/fighter-analysis?event=evset9#games');
      await screen.findByRole('heading', { name: mario.name, level: 2 });
      await waitFor(() => {
        const table = within(document.getElementById('games') as HTMLElement).getByRole('table');
        expect(Number(table.getAttribute('data-total-rows'))).toBe(GAMES_PER_SET);
      });

      await user.click(screen.getByLabelText('Select fighter'));
      await user.click(await screen.findByRole('option', { name: new RegExp(luigi.name) }));

      await screen.findByRole('heading', { name: luigi.name, level: 2 });
      await waitFor(() => {
        const search = new URLSearchParams(locationProbe().dataset.search ?? '');
        expect(search.has('event')).toBe(false);
      });
    });

    it("pressing a different horizon figure after following the hero door re-points the claim to that horizon's own counted games", async () => {
      const user = userEvent.setup();
      HTMLElement.prototype.scrollIntoView = vi.fn();
      // 50 games over the last ~80 days (last30 counts the newest 30; last90
      // counts all 50) plus 10 games ~200 days old that NO horizon counts —
      // so a stale, unresolved claim's fallback (all 60) differs from the
      // re-pointed claim's exact 50.
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const recent = Array.from({ length: 50 }, (_, i) =>
        makeMatch({ id: `hz${i}`, time: now - (49 - i) * ((80 / 49) * day), win: i % 2 === 0 }),
      );
      const old = Array.from({ length: 10 }, (_, i) =>
        makeMatch({ id: `old${i}`, time: now - 200 * day - i * day, win: true }),
      );
      listMatches.mockResolvedValue([...recent, ...old]);

      renderFighterAnalysisAt('/fighter-analysis');
      await screen.findByRole('heading', { name: mario.name, level: 2 });
      await waitFor(() =>
        expect(document.querySelector('[data-slot="fighter-hero-doors"]')).not.toBeNull(),
      );
      const door = within(
        document.querySelector('[data-slot="fighter-hero-doors"]') as HTMLElement,
      ).getByRole('link');
      await user.click(door);
      await waitFor(() => {
        const table = within(document.getElementById('games') as HTMLElement).getByRole('table');
        expect(Number(table.getAttribute('data-total-rows'))).toBe(30);
      });

      const heroBody = document.querySelector('[data-slot="fighter-hero-body"]') as HTMLElement;
      await user.click(within(heroBody).getByText('90 days').closest('button')!);

      await waitFor(() => {
        const search = new URLSearchParams(locationProbe().dataset.search ?? '');
        expect(search.get('claim')).toBe(`formNow:character:${mario.id}:last90`);
      });
      await waitFor(() => {
        const table = within(document.getElementById('games') as HTMLElement).getByRole('table');
        expect(Number(table.getAttribute('data-total-rows'))).toBe(50);
      });
    });
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PeriodPoint } from '@smash-tracker/shared';
import type { TrendLineProps } from '@/components/charts/TrendLine';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MatchupsPage } from './MatchupsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

/**
 * CR-02 (39.1-REVIEW): the Matchups twin of
 * `FighterAnalysisPage.drill.test.tsx`. A SEPARATE file from
 * `MatchupsPage.test.tsx` because it mocks `@/components/charts/TrendLine`
 * (prop capture — Recharts has no clickable geometry in jsdom at the page's
 * size-prop-less call site, see `MatchupsPage.test.tsx`'s own note), which
 * must not leak into that file. Everything else — the page, `MatchupChart`'s
 * real `handleSelectPeriodPoint`, the page's URL writer, `FilteredMatchList`
 * — is the REAL implementation.
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
const getMe = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
      getMe: (...args: unknown[]) => getMe(...args),
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
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

/**
 * 25 tournaments one day apart; each has three 3-game "Ultimate Singles"
 * sets with one 3-game "Redemption" set interleaved between Singles sets 1
 * and 2 (100 sets > 60, so the ladder picks `eventSession`, 50 points).
 * Every Singles point counts 9 games, but its `[startMs, endMs]` window also
 * holds that tournament's 3 Redemption games.
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

function LocationSearchProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderMatchupsAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <LocationSearchProbe />
              <Routes>
                <Route path="/matchups" element={<MatchupsPage />} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MatchupsPage period-point drill (CR-02, 39.1-REVIEW)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    capturedTrendLineProps = undefined;
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
    });
    setMockUser(makeMockUser());
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('an eventSession point over interleaved events lands on exactly its own total, not every game inside its time window', async () => {
    const fixture = interleavedEventFixture();
    listMatches.mockResolvedValue(fixture);

    renderMatchupsAt(`/matchups?fighter=${mario.id}&vs=${luigi.id}`);

    await waitFor(() => expect(capturedTrendLineProps).toBeDefined());
    await waitFor(() =>
      expect((capturedTrendLineProps as { points: PeriodPoint[] }).points).toHaveLength(50),
    );
    const points = (capturedTrendLineProps as { points: PeriodPoint[] }).points;
    expect(points[0]!.grain).toBe('eventSession');
    // Non-vacuous by construction: the chosen point's window holds MORE games
    // than it counts, and its count differs from the pairing's unfiltered 300.
    const point = points.find(
      (p) => fixture.filter((m) => m.time >= p.startMs && m.time <= p.endMs).length > p.total,
    )!;
    expect(point).toBeDefined();
    expect(point.total).toBe(9);

    const gamesCard = document.getElementById('matchup-table') as HTMLElement;
    await waitFor(() => {
      const table = within(gamesCard).getByRole('table');
      expect(Number(table.getAttribute('data-total-rows'))).toBe(fixture.length);
    });

    act(() => {
      (capturedTrendLineProps as { onSelectPoint?: (p: PeriodPoint) => void }).onSelectPoint?.(
        point,
      );
    });

    await waitFor(() => {
      const table = within(gamesCard).getByRole('table');
      expect(Number(table.getAttribute('data-total-rows'))).toBe(point.total);
    });
    const search = new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
    expect(search.get('event')).toBe(point.key);
    expect(search.has('from')).toBe(false);
    expect(search.has('to')).toBe(false);
  });
});

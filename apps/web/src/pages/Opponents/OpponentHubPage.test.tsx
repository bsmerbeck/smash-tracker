import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useProfile } from '@/hooks/useProfile';
import { OpponentHubPage } from './OpponentHubPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import * as statsModule from '@/lib/stats';
import * as drillDownParamsModule from '@/lib/drillDownParams';

/**
 * WR-03 (38-REVIEW-FIX): a partial mock of `matchesDrillDown` (defaulting to
 * the real implementation, mirroring this file's own `@/lib/stats` mock just
 * above) — the ONE observable signal that `FilteredMatchList`'s D-16
 * memoization contract actually hit its cache. `matchesDrillDown` runs once
 * PER MATCH inside `FilteredMatchList`'s own `useMemo` body; if that memo
 * MISSES (an unstable `eventKeyForMatch` reference recreated every render),
 * it runs again on every unrelated re-render. If it HITS, the call count
 * never grows across a re-render that changes neither `matches` nor `axes`.
 */
vi.mock('@/lib/drillDownParams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/drillDownParams')>();
  return { ...actual, matchesDrillDown: vi.fn(actual.matchesDrillDown) };
});

/**
 * H-03 (cycle 2): `@/lib/stats` is the seam `apps/web` actually reaches the
 * engine through (`buildOpponentProfile` re-exported at `stats.ts:62-74`).
 * A partial mock wraps `buildOpponentProfile` in a `vi.fn` that DEFAULTS to
 * the real implementation for every test — only the "ENGINE OUTPUT" case
 * below overrides it, and restores the real implementation afterward so no
 * other test in this file is affected.
 */
vi.mock('@/lib/stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stats')>();
  return { ...actual, buildOpponentProfile: vi.fn(actual.buildOpponentProfile) };
});

/**
 * Phase 38-05 (D-01/D-02): models the harness on `OpponentsPage.test.tsx`,
 * since the hub consumes the same subject-scoped hooks the list page does —
 * including its profile-subscription stand-in.
 *
 * Countability-ROUTING is NOT re-proven here (H-03, cycle 2): that property
 * is proven once, mechanically, by `opponentCrossTab.test.ts`'s in-package
 * module-seam case (plan 38-01 Task 1). This suite proves the ROUTING to the
 * engine — that the hub's head-to-head figures are `@/lib/stats`'s
 * `buildOpponentProfile` OUTPUT, never a locally-computed denominator — via
 * a partial mock of that module.
 */

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

const listMatches = vi.fn();
const listTournaments = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getMe = vi.fn();
const listAliases = vi.fn();
const upsertAlias = vi.fn();
const removeAlias = vi.fn();
const listNotes = vi.fn();
const upsertNote = vi.fn();
const removeNote = vi.fn();

function defaultProfile(overrides: { isDemoAccount?: boolean } = {}) {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: null,
    ...overrides,
  };
}

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getMe: (...args: unknown[]) => getMe(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
    opponents: {
      aliases: {
        list: (...args: unknown[]) => listAliases(...args),
        upsert: (...args: unknown[]) => upsertAlias(...args),
        remove: (...args: unknown[]) => removeAlias(...args),
      },
      notes: {
        list: (...args: unknown[]) => listNotes(...args),
        upsert: (...args: unknown[]) => upsertNote(...args),
        remove: (...args: unknown[]) => removeNote(...args),
      },
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi

function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1000,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

/** Phase 30.3 (Gate 6 corrective): stands in for the app shell's own `GET /api/users/me` subscription. */
function ShellProfileSubscription() {
  useProfile();
  return null;
}

/**
 * CR-01 fix regression (38-REVIEW-FIX): renders the router's OWN current
 * `pathname` + `search`, mounted as a `<Routes>` sibling so it observes the
 * final location regardless of which route matched — the hub's player-hint
 * fallback used to `navigate()` an absolute personal path, which resolves
 * against the SAME `/opponents/:opponentTag` route mounted below under every
 * family, so the stub's own rendered content can't distinguish a correctly-
 * prefixed redirect from one that escaped the subject.
 */
function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location-probe">{`${pathname}${search}`}</div>;
}

function renderHub(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <ShellProfileSubscription />
              <LocationProbe />
              <Routes>
                <Route path="/opponents/:opponentTag" element={<OpponentHubPage />} />
                <Route
                  path="/coach/:clientId/opponents/:opponentTag"
                  element={<OpponentHubPage />}
                />
                <Route
                  path="/workspace/:tenantId/opponents/:opponentTag"
                  element={<OpponentHubPage />}
                />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

/**
 * Scopes into the `ScoutingHeader` card (the first `[data-slot="card"]` on
 * the page when a profile exists) — the head-to-head record renders inside
 * it, and the SAME record text can also appear elsewhere (the hidden
 * print-only evidence packet), so an unscoped `screen.getByText` is
 * ambiguous. Throws (surfacing a clear failure) if the card hasn't rendered.
 */
function headerCard(): HTMLElement {
  const title = document.querySelector('[data-slot="card-title"]');
  const card = title?.closest('[data-slot="card"]');
  if (!card) {
    throw new Error('ScoutingHeader card not found');
  }
  return card as HTMLElement;
}

async function findRecordText(record: string) {
  return waitFor(() => {
    const found = within(headerCard()).getByText(record);
    expect(found).toBeInTheDocument();
    return found;
  });
}

describe('OpponentHubPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue(defaultProfile());
    listTournaments.mockResolvedValue([]);
    listAliases.mockResolvedValue({});
    upsertAlias.mockResolvedValue({});
    removeAlias.mockResolvedValue(undefined);
    listNotes.mockResolvedValue({});
    upsertNote.mockResolvedValue({ updatedAt: 123 });
    removeNote.mockResolvedValue(undefined);
    setMockUser(makeMockUser());
  });

  it('renders the head-to-head record and terminus for a canonical tag', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
      makeMatch({ id: 'm2', time: 2, opponent: 'rival', win: true }),
      makeMatch({ id: 'm3', time: 3, opponent: 'rival', win: false }),
    ]);

    renderHub('/opponents/rival');

    await findRecordText('2-1');
    // The terminus renders the same three games.
    const list = document.getElementById('opponent-hub-list');
    expect(list).not.toBeNull();
    expect(within(list as HTMLElement).getAllByText('rival').length).toBeGreaterThan(0);
  });

  it('renders the SAME canonical hub and total for a registered ALIAS of that tag', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
      makeMatch({ id: 'm2', time: 2, opponent: 'rival', win: true }),
    ]);
    listAliases.mockResolvedValue({ 'old rival': 'rival' });

    renderHub('/opponents/old%20rival');

    await findRecordText('2-0');
  });

  it('renders the hub empty copy (and neither the matrix nor the trend section) for a tag with no recorded games', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true })]);

    renderHub('/opponents/nobody-known');

    expect(
      await screen.findByText('No games recorded against nobody-known yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Matchup Matrix')).not.toBeInTheDocument();
    expect(screen.queryByText('H2H Trend')).not.toBeInTheDocument();
  });

  it('resolves under the coach client-subject route', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true })]);

    renderHub('/coach/tetra-client/opponents/rival');

    await findRecordText('1-0');
  });

  it('resolves under the owned-workspace tenant route', async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true })]);

    renderHub('/workspace/tenant-1/opponents/rival');

    await findRecordText('1-0');
  });

  it('a tag containing non-ASCII characters round-trips through the path segment', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, opponent: 'プレイヤー', win: true }),
    ]);

    renderHub(`/opponents/${encodeURIComponent('プレイヤー')}`);

    await findRecordText('1-0');
  });

  describe('legacy player= hint fallback', () => {
    it('replace-navigates once to a different canonical tag named by the player= hint when the path tag has no games', async () => {
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: 1,
          opponent: 'zeta',
          win: true,
          opponentUserSlug: 'user/9fb774ae',
        }),
      ]);

      renderHub('/opponents/stale-name?player=sgg%3Auser%2F9fb774ae');

      await findRecordText('1-0');
      expect(within(headerCard()).getByText('zeta')).toBeInTheDocument();
    });

    it('renders the empty copy with no navigation when the hint resolves to nothing', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
      ]);

      renderHub('/opponents/stale-name?player=sgg%3Auser%2Funknown');

      expect(
        await screen.findByText('No games recorded against stale-name yet.'),
      ).toBeInTheDocument();
    });

    /**
     * CR-01 (38-REVIEW-FIX): the fallback used to `navigate()` an absolute
     * `/opponents/<tag>` path directly, escaping whatever subject prefix the
     * route matched under. Confirmed failing pre-fix: reverting the
     * `subjectPath(...)` wrap in `OpponentHubPage.tsx` makes the
     * location-probe assertion below observe `/opponents/zeta` instead of
     * `/coach/tetra-client/opponents/zeta`.
     */
    it('CR-01: keeps the coach subject prefix when the player= hint fallback redirects', async () => {
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: 1,
          opponent: 'zeta',
          win: true,
          opponentUserSlug: 'user/9fb774ae',
        }),
      ]);

      renderHub('/coach/tetra-client/opponents/stale-name?player=sgg%3Auser%2F9fb774ae');

      await findRecordText('1-0');
      expect(screen.getByTestId('location-probe')).toHaveTextContent(
        '/coach/tetra-client/opponents/zeta',
      );
    });

    it('CR-01: keeps the owned-workspace tenant prefix when the player= hint fallback redirects', async () => {
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          time: 1,
          opponent: 'zeta',
          win: true,
          opponentUserSlug: 'user/9fb774ae',
        }),
      ]);

      renderHub('/workspace/tenant-1/opponents/stale-name?player=sgg%3Auser%2F9fb774ae');

      await findRecordText('1-0');
      expect(screen.getByTestId('location-probe')).toHaveTextContent(
        '/workspace/tenant-1/opponents/zeta',
      );
    });
  });

  it('sorts the terminus list with sortMatchesNewestFirst — no local descending sort exists on this page', async () => {
    // Structural: proven by the `<automated>` grep gate over the source
    // file; this case only exercises the ordering BEHAVIOUR (newest first).
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
      makeMatch({ id: 'm2', time: 3, opponent: 'rival', win: false }),
      makeMatch({ id: 'm3', time: 2, opponent: 'rival', win: true }),
    ]);

    renderHub('/opponents/rival');

    await findRecordText('2-1');
    const list = document.getElementById('opponent-hub-list') as HTMLElement;
    const rows = await within(list).findAllByRole('row');
    // rows[0] is the header row; data rows follow newest-first (m2 t=3, m3 t=2, m1 t=1).
    expect(within(rows[1]!).getByText('Loss')).toBeInTheDocument();
  });

  it("the hub's head-to-head figures are ENGINE OUTPUT, not a locally-computed denominator", async () => {
    const mockedBuildOpponentProfile = vi.mocked(statsModule.buildOpponentProfile);
    const originalImplementation = mockedBuildOpponentProfile.getMockImplementation();
    mockedBuildOpponentProfile.mockReturnValue({
      opponent: 'rival',
      record: { wins: 41, losses: 2, total: 43, winRate: 95 },
      firstPlayedAt: 1,
      lastPlayedAt: 2,
      byTheirFighter: [],
      byStage: [],
      recent: [],
      source: 'manual',
    });

    try {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
      ]);

      renderHub('/opponents/rival');

      // A hub that counted locally would render the FIXTURE's real 1-0
      // record; this asserts the stub's deliberately distinctive numbers.
      await findRecordText('41-2');
    } finally {
      mockedBuildOpponentProfile.mockImplementation(originalImplementation!);
    }
  });

  it('has no subject-type branch — the same displayed record renders under every family with the same mocked data', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
      makeMatch({ id: 'm2', time: 2, opponent: 'rival', win: true }),
    ]);

    const { unmount } = renderHub('/opponents/rival');
    await findRecordText('2-0');
    unmount();

    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
      makeMatch({ id: 'm2', time: 2, opponent: 'rival', win: true }),
    ]);
    renderHub('/coach/some-client/opponents/rival');
    await findRecordText('2-0');
  });

  describe('un-pooling and merge affordances', () => {
    it('renders a "Merge into..." affordance on the header', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
        makeMatch({ id: 'm2', time: 2, opponent: 'zeta', win: true }),
      ]);
      const user = userEvent.setup();
      renderHub('/opponents/rival');

      await findRecordText('1-0');
      await user.click(screen.getByRole('button', { name: 'Merge into...' }));
      expect(await screen.findByText('Merge "rival" into...')).toBeInTheDocument();
    });
  });

  describe('WR-03 (38-REVIEW-FIX): D-16 memoization contract', () => {
    it('an unrelated re-render (opening the merge dialog) does not re-run the terminus narrowing predicate', async () => {
      const matchesDrillDownSpy = vi.mocked(drillDownParamsModule.matchesDrillDown);
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
        makeMatch({ id: 'm2', time: 2, opponent: 'rival', win: true }),
      ]);
      const user = userEvent.setup();
      renderHub('/opponents/rival');

      await findRecordText('2-0');
      const callsBefore = matchesDrillDownSpy.mock.calls.length;
      expect(callsBefore).toBeGreaterThan(0);

      // `mergeCandidate` state is wholly unrelated to the terminus's
      // `matches`/`axes`/`eventKeyForMatch` inputs — opening this dialog
      // re-renders the page (and, since neither is wrapped in
      // `React.memo`, `FilteredMatchList` too) without changing any of
      // them. A stable `axes` reference and a `useCallback`-wrapped
      // `eventKeyForMatch` mean `FilteredMatchList`'s own `useMemo` skips
      // recomputation entirely — `matchesDrillDown` is not called again.
      await user.click(screen.getByRole('button', { name: 'Merge into...' }));
      await screen.findByText('Merge "rival" into...');

      expect(matchesDrillDownSpy.mock.calls.length).toBe(callsBefore);
    });
  });

  describe('content sections (Task 2: matrix, trend, absorbed cards, terminus)', () => {
    const luigi2 = SpriteList.find((s) => s.id === 10)!;
    const fox = SpriteList.find((s) => s.id === 15)!;

    function twoCharacterFixture() {
      return [
        makeMatch({
          id: 'm1',
          time: 1,
          opponent: 'rival',
          win: true,
          fighter_id: mario.id,
          opponent_id: luigi2.id,
          map: { id: 1, name: 'Battlefield' },
        }),
        makeMatch({
          id: 'm2',
          time: 2,
          opponent: 'rival',
          win: true,
          fighter_id: mario.id,
          opponent_id: luigi2.id,
          map: { id: 1, name: 'Battlefield' },
        }),
        makeMatch({
          id: 'm3',
          time: 3,
          opponent: 'rival',
          win: false,
          fighter_id: mario.id,
          opponent_id: fox.id,
          map: { id: 3, name: 'Final Destination' },
        }),
      ];
    }

    it('renders the matrix, the event trend and the terminus in the documented region order', async () => {
      listMatches.mockResolvedValue(twoCharacterFixture());
      renderHub('/opponents/rival');

      await findRecordText('2-1');
      // ChartCard's title renders as `[data-slot="card-title"]`, not a
      // semantic heading element — queried directly rather than by role.
      const cardTitles = [...document.querySelectorAll('[data-slot="card-title"]')].map(
        (el) => el.textContent,
      );
      const matrixIdx = cardTitles.findIndex((h) => h === 'Matchup Matrix');
      const trendIdx = cardTitles.findIndex((h) => h === 'H2H Trend');
      expect(matrixIdx).toBeGreaterThan(-1);
      expect(trendIdx).toBeGreaterThan(matrixIdx);

      const list = document.getElementById('opponent-hub-list');
      expect(list).not.toBeNull();
      const trendNode = screen.getByText('H2H Trend');
      // The terminus DOM node comes after the trend section's node.
      expect(
        trendNode.compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('clicking a matrix cell narrows the terminus and shows the active-filter summary', async () => {
      listMatches.mockResolvedValue(twoCharacterFixture());
      const user = userEvent.setup();
      renderHub('/opponents/rival');

      await findRecordText('2-1');
      const cell = await screen.findByRole('button', {
        name: /Mario.*Luigi.*Battlefield.*2.*0/i,
      });
      await user.click(cell);

      const list = document.getElementById('opponent-hub-list') as HTMLElement;
      await waitFor(() => {
        expect(within(list).getByText(/2 games/)).toBeInTheDocument();
      });
    });

    it('renders the cohort composition and the mixed-context badge without hover, for a mixed-source fixture', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true, source: 'startgg' }),
        makeMatch({ id: 'm2', time: 2, opponent: 'rival', win: true, source: 'startgg' }),
        makeMatch({ id: 'm3', time: 3, opponent: 'rival', win: false, source: 'startgg' }),
        makeMatch({ id: 'm4', time: 4, opponent: 'rival', win: true }),
      ]);
      renderHub('/opponents/rival');

      await findRecordText('3-1');
      expect(await screen.findByText('Mixed context')).toBeInTheDocument();
    });

    it('renders the three filter selects with their documented labels', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
      ]);
      renderHub('/opponents/rival');

      await findRecordText('1-0');
      // "My character" also appears as a FilteredMatchList column header —
      // asserting length rather than a single unambiguous match.
      expect(screen.getAllByText('My character').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Their character').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Stage').length).toBeGreaterThan(0);
    });

    it('renders the absorbed scouting cards on the hub', async () => {
      listMatches.mockResolvedValue(twoCharacterFixture());
      renderHub('/opponents/rival');

      await findRecordText('2-1');
      expect(await screen.findByText('What They Play')).toBeInTheDocument();
      expect(screen.getByText('Recent Encounters')).toBeInTheDocument();
      expect(screen.getByText('Tournament History')).toBeInTheDocument();
      expect(screen.getByText('Tendencies')).toBeInTheDocument();
    });

    describe('Task 3 (39.1-18): the H2H trend verdict + strip, and the removed header pips', () => {
      it("the header's ten-pip indicator no longer renders", async () => {
        listMatches.mockResolvedValue(twoCharacterFixture());
        renderHub('/opponents/rival');

        await findRecordText('2-1');
        // `WinLossPips` labels its container via `shared.pips.recentResults`
        // ("Last {{count}} results, newest first") — asserted absent by
        // element query, not by absence of a specific string (which could
        // pass vacuously).
        expect(screen.queryByLabelText(/results, newest first/i)).not.toBeInTheDocument();
      });

      it('the trend card renders a claim chip, a verdict and an evidence line, plus a form strip above the plot', async () => {
        listMatches.mockResolvedValue(twoCharacterFixture());
        renderHub('/opponents/rival');

        await findRecordText('2-1');
        expect(document.querySelector('[data-slot="opponent-form-now"]')).toBeInTheDocument();
        expect(
          document.querySelector('[data-slot="opponent-form-now-verdict"]'),
        ).toBeInTheDocument();
        expect(
          document.querySelector('[data-slot="opponent-form-now-evidence"]'),
        ).toBeInTheDocument();
        expect(document.querySelector('[data-slot="form-strip-root"]')).toBeInTheDocument();
        const ticks = document.querySelectorAll('[data-slot="form-strip-tick"]');
        expect(ticks.length).toBeGreaterThan(0);
        expect(ticks.length).toBeLessThanOrEqual(20);
      });

      it("the hub's region structure (card count and order) is otherwise unchanged", async () => {
        listMatches.mockResolvedValue(twoCharacterFixture());
        renderHub('/opponents/rival');

        await findRecordText('2-1');
        const cardTitles = [...document.querySelectorAll('[data-slot="card"]')].map(
          (card) => card.querySelector('[data-slot="card-title"]')?.textContent ?? null,
        );
        // MEASURED against this plan's own Task 1+2 state (before this
        // plan's Task 3 edits) via a temporary probe test, recorded in the
        // SUMMARY: 8 cards in this exact order.
        expect(cardTitles).toEqual([
          'rival',
          'Matchup Matrix',
          'H2H Trend',
          'What They Play',
          'Stages',
          'Recent Encounters',
          'Tournament History',
          'Tendencies',
        ]);
      });
    });
  });

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern.
  describe('one loading pattern (UIX-07)', () => {
    it('shows the CardSkeleton pattern with the busy status role and the existing loading label while matches load', () => {
      listMatches.mockReturnValue(new Promise(() => {}));

      const { container } = renderHub('/opponents/rival');

      const status = container.querySelector('[role="status"][aria-busy="true"]');
      expect(status).not.toBeNull();
      expect(status).toHaveTextContent('Loading scouting reports...');
      expect(container.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
      expect(container.querySelector('div.text-muted-foreground')).toBeNull();
    });

    it('renders zero skeleton blocks once loaded', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
        makeMatch({ id: 'm2', time: 2, opponent: 'rival', win: true }),
        makeMatch({ id: 'm3', time: 3, opponent: 'rival', win: false }),
      ]);

      const { container } = renderHub('/opponents/rival');
      await findRecordText('2-1');

      expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(0);
      expect(container.querySelector('[data-slot="opponent-hub-body"]')).not.toBeNull();
    });

    it('on a background refetch, dims the hub body instead of flashing a skeleton', async () => {
      const threeGames = [
        makeMatch({ id: 'm1', time: 1, opponent: 'rival', win: true }),
        makeMatch({ id: 'm2', time: 2, opponent: 'rival', win: true }),
        makeMatch({ id: 'm3', time: 3, opponent: 'rival', win: false }),
      ];
      listMatches.mockResolvedValue(threeGames);

      const { container, queryClient } = renderHub('/opponents/rival');
      await findRecordText('2-1');

      let resolveSecondFetch: (value: unknown) => void = () => {};
      listMatches.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSecondFetch = resolve;
          }),
      );

      queryClient.invalidateQueries();

      await waitFor(() => {
        const body = container.querySelector('[data-slot="opponent-hub-body"]');
        expect(body?.className).toMatch(/opacity-60/);
      });
      expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(0);

      resolveSecondFetch(threeGames);
      await waitFor(() => {
        const body = container.querySelector('[data-slot="opponent-hub-body"]');
        expect(body?.className).not.toMatch(/opacity-60/);
      });
    });
  });
});

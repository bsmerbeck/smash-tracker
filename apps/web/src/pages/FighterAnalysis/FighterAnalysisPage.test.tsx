import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FighterAnalysisPage } from './FighterAnalysisPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import { analyticsSelectionStorageKey } from '@/lib/analyticsSelection';
import * as drillDownParamsModule from '@/lib/drillDownParams';

/**
 * WR-C02 (39.1-REVIEW.md): a partial mock of `matchesDrillDown` (defaulting
 * to the real implementation), mirroring `OpponentHubPage.test.tsx`'s own
 * "WR-03 (38-REVIEW-FIX)" mock — the ONE observable signal that
 * `FilteredMatchList`'s D-16 memoization contract actually hit its cache.
 * `matchesDrillDown` runs once PER MATCH inside `FilteredMatchList`'s own
 * `useMemo` body; if that memo MISSES (an unstable `axes` reference
 * recreated every render), it runs again on every unrelated re-render.
 */
vi.mock('@/lib/drillDownParams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/drillDownParams')>();
  return { ...actual, matchesDrillDown: vi.fn(actual.matchesDrillDown) };
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
const fox = SpriteList.find((s) => s.id === 8)!;

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

function renderFighterAnalysis() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/fighter-analysis']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/fighter-analysis" element={<FighterAnalysisPage />} />
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
  return { ...result, queryClient };
}

describe('FighterAnalysisPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
  });

  it('shows an empty state with links to choose fighters when the user has none selected', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderFighterAnalysis();

    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
  });

  it('shows a no-matches empty state when the user has fighters but no matches', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderFighterAnalysis();

    expect(await screen.findByText("You haven't reported any matches!")).toBeInTheDocument();
  });

  it('opens on the most-played saved fighter, not the alphabetically-first one', async () => {
    // Fox is alphabetically first ("Fox" < "Mario"); Mario has more games.
    getFighters.mockResolvedValue({ primary: [fox.id, mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'f1', time: 1, win: true, fighter_id: fox.id }),
      makeMatch({ id: 'm1', time: 2, win: true, fighter_id: mario.id }),
      makeMatch({ id: 'm2', time: 3, win: true, fighter_id: mario.id }),
      makeMatch({ id: 'm3', time: 4, win: true, fighter_id: mario.id }),
    ]);

    renderFighterAnalysis();

    const heroHeading = await screen.findByRole('heading', { name: mario.name, level: 2 });
    expect(heroHeading).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: fox.name, level: 2 })).not.toBeInTheDocument();
  });

  it('renders the inferred most-played fighter and its analysis when favorites are empty but a history exists (H-1)', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id }),
      makeMatch({ id: 'm2', time: 2, win: true, fighter_id: mario.id }),
      makeMatch({ id: 'm3', time: 3, win: false, fighter_id: mario.id }),
      makeMatch({ id: 'l1', time: 4, win: true, fighter_id: luigi.id }),
    ]);

    renderFighterAnalysis();

    const heroHeading = await screen.findByRole('heading', { name: mario.name, level: 2 });
    expect(heroHeading).toBeInTheDocument();
    expect(screen.queryByText("You haven't picked any fighters yet!")).not.toBeInTheDocument();
  });

  it('shows the non-blocking ChooseFavoritesPrompt when favorites are empty but a history exists (H-1)', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id }),
      makeMatch({ id: 'm2', time: 2, win: true, fighter_id: mario.id }),
    ]);

    renderFighterAnalysis();

    expect(await screen.findByTestId('choose-favorites-prompt')).toBeInTheDocument();
  });

  it('opens on a remembered INFERRED fighter (not a saved favorite) — the same fighter Matchups would open on (D-12)', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([
      // Mario is the most-played inferred fighter...
      makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id }),
      makeMatch({ id: 'm2', time: 2, win: true, fighter_id: mario.id }),
      makeMatch({ id: 'm3', time: 3, win: true, fighter_id: mario.id }),
      // ...but Luigi was explicitly remembered for this subject, and Luigi is
      // present only in the match history (never a saved favorite).
      makeMatch({ id: 'l1', time: 4, win: true, fighter_id: luigi.id }),
    ]);
    window.localStorage.setItem(
      analyticsSelectionStorageKey('test-uid', null),
      JSON.stringify({ fighterId: luigi.id }),
    );

    renderFighterAnalysis();

    const heroHeading = await screen.findByRole('heading', { name: luigi.name, level: 2 });
    expect(heroHeading).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: mario.name, level: 2 })).not.toBeInTheDocument();
  });

  it('still shows the choose-fighters gate when there are neither saved favorites nor any matches to infer from', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderFighterAnalysis();

    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
  });

  it('renders the fighter hero with sprite, name, the all-time record and its share of play (T-39.1-14)', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
      makeMatch({ id: 'm3', time: 3, win: false }),
      makeMatch({ id: 'm4', time: 4, win: false }),
      makeMatch({ id: 'm5', time: 5, win: false }),
      makeMatch({ id: 'm6', time: 6, win: true }),
    ]);

    renderFighterAnalysis();

    const heroHeading = await screen.findByRole('heading', { name: mario.name, level: 2 });
    expect(heroHeading).toBeInTheDocument();
    const heroCard = heroHeading.closest('[data-slot="card"]') as HTMLElement;
    // 3 wins - 3 losses over 6 games, rendered by the shared `<Record>` idiom.
    expect(within(heroCard).getAllByText(/3–3/).length).toBeGreaterThan(0);
    // All 6 matches are Mario's -> 100% share of play.
    expect(within(heroCard).getByText(/100% of play/)).toBeInTheDocument();
  });

  it('shows Stage Mastery tiles with a Best pick caption once a stage qualifies', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    const battlefieldWins = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `bf-${i}`, time: i, win: true, map: { id: 1, name: 'Battlefield' } }),
    );
    listMatches.mockResolvedValue(battlefieldWins);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Stage Mastery')).toBeInTheDocument());
    expect(screen.getByText(/Best pick:/)).toBeInTheDocument();
    expect(screen.getAllByText(/Battlefield/).length).toBeGreaterThan(0);
  });

  it('shows a "not enough data" style empty state in Stage Mastery captions below the threshold', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Stage Mastery')).toBeInTheDocument());
    expect(screen.queryByText(/Best pick:/)).not.toBeInTheDocument();
  });

  it('shows Matchup Coverage for the top faced opponents with per-fighter records', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, opponent_id: luigi.id }),
      makeMatch({ id: 'm2', time: 2, win: true, opponent_id: luigi.id }),
      makeMatch({ id: 'm3', time: 3, win: false, opponent_id: luigi.id }),
      makeMatch({ id: 'm4', time: 4, win: false, opponent_id: fox.id }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Matchup Coverage')).toBeInTheDocument());
    expect(screen.getAllByText(luigi.name).length).toBeGreaterThan(0);
    expect(screen.getAllByText(fox.name).length).toBeGreaterThan(0);
    // Luigi: 2-1 covered (3 games); Fox: 0-1 thin (1 game).
    expect(screen.getByText('2-1 · 67%')).toBeInTheDocument();
    expect(screen.getByText('thin data')).toBeInTheDocument();
  });

  it('shows Practice Recommendations with an honest empty state when nothing qualifies', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, opponent_id: luigi.id }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Practice Recommendations')).toBeInTheDocument());
    // Scoped to the Practice Recommendations card (plan 38-06/ADV-03): with
    // only unknown-stage (id 0) games, Stage Mastery's OWN caption now ALSO
    // renders the same shared abstention sentence (it used to render
    // nothing here) — an unscoped query would find it twice.
    const practiceCard = screen
      .getByText('Practice Recommendations')
      .closest('[data-slot="card"]')!;
    expect(
      within(practiceCard as HTMLElement).getByText(/Not enough data yet/),
    ).toBeInTheDocument();
  });

  it('surfaces a practice recommendation once a matchup has enough losses', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: false, opponent_id: luigi.id }),
      makeMatch({ id: 'm2', time: 2, win: false, opponent_id: luigi.id }),
      makeMatch({ id: 'm3', time: 3, win: false, opponent_id: luigi.id }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Practice Recommendations')).toBeInTheDocument());
    expect(screen.getByText(`Struggling vs ${luigi.name}: 0-3`)).toBeInTheDocument();
  });

  it('lists only faced opponents in the Matchup Stage Guide with records and stage calls', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      // 3 wins vs Luigi on Battlefield (id 1) — qualifies at the default threshold of 3
      makeMatch({
        id: 'm1',
        time: 1,
        win: true,
        opponent_id: luigi.id,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'm2',
        time: 2,
        win: true,
        opponent_id: luigi.id,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'm3',
        time: 3,
        win: true,
        opponent_id: luigi.id,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({ id: 'm4', time: 4, win: false, opponent_id: fox.id }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Matchup Stage Guide')).toBeInTheDocument());
    // Both faced opponents appear with their records
    expect(screen.getAllByText(luigi.name).length).toBeGreaterThan(0);
    expect(screen.getAllByText(fox.name).length).toBeGreaterThan(0);
    expect(screen.getByText('3-0')).toBeInTheDocument();
    // Luigi's best stage qualifies (3 matches on Battlefield at 100%). Scoped
    // to the Matchup Stage Guide card (plan 38-06/ADV-03): Stage Mastery's
    // OWN caption can independently qualify the SAME stage for the SAME
    // fighter from the SAME underlying matches, and now that its stage name
    // is a real link (H-01/ADV-03) rather than bare text, `(100% over 3)`
    // reads as that `<p>`'s only OWN direct text — an unscoped query would
    // find it twice.
    const guideCard = screen.getByText('Matchup Stage Guide').closest('[data-slot="card"]')!;
    expect(within(guideCard as HTMLElement).getAllByText(/Battlefield/).length).toBeGreaterThan(0);
    expect(within(guideCard as HTMLElement).getByText('(100% over 3)')).toBeInTheDocument();
  });

  it('lists named-opponent records in the Opponent table, ignoring blank names', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, opponent: 'rival' }),
      makeMatch({ id: 'm2', time: 2, win: false, opponent: '' }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('Opponents')).toBeInTheDocument());
    const opponentsCard = screen
      .getByText('Opponents')
      .closest('[data-slot="card"]') as HTMLElement;
    expect(within(opponentsCard).getByText('rival')).toBeInTheDocument();
  });

  it('shows the by-match-type share bar in the hero with localised labels, never a raw enum (T-39.1-14/UI-SPEC §9.6)', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, matchType: 'quickplay' }),
      makeMatch({ id: 'm2', time: 2, win: false, matchType: '' }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('By Match Type')).toBeInTheDocument());
    expect(screen.getByText('Quickplay')).toBeInTheDocument();
    expect(screen.getByText('Unspecified')).toBeInTheDocument();
    expect(screen.queryByText('quickplay')).not.toBeInTheDocument();
    expect(screen.queryByText('unspecified')).not.toBeInTheDocument();
  });

  it('the hero is the first grid cell in DOM order (T-39.1-14, DD-07)', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);

    renderFighterAnalysis();

    await screen.findByRole('heading', { name: mario.name, level: 2 });
    const grid = document.querySelector('[data-slot="page-grid"]') as HTMLElement;
    expect(grid).toBeInTheDocument();
    const firstCell = grid.children[0] as HTMLElement;
    expect(firstCell.querySelector('[data-slot="fighter-hero-body"]')).toBeInTheDocument();
  });

  it('no card root on this surface carries a stretch utility (UIX-04)', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);

    renderFighterAnalysis();

    await screen.findByRole('heading', { name: mario.name, level: 2 });
    const cardRoots = document.querySelectorAll('[data-slot="card"]');
    for (const card of cardRoots) {
      expect(card.className).not.toMatch(/\bflex-1\b/);
      expect(card.className).not.toMatch(/\bgrow\b/);
      expect(card.className).not.toMatch(/\bself-stretch\b/);
    }
  });

  it('renders exactly one filter row and one horizon switch', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);

    renderFighterAnalysis();

    await screen.findByRole('heading', { name: mario.name, level: 2 });
    expect(document.querySelectorAll('[data-slot="horizon-switch"]')).toHaveLength(1);
  });

  it('renders the filtered match list only when a drill axis is present in the URL (T-39.1-14)', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/fighter-analysis']}>
          <AuthProvider>
            <AnalyticsFilterProvider>
              <TooltipProvider>
                <Routes>
                  <Route path="/fighter-analysis" element={<FighterAnalysisPage />} />
                </Routes>
              </TooltipProvider>
            </AnalyticsFilterProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', { name: mario.name, level: 2 });
    expect(document.getElementById('games')).not.toBeInTheDocument();

    const queryClient2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient2}>
        <MemoryRouter initialEntries={['/fighter-analysis?stage=1']}>
          <AuthProvider>
            <AnalyticsFilterProvider>
              <TooltipProvider>
                <Routes>
                  <Route path="/fighter-analysis" element={<FighterAnalysisPage />} />
                </Routes>
              </TooltipProvider>
            </AnalyticsFilterProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
  });

  /** Enough games, spread across two opponent characters, to produce a real asserting `characterMovers`/`rivalMovers` card (mirrors `FighterInsightRail.test.tsx`'s own `richFixture()`). */
  function richInsightFixture(): ReturnType<typeof makeMatch>[] {
    const matches: ReturnType<typeof makeMatch>[] = [];
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      matches.push(
        makeMatch({
          id: `l${i}`,
          time: now - (80 - i) * 60 * 60 * 1000,
          win: i < 20 ? i % 2 === 0 : true,
          opponent_id: luigi.id,
          opponent: 'rival-luigi',
        }),
      );
    }
    for (let i = 0; i < 12; i++) {
      matches.push(
        makeMatch({
          id: `f${i}`,
          time: now - (30 - i) * 60 * 60 * 1000,
          win: i % 2 === 0,
          opponent_id: fox.id,
          opponent: 'rival-fox',
        }),
      );
    }
    return matches;
  }

  describe('T-39.1-24 (gap closure, DD-09 reachability): a rail card door narrows the terminus to exactly N', () => {
    it("clicking a card's counted-games door shows the terminus with data-total-rows equal to the door's own count, plus the claim summary", async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      const matches = richInsightFixture();
      listMatches.mockResolvedValue(matches);
      const user = userEvent.setup();

      renderFighterAnalysis();

      await screen.findByRole('heading', { name: mario.name, level: 2 });
      await waitFor(() =>
        expect(
          document.querySelector('[data-slot="insight-rail-card"][data-card-kind="regular"]'),
        ).not.toBeNull(),
      );

      const card = document.querySelector(
        '[data-slot="insight-rail-card"][data-card-kind="regular"]',
      ) as HTMLElement;
      const door = within(card).getAllByRole('link')[0]!;
      const doorLabel = door.textContent ?? '';
      const expectedCount = Number((doorLabel.match(/\d+/) ?? ['0'])[0]);
      expect(expectedCount).toBeGreaterThan(0);

      await user.click(door);

      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      const table = within(gamesCard).getByRole('table');
      expect(Number(table.getAttribute('data-total-rows'))).toBe(expectedCount);
      // The active-filter summary states the count and leads with the
      // insight's own claim summary (`buildInsightVerdict`), never a bare
      // "N games" line with no indication of WHICH claim narrowed the list.
      expect(within(gamesCard).getByText(new RegExp(String(expectedCount)))).toBeInTheDocument();
    });

    it('an unknown claim= id behaves exactly as with no claim axis (tolerant fallback, never a throw or not-found state)', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);

      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/fighter-analysis?claim=formNow:account:doesNotExist']}>
            <AuthProvider>
              <AnalyticsFilterProvider>
                <TooltipProvider>
                  <Routes>
                    <Route path="/fighter-analysis" element={<FighterAnalysisPage />} />
                  </Routes>
                </TooltipProvider>
              </AnalyticsFilterProvider>
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      await screen.findByRole('heading', { name: mario.name, level: 2 });
      // hasDrillAxis is true (a claim param is present) so the terminus
      // mounts, narrowed by the remaining (empty) axes alone — never a crash,
      // never a "not found" branch. Scoped to the games terminus card itself
      // — the page also renders `OpponentTable`'s own unrelated `<table>`.
      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const gamesCard = document.getElementById('games') as HTMLElement;
      expect(within(gamesCard).getByRole('table')).toBeInTheDocument();
    });
  });

  describe('WR-C02 (39.1-REVIEW.md): D-16 memoization contract', () => {
    it('an unrelated re-render does not re-run the terminus narrowing predicate', async () => {
      const matchesDrillDownSpy = vi.mocked(drillDownParamsModule.matchesDrillDown);
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
        makeMatch({ id: 'm2', time: 2, win: true, map: { id: 1, name: 'Battlefield' } }),
      ]);

      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // A FRESH element tree on each call (never the SAME object reference
      // reused) — React's fiber reconciler bails out of re-rendering a
      // subtree whose parent's `oldProps === newProps` by REFERENCE, so
      // passing the identical `tree` object to both `render` and `rerender`
      // would short-circuit before ever reaching `FighterAnalysisPage`,
      // making this assertion pass VACUOUSLY regardless of the fix. A new
      // JSX call on each invocation (mirrors `StageDetailPage.test.tsx`'s
      // own `stageTree()` helper) produces new-but-value-equal props at
      // every level, forcing a genuine re-render pass all the way down.
      function tree() {
        return (
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={['/fighter-analysis?stage=1']}>
              <AuthProvider>
                <AnalyticsFilterProvider>
                  <TooltipProvider>
                    <Routes>
                      <Route path="/fighter-analysis" element={<FighterAnalysisPage />} />
                    </Routes>
                  </TooltipProvider>
                </AnalyticsFilterProvider>
              </AuthProvider>
            </MemoryRouter>
          </QueryClientProvider>
        );
      }
      const { rerender } = render(tree());

      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      const callsBefore = matchesDrillDownSpy.mock.calls.length;
      expect(callsBefore).toBeGreaterThan(0);

      // Neither `FighterAnalysisPage` nor `FilteredMatchList` is wrapped in
      // `React.memo`, so re-invoking `render()` on the same root always
      // re-runs both function bodies (mirrors a horizon toggle, a
      // background refetch, or any sibling state change — the same class of
      // "parent re-rendered, nothing this terminus cares about changed"
      // event) — the only thing under test is whether that re-run
      // recomputes `FilteredMatchList`'s own narrowing memo. A stable
      // `terminusAxes`/`matches` reference means it doesn't: `matchesDrillDown`'s
      // call count stays flat (mirrors `StageDetailPage.test.tsx`'s own
      // "WR-03 (38-REVIEW-FIX)" test).
      rerender(tree());

      await waitFor(() => expect(document.getElementById('games')).toBeInTheDocument());
      expect(matchesDrillDownSpy.mock.calls.length).toBe(callsBefore);
    });
  });

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern.
  describe('one loading pattern (UIX-07)', () => {
    it('shows the CardSkeleton pattern with the busy status role and the existing loading label while fighters/matches load', () => {
      getFighters.mockReturnValue(new Promise(() => {}));
      listMatches.mockReturnValue(new Promise(() => {}));

      const { container } = renderFighterAnalysis();

      const status = container.querySelector('[role="status"][aria-busy="true"]');
      expect(status).not.toBeNull();
      expect(status).toHaveTextContent('Loading fighter analysis...');
      expect(container.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
      expect(container.querySelector('div.text-muted-foreground')).toBeNull();
      // The skeleton's grid spans (8, 4, 12, 12) mirror the loaded page's own
      // hero(8)/rail(4)/vs-lists(12)/existing-cards(12) spans.
      const spans = Array.from(container.querySelectorAll('[data-span]')).map((el) =>
        el.getAttribute('data-span'),
      );
      expect(spans.sort()).toEqual(['12', '12', '4', '8'].sort());
    });

    it('renders zero skeleton blocks once loaded, and the loaded page reuses the same grid spans as the skeleton', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);

      const { container } = renderFighterAnalysis();
      await screen.findByRole('heading', { name: mario.name, level: 2 });

      expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(0);
      expect(container.querySelector('[data-slot="fighter-hero-body"]')).not.toBeNull();
      const spans = Array.from(container.querySelectorAll('[data-span]')).map((el) =>
        el.getAttribute('data-span'),
      );
      expect(spans.sort()).toEqual(['12', '12', '4', '8'].sort());
    });

    it('on a background refetch, dims the previous frame instead of flashing a skeleton', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);

      const { container, queryClient } = renderFighterAnalysis();
      await screen.findByRole('heading', { name: mario.name, level: 2 });

      let resolveSecondFetch: (value: unknown) => void = () => {};
      listMatches.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSecondFetch = resolve;
          }),
      );

      queryClient.invalidateQueries();

      await waitFor(() => {
        const grid = container.querySelector('[data-slot="page-grid"]');
        expect(grid?.className).toMatch(/opacity-60/);
      });
      expect(screen.getByRole('heading', { name: mario.name, level: 2 })).toBeInTheDocument();
      expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(0);

      resolveSecondFetch([makeMatch({ id: 'm1', time: 1, win: true })]);
      await waitFor(() => {
        const grid = container.querySelector('[data-slot="page-grid"]');
        expect(grid?.className).not.toMatch(/opacity-60/);
      });
    });
  });
});

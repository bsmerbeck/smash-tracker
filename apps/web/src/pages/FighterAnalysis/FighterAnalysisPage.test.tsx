import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { FighterAnalysisPage } from './FighterAnalysisPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import { analyticsSelectionStorageKey } from '@/lib/analyticsSelection';

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
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/fighter-analysis']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/fighter-analysis" element={<FighterAnalysisPage />} />
              <Route path="/choose-primary" element={<div>Choose primary page</div>} />
              <Route path="/choose-secondary" element={<div>Choose secondary page</div>} />
              <Route path="/dashboard" element={<div>Dashboard page</div>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

  it('renders the fighter hero with sprite, name, record, share of games, and streak chip', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    // Chronological: W, W, L, L, L, W (current streak 1 win)
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
    expect(within(heroCard).getByTestId('hero-record')).toHaveTextContent('3-3');
    expect(within(heroCard).getByText('1W streak')).toBeInTheDocument();
    // All 6 matches are Mario's -> 100% share.
    expect(within(heroCard).getByText('100% of your games')).toBeInTheDocument();
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
    expect(screen.getByText('rival')).toBeInTheDocument();
  });

  it('shows the by-match-type table folded into the hero', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, matchType: 'quickplay' }),
      makeMatch({ id: 'm2', time: 2, win: false, matchType: '' }),
    ]);

    renderFighterAnalysis();

    await waitFor(() => expect(screen.getByText('By Match Type')).toBeInTheDocument());
    expect(screen.getByText('quickplay')).toBeInTheDocument();
    expect(screen.getByText('unspecified')).toBeInTheDocument();
    const pipsRegion = within(screen.getByLabelText('Last 2 results, newest first'));
    expect(pipsRegion).toBeTruthy();
  });
});

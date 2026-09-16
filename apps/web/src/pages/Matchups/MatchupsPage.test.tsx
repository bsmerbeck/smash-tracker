import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { MatchupsPage } from './MatchupsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

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

/** Phase 30.3 (Gate 6): the always-present `GET /api/users/me` profile shape. */
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
      getFighters: (...args: unknown[]) => getFighters(...args),
      getMe: (...args: unknown[]) => getMe(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi
const bowser = SpriteList.find((s) => s.id === 16)!; // Bowser — alphabetically before Mario
// Phase 35 removed the alphabetical-first fallback (DFLT-01/DFLT-03); this
// sprite is kept only as a NEGATIVE control — several cases below assert it
// is NOT what the usage-based default resolves to, matching
// useAlphaFighters' sort (src/hooks/useFighterName.ts) for the active
// locale ('en', where localized names equal SpriteList's canonical `.name`).
const alphabeticallyFirstSprite = [...SpriteList].sort((a, b) => a.name.localeCompare(b.name))[0]!;

function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function renderMatchups() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/matchups']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/matchups" element={<MatchupsPage />} />
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

describe('MatchupsPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue(defaultProfile());
    setMockUser(makeMockUser());
  });

  it('shows an empty state with links to choose fighters when the user has none selected', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderMatchups();

    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose Primary Fighters' })).toHaveAttribute(
      'href',
      '/choose-primary',
    );
  });

  it('shows a no-matches empty state when the user has fighters but no matches', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderMatchups();

    expect(await screen.findByText("You haven't reported any matches!")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  /**
   * Phase 30.3 (Gate 4, fighter-preference fallback): matches exist but no
   * saved favorites — the page runs on fighters inferred from the observed
   * match history, with "choose favorites" as a non-blocking prompt, never
   * the blocking gate.
   */
  it('renders matchup analytics from inferred fighters when preferences are empty but matches exist', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: true,
      }),
    ]);

    renderMatchups();

    // The real analytics render, defaulting to the inferred (only) fighter.
    await waitFor(() => expect(screen.getByText('Matchup Results')).toBeInTheDocument());
    const winsStat = screen.getByText('Wins').closest('div');
    expect(winsStat).not.toBeNull();
    expect(within(winsStat!).getByText('1')).toBeInTheDocument();
    // Non-blocking prompt, not the gate.
    expect(screen.getByTestId('choose-favorites-prompt')).toBeInTheDocument();
    expect(screen.queryByText("You haven't picked any fighters yet!")).not.toBeInTheDocument();
  });

  it('still gates on choose-fighters when there is neither a selection nor a match to infer from', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderMatchups();

    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
    expect(screen.queryByTestId('choose-favorites-prompt')).not.toBeInTheDocument();
  });

  it('filters matches to the selected fighter/opponent pairing by default', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        time: 2,
        win: true,
      }),
      // Different opponent fighter, played EARLIER — tied 1-1 on games so the
      // most-recent tiebreak (D-02/D-09) is what keeps this one out of the
      // default pairing, not roster order.
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, time: 1, win: false }),
    ]);

    renderMatchups();

    await waitFor(() => expect(screen.getByText('Matchup Results')).toBeInTheDocument());
    // Only the m1 match (vs the alphabetically-first opponent) should count.
    const winsStat = screen.getByText('Wins').closest('div');
    expect(winsStat).not.toBeNull();
    expect(within(winsStat!).getByText('1')).toBeInTheDocument();
  });

  it('updates the matchup when a different opponent is selected', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
    ]);

    renderMatchups();

    await waitFor(() =>
      expect(screen.getByLabelText('Select opponent fighter')).toBeInTheDocument(),
    );

    await user.click(screen.getByLabelText('Select opponent fighter'));
    await user.click(await screen.findByRole('option', { name: new RegExp(luigi.name) }));

    await waitFor(() => {
      const winsStat = screen.getByText('Wins').closest('div');
      expect(winsStat).not.toBeNull();
      // Two wins recorded against Luigi.
      expect(within(winsStat!).getByText('2')).toBeInTheDocument();
    });
  });

  it('shows matchup insights with streaks, form, and stage breakdown for the pairing', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        time: 1,
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: true,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'm2',
        time: 2,
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: true,
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'm3',
        time: 3,
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: false,
        map: { id: 1, name: 'Battlefield' },
      }),
    ]);

    renderMatchups();

    await waitFor(() => expect(screen.getByText('Matchup Insights')).toBeInTheDocument());
    // Current streak: 1 loss (most recent match lost)
    expect(screen.getByText('1 losses')).toBeInTheDocument();
    // Recent form pips for all three matches
    expect(screen.getByLabelText('Last 3 results, newest first')).toBeInTheDocument();
    // Battlefield qualifies at the default per-stage threshold (3 matches, 67%)
    expect(screen.getByText('Stage Breakdown')).toBeInTheDocument();
    expect(screen.getAllByText(/Battlefield/).length).toBeGreaterThan(0);
    // The pairing record (2-1) shows up in multiple places now (matrix cell,
    // insights, stage table) — assert on the win-loss card specifically.
    const winsStat = screen.getByText('Wins').closest('div');
    expect(winsStat).not.toBeNull();
    expect(within(winsStat!).getByText('2')).toBeInTheDocument();
  });

  it('shows a no-matches message for the matchup table when the pairing has no matches', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
    ]);

    renderMatchups();

    // The usage-based default opponent is Luigi (the only one Mario has
    // faced), which has a match — explicitly switch to a fighter Mario has
    // never faced to exercise the pairing's own empty state.
    await waitFor(() =>
      expect(screen.getByLabelText('Select opponent fighter')).toBeInTheDocument(),
    );
    await user.click(screen.getByLabelText('Select opponent fighter'));
    await user.click(
      await screen.findByRole('option', { name: new RegExp(alphabeticallyFirstSprite.name) }),
    );

    expect(await screen.findByText('No matches reported yet!')).toBeInTheDocument();
    expect(screen.getByText('No reported matches against this fighter')).toBeInTheDocument();
  });

  it('renders the matchup matrix heatmap above the pairing detail section', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: true,
      }),
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: false }),
    ]);

    renderMatchups();

    expect(await screen.findByText('Matchup Matrix')).toBeInTheDocument();
    // A cell exists for the Mario vs Luigi pairing recorded above.
    expect(
      screen.getByRole('button', { name: `${mario.name} vs ${luigi.name}: 0-1` }),
    ).toBeInTheDocument();
  });

  it('clicking a matrix cell updates the pairing selection shown in the detail header', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
    ]);

    renderMatchups();

    const cell = await screen.findByRole('button', {
      name: `${mario.name} vs ${luigi.name}: 2-0`,
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    await user.click(cell);

    await waitFor(() => {
      const winsStat = screen.getByText('Wins').closest('div');
      expect(winsStat).not.toBeNull();
      expect(within(winsStat!).getByText('2')).toBeInTheDocument();
    });
  });

  it('shows the Counterpick Advisor and per-opponent split cards in the pairing detail area', async () => {
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        win: true,
        opponent: 'alice',
      }),
    ]);

    renderMatchups();

    expect(await screen.findByText('Counterpick Advisor')).toBeInTheDocument();
    expect(screen.getByText('By Opponent')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  /**
   * Phase 35 (DFLT-01/DFLT-03 tracer): opens on the subject's most-used
   * fighter with that fighter's most-faced opponent preselected, with no
   * interaction. Bowser is saved alongside Mario and is alphabetically
   * first — an alphabetical fallback would land on Bowser, never Mario, so
   * this only passes for the usage-based default.
   */
  it("opens on the most-played fighter paired with that fighter's most-faced opponent, with no interaction", async () => {
    getFighters.mockResolvedValue({ primary: [bowser.id, mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, time: 1, win: true }),
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: luigi.id, time: 2, win: true }),
      makeMatch({
        id: 'm3',
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        time: 3,
        win: false,
      }),
      // Bowser has fewer games than Mario — must lose the fighter default.
      makeMatch({ id: 'm4', fighter_id: bowser.id, opponent_id: luigi.id, time: 4, win: true }),
    ]);

    renderMatchups();

    await waitFor(() => expect(screen.getByText('Matchup Results')).toBeInTheDocument());
    const fighterTrigger = screen.getByLabelText('Select your fighter');
    const opponentTrigger = screen.getByLabelText('Select opponent fighter');
    expect(within(fighterTrigger).getByText(mario.name)).toBeInTheDocument();
    expect(within(opponentTrigger).getByText(luigi.name)).toBeInTheDocument();

    // The Mario-vs-Luigi pairing (2 games, both wins) is the one actually rendered.
    const winsStat = screen.getByText('Wins').closest('div');
    expect(winsStat).not.toBeNull();
    expect(within(winsStat!).getByText('2')).toBeInTheDocument();
  });

  /**
   * Phase 35 (DFLT-02): an explicit opponent change is remembered across a
   * full unmount/remount (the browser-refresh equivalent) for the same
   * (uid, subject) pair — a computed default is not.
   */
  it('remembers an explicitly chosen opponent across an unmount and remount', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listMatches.mockResolvedValue([
      // Default opponent (most games, most-recent tiebreak) is Luigi.
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, time: 2, win: true }),
      makeMatch({
        id: 'm2',
        fighter_id: mario.id,
        opponent_id: alphabeticallyFirstSprite.id,
        time: 1,
        win: false,
      }),
    ]);

    const { unmount } = renderMatchups();

    await waitFor(() =>
      expect(screen.getByLabelText('Select opponent fighter')).toBeInTheDocument(),
    );
    await waitFor(() => {
      expect(
        within(screen.getByLabelText('Select opponent fighter')).getByText(luigi.name),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Select opponent fighter'));
    await user.click(
      await screen.findByRole('option', { name: new RegExp(alphabeticallyFirstSprite.name) }),
    );

    await waitFor(() => {
      expect(
        within(screen.getByLabelText('Select opponent fighter')).getByText(
          alphabeticallyFirstSprite.name,
        ),
      ).toBeInTheDocument();
    });

    unmount();
    renderMatchups();

    await waitFor(() => {
      expect(
        within(screen.getByLabelText('Select opponent fighter')).getByText(
          alphabeticallyFirstSprite.name,
        ),
      ).toBeInTheDocument();
    });
  });
});

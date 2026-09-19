import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { MatchupsPage } from './MatchupsPage';
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

/** Phase 38-04: reads the CURRENT router search string, so a test can assert on the URL a drill-down producer wrote without leaving the render tree. */
function LocationSearchProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderMatchups(initialEntry = '/matchups') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <LocationSearchProbe />
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
    // Recent form pips for all three matches — plan 37-03 promotes
    // MatchWinLossCard to a stat tile whose trend row reuses the SAME
    // WinLossPips component MatchupInsights' "Recent form" row already
    // renders (UI-SPEC: "no new sparkline mechanism invented"), so this
    // aria-label now legitimately appears twice on the page.
    expect(screen.getAllByLabelText('Last 3 results, newest first')).toHaveLength(2);
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

    // Phase 38-04: the results list is now the shared `FilteredMatchList`
    // terminus, whose own empty copy replaces the retired MatchupTable's
    // "No matches reported yet!" sentence.
    expect(await screen.findByText('No games match these filters.')).toBeInTheDocument();
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
    // Phase 38-04: "alice" now legitimately appears twice — once in the
    // per-opponent split card, once in the FilteredMatchList terminus's
    // Opponent column — so this asserts presence, not uniqueness.
    expect(screen.getAllByText('alice').length).toBeGreaterThan(0);
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

  /**
   * Phase 38-04: the URL drill-down contract (D-05/D-15/DRL-02, review
   * finding H-04). The bare route producing no search string is covered by
   * every OTHER test above (none of them ever assert on
   * `LocationSearchProbe` before an explicit interaction), so it is not
   * re-asserted here as a standalone case.
   */
  describe('Phase 38-04: URL drill-down contract', () => {
    it('renders the pairing header from the URL fighter axis when it differs from the persisted fighter', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id, bowser.id], secondary: [] });
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
        makeMatch({ id: 'm2', fighter_id: bowser.id, opponent_id: luigi.id, win: true }),
      ]);

      renderMatchups(`/matchups?fighter=${bowser.id}`);

      await waitFor(() =>
        expect(
          within(screen.getByLabelText('Select your fighter')).getByText(bowser.name),
        ).toBeInTheDocument(),
      );
      // The win-loss card also reflects Bowser's own 1-0 record, not Mario's.
      const winsStat = screen.getByText('Wins').closest('div');
      expect(winsStat).not.toBeNull();
      expect(within(winsStat!).getByText('1')).toBeInTheDocument();
    });

    it('falls back to the persisted fighter, and still renders the detail block, when the URL fighter axis names no known fighter', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      ]);

      renderMatchups('/matchups?fighter=999999999');

      await waitFor(() =>
        expect(
          within(screen.getByLabelText('Select your fighter')).getByText(mario.name),
        ).toBeInTheDocument(),
      );
      expect(screen.getByText('Matchup Results')).toBeInTheDocument();
    });

    it('an explicit picker change persists the selection AND writes the character axis to the router search string', async () => {
      const user = userEvent.setup();
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([
        // Luigi is MORE RECENT (time:2) than alphabeticallyFirstSprite
        // (time:1) with an equal 1-game count each, so Luigi — not the
        // fighter this test is about to click — is the computed DEFAULT
        // opponent. Reversing these times would make the click a no-op
        // (Radix's Select does not fire `onValueChange` for reselecting an
        // already-active value), silently defeating this test's own point.
        makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, time: 2, win: true }),
        makeMatch({
          id: 'm2',
          fighter_id: mario.id,
          opponent_id: alphabeticallyFirstSprite.id,
          time: 1,
          win: false,
        }),
      ]);

      renderMatchups();

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
        expect(screen.getByTestId('location-search').textContent).toContain(
          `vs=${alphabeticallyFirstSprite.id}`,
        );
      });
      // The shipped Phase 35 D-06 persisting behaviour is unchanged — an
      // unmount/remount still remembers the explicit choice (also covered
      // above by the dedicated persistence test).
      expect(
        JSON.parse(
          window.localStorage.getItem(analyticsSelectionStorageKey('test-uid', null)) ?? '{}',
        ).opponentId,
      ).toBe(alphabeticallyFirstSprite.id);
    });

    it('activating a counterpick row writes the stage axis to the router search string and narrows the results list to that stage', async () => {
      const user = userEvent.setup();
      HTMLElement.prototype.scrollIntoView = vi.fn();
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          fighter_id: mario.id,
          opponent_id: luigi.id,
          time: 1,
          win: true,
          map: { id: 1, name: 'Battlefield' },
        }),
        makeMatch({
          id: 'm2',
          fighter_id: mario.id,
          opponent_id: luigi.id,
          time: 2,
          win: true,
          map: { id: 1, name: 'Battlefield' },
        }),
        makeMatch({
          id: 'm3',
          fighter_id: mario.id,
          opponent_id: luigi.id,
          time: 3,
          win: true,
          map: { id: 1, name: 'Battlefield' },
        }),
        makeMatch({
          id: 'm4',
          fighter_id: mario.id,
          opponent_id: luigi.id,
          time: 4,
          win: false,
          map: { id: 83, name: 'Smashville' },
        }),
      ]);

      renderMatchups();

      await waitFor(() => expect(screen.getByText('Pick these')).toBeInTheDocument());
      const pickSection = screen.getByText('Pick these').closest('div')!;
      const row = within(pickSection).getAllByRole('button')[0]!;
      await user.click(row);

      await waitFor(() => {
        expect(screen.getByTestId('location-search').textContent).toContain('stage=1');
      });
      // The results list's own summary now names the narrowed count (3
      // Battlefield games), and the Smashville loss is no longer listed.
      await waitFor(() => {
        expect(screen.getByText('3 games · Mario vs Luigi · Battlefield')).toBeInTheDocument();
      });
    });

    // `MatchupChart.test.tsx`'s own drill-down suite proves the CLICK writes
    // `setDrillDown({ from, to })` via a mocked context (jsdom's 0x0
    // ResizeObserver stub means `MatchupChart` renders NO Recharts surface
    // at all when mounted at its real, size-prop-less production call site —
    // see that file's "renders no Recharts surface with no size props" case
    // — so a full-page click-through test here would assert nothing).  This
    // integration-level case instead proves the DOWNSTREAM half: a URL
    // ALREADY carrying an inclusive degenerate window (what that click
    // would have written) narrows the results list to every game at that
    // exact instant, never just one.
    it('a URL carrying an inclusive degenerate window keeps two games recorded at the identical timestamp both in the narrowed list', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      const sharedInstant = 5000;
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          fighter_id: mario.id,
          opponent_id: luigi.id,
          time: sharedInstant,
          win: true,
        }),
        makeMatch({
          id: 'm2',
          fighter_id: mario.id,
          opponent_id: luigi.id,
          time: sharedInstant,
          win: false,
        }),
        makeMatch({ id: 'm3', fighter_id: mario.id, opponent_id: luigi.id, time: 1000, win: true }),
      ]);

      renderMatchups(`/matchups?from=${sharedInstant}&to=${sharedInstant}`);

      const expectedDate = new Date(sharedInstant).toLocaleDateString();
      await waitFor(() => {
        expect(screen.getByText(`2 games · Mario vs Luigi · ${expectedDate}`)).toBeInTheDocument();
      });
    });

    it('renders no browser-storage write whose key is the persisted-selection or analytics-filter key on a URL-seeded arrival', async () => {
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      ]);

      const selectionKey = analyticsSelectionStorageKey('test-uid', null);
      const beforeValue = window.localStorage.getItem(selectionKey);

      const localStorageSpy = vi.spyOn(window.localStorage, 'setItem');
      const sessionStorageSpy = vi.spyOn(window.sessionStorage, 'setItem');

      // This harness renders MatchupsPage directly and never mounts
      // MainLayout, so `useAutoWidenEmptyRange`'s shipped once-per-session
      // write (Phase 35 D-02) is OUTSIDE this oracle's scope — stated here
      // rather than left for a reader to discover as a mysterious red.
      renderMatchups(`/matchups?fighter=${mario.id}&vs=${luigi.id}`);

      await waitFor(() =>
        expect(
          within(screen.getByLabelText('Select your fighter')).getByText(mario.name),
        ).toBeInTheDocument(),
      );

      const writtenKeys = [...localStorageSpy.mock.calls, ...sessionStorageSpy.mock.calls].map(
        (call) => call[0],
      );
      expect(writtenKeys).not.toContain(selectionKey);
      expect(
        writtenKeys.some((key) => typeof key === 'string' && key.includes('AnalyticsFilter')),
      ).toBe(false);
      expect(window.localStorage.getItem(selectionKey)).toBe(beforeValue);

      localStorageSpy.mockRestore();
      sessionStorageSpy.mockRestore();
    });

    it('the delete confirm dialog still opens from the results list with the existing confirm-title string', async () => {
      const user = userEvent.setup();
      getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, win: true }),
      ]);

      renderMatchups();

      await waitFor(() => expect(screen.getByText('Matchup Results')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: 'Delete match' }));
      expect(await screen.findByText('Delete this match?')).toBeInTheDocument();
    });
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { StageDetailPage } from './StageDetailPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import * as drillDownParamsModule from '@/lib/drillDownParams';

/**
 * WR-03 (38-REVIEW-FIX): a partial mock of `matchesDrillDown` — see
 * `OpponentHubPage.test.tsx`'s identical mock for the full rationale. Used
 * as the observable signal that `FilteredMatchList`'s D-16 memo actually
 * hits its cache across an unrelated re-render.
 */
vi.mock('@/lib/drillDownParams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/drillDownParams')>();
  return { ...actual, matchesDrillDown: vi.fn(actual.matchesDrillDown) };
});
import type { TrendLineProps } from '@/components/charts/TrendLine';

/**
 * WR-02 (38-REVIEW-FIX): captures the `onSelectPoint`/`points` props this
 * page hands its `<TrendLine>` without depending on Recharts' own zero-size
 * jsdom click-to-index geometry (`MatchupChart.test.tsx`'s approach, not
 * reusable here — this page's `<TrendLine>` gets no explicit width/height,
 * matching `OpponentHubPage.tsx`'s own real usage, so no SVG surface would
 * render at all under jsdom's no-op ResizeObserver stub). Real chart-click
 * behaviour is TrendLine's own contract, covered by `TrendLine.test.tsx`;
 * this only proves the PAGE wires a working handler.
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

/**
 * Plan 38-06 Task 1 (DRL-01): one case per behaviour bullet, on
 * `OpponentHubPage.test.tsx`'s harness shape (plan 38-05's output).
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
const fox = SpriteList.find((s) => s.id === 15)!; // Fox

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

/**
 * Shared between the initial mount and (WR-03's test) a subsequent
 * `rerender()` call using the SAME `queryClient` — `MemoryRouter` only
 * consumes `initialEntries` on its own first mount (an uncontrolled/
 * `defaultValue`-style prop), so re-invoking this with a fresh element but
 * the same client/component types re-renders in place rather than
 * remounting or resetting navigation/query state.
 */
function stageTree(initialEntry: string, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/stages/:stageId" element={<StageDetailPage />} />
              <Route path="/coach/:clientId/stages/:stageId" element={<StageDetailPage />} />
              <Route path="/workspace/:tenantId/stages/:stageId" element={<StageDetailPage />} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderStageAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(stageTree(initialEntry, queryClient));
  return { ...result, queryClient };
}

describe('StageDetailPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    capturedTrendLineProps = undefined;
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
    });
    listTournaments.mockResolvedValue([]);
    listAliases.mockResolvedValue({});
    listNotes.mockResolvedValue({});
    setMockUser(makeMockUser());
  });

  it('renders all five regions for a stage id with recorded games', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
      makeMatch({ id: 'm3', time: 3, win: false, opponent: 'second' }),
    ]);
    renderStageAt('/stages/1');

    await waitFor(() => expect(screen.getByText('Battlefield')).toBeInTheDocument());
    expect(screen.getByText('By Opponent')).toBeInTheDocument();
    expect(screen.getByText('By Character')).toBeInTheDocument();
    expect(screen.getByText('Over Time')).toBeInTheDocument();
    expect(screen.getByText('Games')).toBeInTheDocument();
    expect(screen.getAllByText('rival').length).toBeGreaterThan(0);
    expect(screen.getAllByText('second').length).toBeGreaterThan(0);
  });

  it('renders the neutral empty state for a non-numeric stage id, without throwing', async () => {
    listMatches.mockResolvedValue([makeMatch()]);
    renderStageAt('/stages/not-a-number');

    await waitFor(() =>
      expect(screen.getByText('No games recorded on this stage yet.')).toBeInTheDocument(),
    );
  });

  it('renders the neutral empty state for a stage id matching no known stage, without throwing', async () => {
    listMatches.mockResolvedValue([makeMatch()]);
    renderStageAt('/stages/999999');

    await waitFor(() =>
      expect(screen.getByText('No games recorded on this stage yet.')).toBeInTheDocument(),
    );
  });

  it('renders the neutral empty state for a fractional stage id, without throwing', async () => {
    listMatches.mockResolvedValue([makeMatch()]);
    renderStageAt('/stages/1.5');

    await waitFor(() =>
      expect(screen.getByText('No games recorded on this stage yet.')).toBeInTheDocument(),
    );
  });

  it('renders the unknown stage id’s games and makes no best-or-worst claim', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, map: { id: 0, name: 'no selection' } }),
      makeMatch({ id: 'm2', time: 2, win: true, map: { id: 0, name: 'no selection' } }),
      makeMatch({ id: 'm3', time: 3, win: false, map: { id: 0, name: 'no selection' } }),
    ]);
    renderStageAt('/stages/0');

    await waitFor(() => expect(screen.getByText('By Opponent')).toBeInTheDocument());
    expect(screen.queryByText(/Best pick/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ban-worthy/i)).not.toBeInTheDocument();
  });

  it('scopes to an event axis: adds the event subtitle and narrows the games list', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, eventName: 'Genesis 9' }),
      makeMatch({ id: 'm2', time: 2, win: true, eventName: 'Genesis 9' }),
      makeMatch({
        id: 'm3',
        time: 20 * 24 * 60 * 60 * 1000,
        win: false,
        opponent: 'other',
        eventName: '',
      }),
    ]);
    const { unmount } = renderStageAt('/stages/1');
    await waitFor(() => expect(screen.getAllByText('rival').length).toBeGreaterThan(0));
    expect(screen.getAllByText('other').length).toBeGreaterThan(0);
    unmount();

    const eventKey = `tournament:genesis 9:1`;
    renderStageAt(`/stages/1?event=${encodeURIComponent(eventKey)}`);

    await waitFor(() => expect(screen.getByText('at Genesis 9')).toBeInTheDocument());
    expect(screen.queryByText('other')).not.toBeInTheDocument();
  });

  it("a by-opponent row's destination is the opponent hub carrying the stage axis, coach-prefixed under a coach entry", async () => {
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);
    renderStageAt('/coach/test-client/stages/1');

    await waitFor(() => expect(screen.getByRole('link', { name: 'rival' })).toBeInTheDocument());
    const link = screen.getByRole('link', { name: 'rival' });
    expect(link).toHaveAttribute('href', '/coach/test-client/opponents/rival?stage=1');
  });

  it("a by-character row's destination is the Matchups page carrying both character axes and the stage axis", async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id, opponent_id: fox.id }),
    ]);
    renderStageAt('/stages/1');

    await waitFor(() => expect(screen.getByText('By Character')).toBeInTheDocument());
    const byCharacterCard = screen.getByText('By Character').closest('[data-slot="card"]')!;
    const links = within(byCharacterCard as HTMLElement).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const href = link.getAttribute('href')!;
      expect(href).toContain('/matchups?');
      expect(href).toContain(`fighter=${mario.id}`);
      expect(href).toContain(`vs=${fox.id}`);
      expect(href).toContain('stage=1');
    }
  });

  // --- Task 3: partial and zero-one-many cases ---

  it('renders the unnamed-opponent bucket row, and it is not an anchor', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, opponent: '' }),
      makeMatch({ id: 'm2', time: 2, win: true, opponent: '' }),
      makeMatch({ id: 'm3', time: 3, win: false, opponent: '' }),
    ]);
    renderStageAt('/stages/1');

    await waitFor(() =>
      expect(screen.getByText(/games with no opponent name recorded/)).toBeInTheDocument(),
    );
    const unnamedRow = screen.getByText(/games with no opponent name recorded/).closest('tr')!;
    expect(within(unnamedRow).queryByRole('link')).not.toBeInTheDocument();
  });

  it('excludes unknown-character games from the by-character denominators while still listing them in the games list', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
      makeMatch({ id: 'm2', time: 2, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
      makeMatch({ id: 'm3', time: 3, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
      makeMatch({
        id: 'm4',
        time: 4,
        win: false,
        fighter_id: 999999,
        opponent_id: 999998,
        opponent: 'weirdo',
      }),
    ]);
    renderStageAt('/stages/1');

    await waitFor(() => expect(screen.getByText('By Character')).toBeInTheDocument());
    expect(screen.getByText(/Unknown \(1 game, excluded\)/)).toBeInTheDocument();
    // Still visible in the games list, per D-13/the by-character exclusion
    // being scoped to that ONE region's own denominators.
    expect(screen.getAllByText('weirdo').length).toBeGreaterThan(0);
  });

  it('renders the games-needed copy for a below-floor fixture while the games list still shows every game', async () => {
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false }),
    ]);
    renderStageAt('/stages/1');

    await waitFor(() => expect(screen.getByText(/Not enough data yet/)).toBeInTheDocument());
    expect(screen.getAllByText('rival').length).toBeGreaterThan(0);
  });

  it('renders one row in each table for a one-game fixture, with no special-cased minimum layout', async () => {
    // One game is itself below `ABSTENTION_FLOOR_GAMES` — the Over Time
    // region legitimately renders the SAME shared games-needed sentence as
    // the below-floor case above (a one-point cumulative rate is exactly as
    // unsupported a claim as a zero-point one); "every region renders" is
    // satisfied by that sentence being this region's actual output for this
    // fixture, not by forcing a single dot onto an unsupported claim.
    listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);
    renderStageAt('/stages/1');

    await waitFor(() => expect(screen.getByText('By Opponent')).toBeInTheDocument());
    const byOpponentCard = screen.getByText('By Opponent').closest('[data-slot="card"]')!;
    expect(within(byOpponentCard as HTMLElement).getAllByRole('row')).toHaveLength(2);

    const byCharacterCard = screen.getByText('By Character').closest('[data-slot="card"]')!;
    expect(within(byCharacterCard as HTMLElement).getAllByRole('row')).toHaveLength(2);

    expect(screen.getByText(/Not enough data yet/)).toBeInTheDocument();
  });

  it('the by-opponent table has no nested scroller and caps at 8 rows with a show-all control past that', async () => {
    listMatches.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) =>
        makeMatch({ id: `m${i}`, time: i + 1, win: true, opponent: `opponent${i}` }),
      ),
    );
    renderStageAt('/stages/1');

    await waitFor(() => expect(screen.getByText('By Opponent')).toBeInTheDocument());
    const byOpponentCard = screen
      .getByText('By Opponent')
      .closest('[data-slot="card"]') as HTMLElement;
    expect(byOpponentCard.querySelector('.overflow-y-auto')).not.toBeInTheDocument();
    expect(byOpponentCard.querySelector('[class*="max-h-["]')).not.toBeInTheDocument();
    // 9 opponent rows + 1 header row = 10; capped to 8 data rows + 1 header = 9.
    expect(within(byOpponentCard).getAllByRole('row')).toHaveLength(9);

    const showAll = within(byOpponentCard).getByRole('button', { name: /show all 9/i });
    await userEvent.setup().click(showAll);
    expect(within(byOpponentCard).getAllByRole('row')).toHaveLength(10);
    expect(within(byOpponentCard).getByRole('button', { name: /show fewer/i })).toBeInTheDocument();
  });

  it('the per-fighter split (by-character table) has no nested scroller and caps at 5 rows, sorted by games', async () => {
    const fighters = [luigi, fox, mario].map((f) => f.id);
    const extraFighters = SpriteList.filter((s) => !fighters.includes(s.id))
      .slice(0, 4)
      .map((s) => s.id);
    const allOpponentFighters = [...fighters, ...extraFighters];
    listMatches.mockResolvedValue(
      allOpponentFighters.map((opponentFighterId, i) =>
        makeMatch({ id: `c${i}`, time: i + 1, win: true, opponent_id: opponentFighterId }),
      ),
    );
    renderStageAt('/stages/1');

    await waitFor(() => expect(screen.getByText('By Character')).toBeInTheDocument());
    const byCharacterCard = screen
      .getByText('By Character')
      .closest('[data-slot="card"]') as HTMLElement;
    expect(byCharacterCard.querySelector('.overflow-y-auto')).not.toBeInTheDocument();
    expect(byCharacterCard.querySelector('[class*="max-h-["]')).not.toBeInTheDocument();
    // 7 distinct fighter-pair rows + 1 header row; capped to 5 data rows + 1 header = 6.
    expect(within(byCharacterCard).getAllByRole('row')).toHaveLength(6);

    const showAll = within(byCharacterCard).getByRole('button', { name: /show all 7/i });
    await userEvent.setup().click(showAll);
    expect(within(byCharacterCard).getAllByRole('row')).toHaveLength(8);
  });

  describe('WR-02 (38-REVIEW-FIX): trend click-to-filter parity with the hub', () => {
    it('wires a working onSelectPoint that writes the clicked anchor to the URL and re-scopes the page', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true, eventName: 'Genesis 9' }),
        makeMatch({ id: 'm2', time: 2, win: true, eventName: 'Genesis 9' }),
        makeMatch({
          id: 'm3',
          time: 20 * 24 * 60 * 60 * 1000,
          win: false,
          opponent: 'other',
          eventName: '',
        }),
      ]);
      renderStageAt('/stages/1');

      await waitFor(() => expect(screen.getAllByText('rival').length).toBeGreaterThan(0));
      expect(screen.getAllByText('other').length).toBeGreaterThan(0);

      expect(capturedTrendLineProps?.mode).toBe('event');
      if (capturedTrendLineProps?.mode !== 'event') {
        throw new Error('expected the event-mode TrendLine props');
      }
      const onSelectPoint = capturedTrendLineProps.onSelectPoint;
      expect(onSelectPoint).toBeTypeOf('function');
      const genesisPoint = capturedTrendLineProps.points.find(
        (p) => p.eventKey === 'tournament:genesis 9:1',
      );
      expect(genesisPoint).toBeDefined();

      onSelectPoint!(genesisPoint!);

      // The SAME re-scoping a fresh `?event=` arrival produces (pinned by the
      // existing "scopes to an event axis" test above): the subtitle appears
      // and the games list narrows to only this event's games.
      await waitFor(() => expect(screen.getByText('at Genesis 9')).toBeInTheDocument());
      expect(screen.queryByText('other')).not.toBeInTheDocument();
    });
  });

  describe('WR-03 (38-REVIEW-FIX): D-16 memoization contract', () => {
    it('an unrelated re-render does not re-run the terminus narrowing predicate', async () => {
      const matchesDrillDownSpy = vi.mocked(drillDownParamsModule.matchesDrillDown);
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true }),
        makeMatch({ id: 'm2', time: 2, win: true }),
      ]);
      const { rerender, queryClient } = renderStageAt('/stages/1');

      await waitFor(() => expect(screen.getAllByText('rival').length).toBeGreaterThan(0));
      const callsBefore = matchesDrillDownSpy.mock.calls.length;
      expect(callsBefore).toBeGreaterThan(0);

      // Neither `StageDetailPage` nor `FilteredMatchList` is wrapped in
      // `React.memo`, so re-invoking `render()` on the same root always
      // re-runs both function bodies — the only thing under test is
      // whether that re-run recomputes `FilteredMatchList`'s own narrowing
      // memo. A stable `terminusAxes`/`eventKeyForMatch` reference means it
      // doesn't: `matchesDrillDown`'s call count stays flat.
      rerender(stageTree('/stages/1', queryClient));

      await waitFor(() => expect(screen.getAllByText('rival').length).toBeGreaterThan(0));
      expect(matchesDrillDownSpy.mock.calls.length).toBe(callsBefore);
    });
  });

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern.
  describe('one loading pattern (UIX-07)', () => {
    it('shows the CardSkeleton pattern with the busy status role and the existing loading label while matches load', () => {
      listMatches.mockReturnValue(new Promise(() => {}));

      const { container } = renderStageAt('/stages/1');

      const status = container.querySelector('[role="status"][aria-busy="true"]');
      expect(status).not.toBeNull();
      expect(status).toHaveTextContent('Loading stage…');
      expect(container.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
      expect(container.querySelector('div.text-muted-foreground')).toBeNull();
    });

    it('renders zero skeleton blocks once loaded', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true }),
        makeMatch({ id: 'm2', time: 2, win: true }),
      ]);

      const { container } = renderStageAt('/stages/1');
      await waitFor(() => expect(screen.getByText('Battlefield')).toBeInTheDocument());

      expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(0);
      expect(container.querySelector('[data-slot="stage-detail-body"]')).not.toBeNull();
    });

    it('on a background refetch, dims the stage body instead of flashing a skeleton', async () => {
      const twoGames = [
        makeMatch({ id: 'm1', time: 1, win: true }),
        makeMatch({ id: 'm2', time: 2, win: true }),
      ];
      listMatches.mockResolvedValue(twoGames);

      const { container, queryClient } = renderStageAt('/stages/1');
      await waitFor(() => expect(screen.getByText('Battlefield')).toBeInTheDocument());

      let resolveSecondFetch: (value: unknown) => void = () => {};
      listMatches.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSecondFetch = resolve;
          }),
      );

      queryClient.invalidateQueries();

      await waitFor(() => {
        const body = container.querySelector('[data-slot="stage-detail-body"]');
        expect(body?.className).toMatch(/opacity-60/);
      });
      expect(screen.getByText('Battlefield')).toBeInTheDocument();
      expect(container.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(0);

      resolveSecondFetch(twoGames);
      await waitFor(() => {
        const body = container.querySelector('[data-slot="stage-detail-body"]');
        expect(body?.className).not.toMatch(/opacity-60/);
      });
    });
  });
});

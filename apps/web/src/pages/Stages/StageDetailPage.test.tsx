import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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

const listWatchlist = vi.fn();
const trackWatchlist = vi.fn();
const untrackWatchlist = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    // Plan 39.2-10: every Track host reads the subject's watchlist.
    watchlist: {
      list: (...args: unknown[]) => listWatchlist(...args),
      track: (...args: unknown[]) => trackWatchlist(...args),
      untrack: (...args: unknown[]) => untrackWatchlist(...args),
    },
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
    listWatchlist.mockResolvedValue({ items: [] });
    trackWatchlist.mockResolvedValue({
      itemKey: 'stage:1',
      item: { kind: 'stage', ref: 1, createdAt: 1 },
    });
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

  describe('plan 39.2-10 (T-04): the Track toggle on the identity row', () => {
    it('sits on the right of the identity row and tracks the stage id', async () => {
      const user = userEvent.setup();
      listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);
      renderStageAt('/stages/1');

      const toggle = await screen.findByRole('button', { name: 'Track Battlefield' });
      const heading = screen.getByRole('heading', { level: 1 });
      expect(toggle.className).toContain('ml-auto');
      expect(toggle.parentElement?.contains(heading)).toBe(true);
      expect(toggle.parentElement?.lastElementChild).toBe(toggle);
      await waitFor(() => expect(toggle).toBeEnabled());

      await user.click(toggle);

      await waitFor(() => expect(trackWatchlist).toHaveBeenCalledTimes(1));
      expect(trackWatchlist).toHaveBeenCalledWith({ kind: 'stage', ref: 1 });
    });

    it('reads Tracked when the subject list holds stage:1', async () => {
      listMatches.mockResolvedValue([makeMatch({ id: 'm1', time: 1, win: true })]);
      listWatchlist.mockResolvedValue({
        items: [{ itemKey: 'stage:1', item: { kind: 'stage', ref: 1, createdAt: 1 } }],
      });
      renderStageAt('/stages/1');
      const toggle = await screen.findByRole('button', { name: 'Stop tracking Battlefield' });
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
    });

    it('offers no toggle for the unknown-stage bucket (id 0 is not trackable) or a non-stage segment', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true, map: { id: 0, name: 'no selection' } }),
      ]);
      renderStageAt('/stages/0');
      await waitFor(() => expect(listMatches).toHaveBeenCalled());
      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByRole('button', { name: /^Track / })).not.toBeInTheDocument();
    });
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

    // Plan 39.1-39: the row is a DrillableRow overlay — its accessible name
    // follows shared.drillableRow.aria ("{{subject}} — {{context}}, opens details").
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'rival — By Opponent, opens details' }),
      ).toBeInTheDocument(),
    );
    const link = screen.getByRole('link', { name: 'rival — By Opponent, opens details' });
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

  // Plan 39.1-39 (UI-SPEC §4.3): the page's own show-all / show-fewer
  // toggles are muted links (MUTED_LINK_TONE), never brand-red text.
  it('plan 39.1-39: both show-all toggles and the show-fewer toggle carry the muted link tone', async () => {
    const opponentFighters = SpriteList.slice(0, 7).map((s) => s.id);
    listMatches.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) =>
        makeMatch({
          id: `m${i}`,
          time: i + 1,
          win: true,
          opponent: `opponent${i}`,
          opponent_id: opponentFighters[i % 7]!,
        }),
      ),
    );
    renderStageAt('/stages/1');
    await waitFor(() => expect(screen.getByText('By Opponent')).toBeInTheDocument());
    const muted = (el: HTMLElement) => {
      const classes = el.className.split(/\s+/);
      expect(classes).toContain('text-muted-foreground');
      expect(classes).toContain('hover:text-foreground');
      expect(classes).not.toContain('text-primary');
    };
    const byOpponentCard = screen
      .getByText('By Opponent')
      .closest('[data-slot="card"]') as HTMLElement;
    const byCharacterCard = screen
      .getByText('By Character')
      .closest('[data-slot="card"]') as HTMLElement;
    const showAllOpponents = within(byOpponentCard).getByRole('button', { name: /show all 9/i });
    muted(showAllOpponents);
    muted(within(byCharacterCard).getByRole('button', { name: /show all 7/i }));
    await userEvent.setup().click(showAllOpponents);
    muted(within(byOpponentCard).getByRole('button', { name: /show fewer/i }));
  });

  it('WR-C06 (39.1-REVIEW.md): both show-all/show-fewer toggles carry aria-expanded and aria-controls pointing at their own table', async () => {
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
    const byCharacterCard = screen
      .getByText('By Character')
      .closest('[data-slot="card"]') as HTMLElement;

    const byOpponentToggle = within(byOpponentCard).getByRole('button', { name: /show all/i });
    expect(byOpponentToggle).toHaveAttribute('aria-expanded', 'false');
    const byOpponentControlsId = byOpponentToggle.getAttribute('aria-controls');
    expect(byOpponentControlsId).toBeTruthy();
    expect(document.getElementById(byOpponentControlsId!)).toBe(
      within(byOpponentCard).getByRole('table'),
    );

    // Only one table qualifies for a show-all toggle in this fixture (9
    // opponent rows > cap; the by-character split stays under its own cap),
    // but the ids must still be DISTINCT so a future second toggle can never
    // collide.
    const byCharacterTable = within(byCharacterCard).getByRole('table');
    expect(byCharacterTable.id).toBeTruthy();
    expect(byCharacterTable.id).not.toBe(byOpponentControlsId);

    await userEvent.setup().click(byOpponentToggle);
    expect(within(byOpponentCard).getByRole('button', { name: /show fewer/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
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

  // Plan 39.1-37 (UIX-01, UI-SPEC §6.1 "chart = 8 + 4"; event-chart-aspect).
  describe('plan 39.1-37: stage detail sits in the page container with Over Time in an 8 + 4 row', () => {
    function cardTitled(title: string): HTMLElement {
      const card = [...document.querySelectorAll('[data-slot="card"]')].find(
        (el) => el.querySelector('[data-slot="card-title"]')?.textContent === title,
      );
      expect(card, `card "${title}"`).toBeDefined();
      return card as HTMLElement;
    }

    it('renders inside PageShell (content capped at 1440px)', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true }),
        makeMatch({ id: 'm2', time: 2, win: false }),
      ]);
      const { container } = renderStageAt('/stages/1');
      await waitFor(() => expect(screen.getByText('Battlefield')).toBeInTheDocument());
      const body = container.querySelector('[data-slot="stage-detail-body"]')!;
      expect(body.closest('.max-w-\\[1440px\\]')).not.toBeNull();
    });

    it('puts Over Time in an 8-col cell beside a 4-col By Opponent cell; By Character and Games follow full-width', async () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'm1', time: 1, win: true }),
        makeMatch({ id: 'm2', time: 2, win: false, opponent: 'second' }),
      ]);
      renderStageAt('/stages/1');
      await waitFor(() => expect(screen.getByText('Battlefield')).toBeInTheDocument());

      const trendCell = cardTitled('Over Time').closest('[data-span]');
      expect(trendCell?.getAttribute('data-span')).toBe('8');
      const railCell = trendCell!.nextElementSibling;
      expect(railCell?.getAttribute('data-span')).toBe('4');
      expect(railCell!.contains(cardTitled('By Opponent'))).toBe(true);
      expect(cardTitled('By Character').closest('[data-span]')?.getAttribute('data-span')).toBe(
        '12',
      );
      expect(cardTitled('Games').closest('[data-span]')?.getAttribute('data-span')).toBe('12');
      // The two tables keep their ids (aria-controls targets) and the body marker stays.
      expect(document.getElementById('stage-by-opponent-table')).not.toBeNull();
      expect(document.querySelector('[data-slot="stage-detail-body"]')).not.toBeNull();
    });

    it('the loading skeleton mirrors the loaded spans (an 8-col chart beside a 4-col list)', () => {
      listMatches.mockReturnValue(new Promise(() => {}));
      const { container } = renderStageAt('/stages/1');
      const status = container.querySelector('[role="status"][aria-busy="true"]')!;
      expect(status.closest('.max-w-\\[1440px\\]')).not.toBeNull();
      const eight = status.querySelector('[data-span="8"]');
      expect(eight).not.toBeNull();
      expect(eight!.nextElementSibling?.getAttribute('data-span')).toBe('4');
    });
  });
});

describe('StageDetailPage — design-fidelity loop (plan 39.1-37 Task 3)', () => {
  it('the By Opponent win-rate cell wraps its sample cue under the rate instead of overflowing the 4-col card', async () => {
    resetAuthMock();
    setMockUser(makeMockUser());
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
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: false }),
    ]);
    renderStageAt('/stages/1');
    await waitFor(() => expect(screen.getByText('Battlefield')).toBeInTheDocument());
    const table = document.getElementById('stage-by-opponent-table')!;
    const rateCell = table.querySelector('tbody tr td:nth-child(3) > span')!;
    expect(rateCell.className).toMatch(/\bflex-wrap\b/);
    // TableCell is whitespace-nowrap by default — the cue can only wrap if the cell lets it.
    expect(rateCell.parentElement!.className).toMatch(/\bwhitespace-normal\b/);
  });
});

describe('StageDetailPage — the By Opponent rail uses the glyph cue (UI-SPEC §14.3, plan 39.1-37 Task 3)', () => {
  it('each rate carries the one-line ●●○ glyph (aria-label = the whole sentence), never the words form that makes the 4-col rail three lines a row', async () => {
    resetAuthMock();
    setMockUser(makeMockUser());
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
    listMatches.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) =>
        makeMatch({ id: `g${i}`, time: i + 1, win: i % 2 === 0 }),
      ),
    );
    renderStageAt('/stages/1');
    await waitFor(() => expect(screen.getByText('Battlefield')).toBeInTheDocument());
    const table = document.getElementById('stage-by-opponent-table')!;
    const rateCell = table.querySelector('tbody tr td:nth-child(3)')!;
    const glyph = rateCell.querySelector('[role="img"]');
    expect(glyph).not.toBeNull();
    expect(glyph!.textContent).toMatch(/^[●○]{3}$/);
    expect(glyph!.getAttribute('aria-label')).toMatch(/6 games/);
    expect(rateCell.textContent).not.toMatch(/confidence/);
  });
});

// Plan 39.1-38 Task 3 (deferred from 39.1-37; UI-SPEC §6.6 "< 640 tables
// become stacked rows", §6.5 rule 1; the FilteredMatchList precedent): below
// 640px the By Character list renders as stacked two-line rows, so nothing
// hides behind a horizontal scroll. jsdom has no `matchMedia`, so the phone
// branch is selected the way FilteredMatchList's tests select it — a stub.
describe('StageDetailPage — By Character as stacked rows below 640px (plan 39.1-38)', () => {
  const originalMatchMedia = window.matchMedia;

  function stubNarrowViewport(narrow: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: narrow && query === '(max-width: 639px)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  beforeEach(() => {
    resetAuthMock();
    setMockUser(makeMockUser());
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
    listMatches.mockResolvedValue([
      makeMatch({ id: 'c1', time: 1, win: true, fighter_id: mario.id, opponent_id: fox.id }),
      makeMatch({ id: 'c2', time: 2, win: false, fighter_id: mario.id, opponent_id: fox.id }),
      makeMatch({ id: 'c3', time: 3, win: true, fighter_id: mario.id, opponent_id: fox.id }),
      makeMatch({ id: 'c4', time: 4, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
    ]);
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('below 640px: one stacked two-line row per pairing — a truncating pairing link with a title, then record · rate · games with the confidence cue; no table, no horizontal scroller', async () => {
    stubNarrowViewport(true);
    renderStageAt('/stages/1');
    await waitFor(() => expect(screen.getByText('By Character')).toBeInTheDocument());
    const list = document.querySelector('[data-slot="stage-by-character"]') as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.tagName).toBe('UL');
    const card = list.closest('[data-slot="card"]') as HTMLElement;
    expect(card.querySelector('table')).toBeNull();
    expect(card.querySelector('.overflow-x-auto')).toBeNull();

    const rows = Array.from(list.querySelectorAll(':scope > li'));
    expect(rows).toHaveLength(2);
    const foxRow = rows[0] as HTMLElement;
    // Exactly one interactive element per row (plan 39.1-39's DrillableRow overlay later).
    const links = within(foxRow).getAllByRole('link');
    expect(links).toHaveLength(1);
    const href = links[0]!.getAttribute('href')!;
    expect(href).toContain('/matchups?');
    expect(href).toContain(`fighter=${mario.id}`);
    expect(href).toContain(`vs=${fox.id}`);
    expect(href).toContain('stage=1');

    const pairing = foxRow.querySelector('[data-slot="stage-by-character-pairing"]') as HTMLElement;
    expect(pairing).not.toBeNull();
    expect(pairing.className).toMatch(/\btruncate\b/);
    expect(pairing.getAttribute('title')).toBe(`${mario.name} vs ${fox.name}`);

    const line2 = foxRow.querySelector('[data-slot="stage-by-character-record"]') as HTMLElement;
    expect(line2).not.toBeNull();
    expect(line2.className).toMatch(/\bflex-wrap\b/);
    expect(line2.textContent).toContain('2-1');
    expect(line2.textContent).toContain('67%');
    expect(line2.textContent).toContain('3 games');
    // Each token wraps whole, never mid-token.
    for (const token of Array.from(line2.children).filter(
      (el) => !el.classList.contains('sr-only'),
    )) {
      expect(token.className).toMatch(/whitespace-nowrap/);
    }
    // The column headers stay available to assistive tech.
    expect(within(foxRow).getByText('Record')).toHaveClass('sr-only');
    expect(within(foxRow).getByText('Win Rate')).toHaveClass('sr-only');
  });

  it('at 640px and wider the By Character list stays the table (hook on the table element)', async () => {
    stubNarrowViewport(false);
    renderStageAt('/stages/1');
    await waitFor(() => expect(screen.getByText('By Character')).toBeInTheDocument());
    const table = document.querySelector('[data-slot="stage-by-character"]') as HTMLElement;
    expect(table.tagName).toBe('TABLE');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });
});

// Plan 39.1-39 (audit 8.1, UI-SPEC §10.1 row language, §4.3): the By opponent
// and By character rows are Phase 38 DrillableRows — the whole row is the
// link (an overlay with the shared accessible name), the tag / fighter names
// are plain foreground text, an always-visible chevron closes the row, and
// no row text is brand red. Destinations are unchanged.
describe('StageDetailPage — rows are DrillableRows, never brand-red links (plan 39.1-39)', () => {
  const originalMatchMedia = window.matchMedia;

  function stubViewport(narrow: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: narrow && query === '(max-width: 639px)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  beforeEach(() => {
    resetAuthMock();
    setMockUser(makeMockUser());
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
    listMatches.mockResolvedValue([
      makeMatch({ id: 'c1', time: 1, win: true, fighter_id: mario.id, opponent_id: fox.id }),
      makeMatch({ id: 'c2', time: 2, win: false, fighter_id: mario.id, opponent_id: fox.id }),
      makeMatch({ id: 'c3', time: 3, win: true, fighter_id: mario.id, opponent_id: fox.id }),
      makeMatch({ id: 'c4', time: 4, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
    ]);
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  function expectNoBrandRed(root: HTMLElement) {
    expect(root.querySelector('.text-primary')).toBeNull();
  }

  it('by opponent: each row is relative, carries one overlay link with the shared name and the hub destination, plain-text tag, and a chevron', async () => {
    stubViewport(false);
    renderStageAt('/stages/1');
    await waitFor(() => expect(screen.getByText('By Opponent')).toBeInTheDocument());
    const table = document.getElementById('stage-by-opponent-table')!;
    const row = table.querySelector('tbody tr') as HTMLElement;
    expect(row.className.split(/\s+/)).toContain('relative');
    const links = within(row).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('rival — By Opponent, opens details');
    expect(links[0]).toHaveAttribute('href', '/opponents/rival?stage=1');
    expect(links[0]!.textContent).toBe('');
    const tagCell = row.querySelector('td') as HTMLElement;
    expect(tagCell.textContent).toContain('rival');
    expect(row.querySelector('svg.lucide-chevron-right')).not.toBeNull();
    expectNoBrandRed(table);
  });

  it('by character (table): one overlay link per row to the same Matchups destination, plain fighter names, a chevron in the last cell', async () => {
    stubViewport(false);
    renderStageAt('/stages/1');
    await waitFor(() => expect(screen.getByText('By Character')).toBeInTheDocument());
    const table = document.querySelector('table[data-slot="stage-by-character"]') as HTMLElement;
    const rows = Array.from(table.querySelectorAll('tbody tr')) as HTMLElement[];
    const foxRow = rows.find((r) => r.textContent?.includes(fox.name))!;
    expect(foxRow.className.split(/\s+/)).toContain('relative');
    const links = within(foxRow).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName(
      `${mario.name} vs ${fox.name} — By Character, opens details`,
    );
    const href = links[0]!.getAttribute('href')!;
    expect(href).toContain('/matchups?');
    expect(href).toContain(`fighter=${mario.id}`);
    expect(href).toContain(`vs=${fox.id}`);
    expect(href).toContain('stage=1');
    const cells = foxRow.querySelectorAll('td');
    expect(cells[cells.length - 1]!.querySelector('svg.lucide-chevron-right')).not.toBeNull();
    expectNoBrandRed(table);
  });

  it('by character (stacked, below 640px): each li is a relative DrillableRow with one overlay link and a chevron', async () => {
    stubViewport(true);
    renderStageAt('/stages/1');
    await waitFor(() => expect(screen.getByText('By Character')).toBeInTheDocument());
    const list = document.querySelector('ul[data-slot="stage-by-character"]') as HTMLElement;
    const foxRow = Array.from(list.querySelectorAll(':scope > li')).find((li) =>
      li.textContent?.includes(fox.name),
    ) as HTMLElement;
    expect(foxRow.className.split(/\s+/)).toContain('relative');
    const links = within(foxRow).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName(
      `${mario.name} vs ${fox.name} — By Character, opens details`,
    );
    expect(foxRow.querySelector('svg.lucide-chevron-right')).not.toBeNull();
    expectNoBrandRed(list);
  });
});

// Plan 39.1-39 (VIZ-01, UI-SPEC section 11; section 10.2): the Over Time trend
// renders at most 60 points on any account (the engine bins; the chart never
// does), built through buildEventTrendPoints with readable labels; a bin click
// drills event=bin:... and the games list shows exactly that bin's games.
describe('StageDetailPage — bounded, readable event trend (plan 39.1-39)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const START = Date.UTC(2026, 0, 5, 18);

  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    capturedTrendLineProps = undefined;
    setMockUser(makeMockUser());
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
    listMatches.mockResolvedValue(
      Array.from({ length: 150 }, (_, i) =>
        makeMatch({ id: `d${i}`, time: START + i * DAY, win: i % 3 !== 0 }),
      ),
    );
  });

  function eventProps() {
    if (capturedTrendLineProps?.mode !== 'event')
      throw new Error('expected event-mode TrendLine props');
    return capturedTrendLineProps;
  }

  it('a 150-anchor stage renders at most 60 points, every label readable', async () => {
    renderStageAt('/stages/1');
    await waitFor(() => expect(eventProps().points.length).toBeGreaterThan(1));
    const { points } = eventProps();
    expect(points.length).toBeLessThanOrEqual(60);
    expect(points.every((p) => p.eventKey.startsWith('bin:week:'))).toBe(true);
    for (const point of points) {
      expect(point.context.eventLabel).not.toContain('::');
      expect(point.context.eventLabel).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("clicking a bin drills event=bin:... and the games list shows exactly that bin's games", async () => {
    renderStageAt('/stages/1');
    await waitFor(() => expect(eventProps().points.length).toBeGreaterThan(1));
    const bin = eventProps().points[3]!;
    act(() => eventProps().onSelectPoint!(bin));
    await waitFor(() => {
      const table = document.querySelector('table[data-total-rows]') as HTMLElement;
      expect(table).not.toBeNull();
      expect(Number(table.getAttribute('data-total-rows'))).toBe(bin.wins + bin.losses);
    });
    expect(bin.wins + bin.losses).toBe(7);
  });
});

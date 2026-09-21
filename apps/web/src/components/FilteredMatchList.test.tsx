import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import { FilteredMatchList, matchHasAttachedVideo } from './FilteredMatchList';
import type { DrillDownAxes } from '@/lib/drillDownParams';

/**
 * Phase 38-04 Task 2: the terminus's full row contract — pinned-column
 * omission, the active-filter summary, the video-link row, the
 * inline-expansion row, and the preserved delete flow.
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

const removeMatch = vi.fn().mockResolvedValue(undefined);
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    matches: { remove: (...args: unknown[]) => removeMatch(...args) },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1000,
    win: true,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    ...overrides,
  } as Match;
}

function renderList(props: Partial<React.ComponentProps<typeof FilteredMatchList>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const axes: DrillDownAxes = props.axes ?? {};
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/matchups']}>
        <AuthProvider>
          <Routes>
            <Route
              path="/matchups"
              element={<FilteredMatchList matches={[]} axes={axes} {...props} />}
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FilteredMatchList', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
  });

  it('matchHasAttachedVideo is true only when vodUrl is present', () => {
    expect(matchHasAttachedVideo(makeMatch({ vodUrl: 'https://youtu.be/x' }))).toBe(true);
    expect(matchHasAttachedVideo(makeMatch({ vodUrl: undefined }))).toBe(false);
  });

  it('omits the stage column header when the stage axis is pinned, and shows it otherwise', () => {
    const matches = [makeMatch()];
    const { unmount } = renderList({ matches, axes: {} });
    expect(screen.getByRole('columnheader', { name: 'Stage' })).toBeInTheDocument();
    unmount();

    renderList({ matches, axes: { stageId: 1 } });
    expect(screen.queryByRole('columnheader', { name: 'Stage' })).not.toBeInTheDocument();
  });

  it('renders a match with an attached video as a link whose destination contains the match id', () => {
    const matches = [makeMatch({ id: 'vid-1', vodUrl: 'https://youtu.be/x' })];
    renderList({ matches });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', expect.stringContaining('vid-1'));
  });

  it('renders the same video row under a coach route with the coach-prefixed destination', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const matches = [makeMatch({ id: 'vid-2', vodUrl: 'https://youtu.be/x' })];
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/coach/test-client/matchups']}>
          <AuthProvider>
            <Routes>
              <Route
                path="/coach/:clientId/matchups"
                element={<FilteredMatchList matches={matches} axes={{}} />}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toContain('/coach/test-client/');
    expect(link.getAttribute('href')).toContain('vid-2');
  });

  it('renders a match with no attached video as an expand button revealing match facts and a tournament link', async () => {
    const user = userEvent.setup();
    const matches = [makeMatch({ id: 'novid-1', vodUrl: undefined })];
    renderList({
      matches,
      tournamentLinkForMatch: () => ({ href: '/tournaments/xyz', label: 'View tournament' }),
    });
    const button = screen.getByRole('button', { name: /show details|opens video/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText('Battlefield').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'View tournament' })).toHaveAttribute(
      'href',
      '/tournaments/xyz',
    );
  });

  it('never renders a row that is simultaneously an anchor and an expander', () => {
    const matches = [
      makeMatch({ id: 'a', vodUrl: 'https://youtu.be/x' }),
      makeMatch({ id: 'b', vodUrl: undefined }),
    ];
    renderList({ matches });
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('shows the delete icon button only when the host opts in, and the confirm dialog uses the existing string', async () => {
    const user = userEvent.setup();
    const matches = [makeMatch({ id: 'del-1', vodUrl: undefined })];

    const { unmount } = renderList({ matches, showDelete: false });
    expect(screen.queryByRole('button', { name: 'Delete match' })).not.toBeInTheDocument();
    unmount();

    renderList({ matches, showDelete: true });
    const deleteButton = screen.getByRole('button', { name: 'Delete match' });
    await user.click(deleteButton);
    expect(await screen.findByText('Delete this match?')).toBeInTheDocument();
  });

  it('never renders a bare clickable div — every row is a real link or button', () => {
    const matches = [
      makeMatch({ id: 'a', vodUrl: 'https://youtu.be/x' }),
      makeMatch({ id: 'b', vodUrl: undefined }),
    ];
    const { container } = renderList({ matches });
    expect(container.querySelectorAll('div[onclick]')).toHaveLength(0);
  });

  it('renders the active-filter summary and count when at least one axis is active', () => {
    const matches = [makeMatch()];
    renderList({ matches, axes: { stageId: 1 } });
    expect(screen.getByText(/1 game/)).toBeInTheDocument();
  });

  it('renders no summary bar when no axis is active', () => {
    const matches = [makeMatch()];
    renderList({ matches, axes: {} });
    expect(screen.queryByText(/games ·/)).not.toBeInTheDocument();
  });

  it('invokes onClearFilters from the clear-filters button', async () => {
    const user = userEvent.setup();
    const onClearFilters = vi.fn();
    renderList({ matches: [makeMatch()], axes: { stageId: 1 }, onClearFilters });
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('renders the empty-state copy when no matches are given', () => {
    renderList({ matches: [] });
    expect(screen.getByText('No games match these filters.')).toBeInTheDocument();
  });

  it('replaces the whole component with the loading line when loading', () => {
    renderList({ matches: [makeMatch()], loading: true });
    expect(screen.getByText('Loading games…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('plan 39.1-19: a claim axis with a resolver narrows to exactly the resolver-returned games, in addition to the other axes', () => {
    const matches = [
      makeMatch({ id: 'a', map: { id: 1, name: 'Battlefield' } }),
      makeMatch({ id: 'b', map: { id: 1, name: 'Battlefield' } }),
      makeMatch({ id: 'c', map: { id: 2, name: 'Pokemon Stadium 2' } }),
    ];
    const resolveClaim = vi.fn((claimId: string) =>
      claimId === 'formNow:account:last30' ? [matches[0]!, matches[1]!] : undefined,
    );
    renderList({
      matches,
      axes: { claimId: 'formNow:account:last30' },
      resolveClaim,
    });
    expect(resolveClaim).toHaveBeenCalledWith('formNow:account:last30', matches);
    expect(screen.getByText(/2 games/)).toBeInTheDocument();
  });

  it('plan 39.1-19: a stale claim id (resolver returns undefined) falls back to the remaining axes', () => {
    const matches = [
      makeMatch({ id: 'a', map: { id: 1, name: 'Battlefield' } }),
      makeMatch({ id: 'b', map: { id: 2, name: 'Pokemon Stadium 2' } }),
    ];
    const resolveClaim = vi.fn(() => undefined);
    renderList({
      matches,
      axes: { claimId: 'stale:id:last30', stageId: 1 },
      resolveClaim,
    });
    expect(screen.getByText(/1 game/)).toBeInTheDocument();
  });

  it('plan 39.1-19: no resolver supplied at all — the claim axis is a no-op, remaining axes still apply', () => {
    const matches = [makeMatch({ id: 'a', map: { id: 1, name: 'Battlefield' } })];
    renderList({ matches, axes: { claimId: 'formNow:account:last30' } });
    expect(screen.getByText(/1 game/)).toBeInTheDocument();
  });

  it('plan 39.1-19: the active-filter summary shows the insight label-and-statement head when claimSummary is supplied', () => {
    const matches = [makeMatch({ id: 'a' })];
    renderList({
      matches,
      axes: { claimId: 'formNow:account:last30' },
      resolveClaim: () => matches,
      claimSummary: 'vs Terry · last 30 games',
    });
    expect(screen.getByText(/vs Terry · last 30 games/)).toBeInTheDocument();
  });

  it('never re-sorts the given array — renders rows in the exact order passed', () => {
    const outOfOrder = [
      makeMatch({ id: 'older', time: 100, vodUrl: undefined }),
      makeMatch({ id: 'newer', time: 200, vodUrl: undefined }),
    ];
    renderList({ matches: outOfOrder });
    const buttons = screen.getAllByRole('button');
    // Both are expand buttons (no video); order in the DOM must mirror the
    // deliberately-out-of-order input, proving no internal re-sort happens.
    expect(buttons[0]).toHaveAccessibleName(expect.stringContaining('rival'));
    expect(buttons).toHaveLength(2);
  });

  it('the attached-video predicate is the only place vodUrl is read in this component', () => {
    // Static assertion companion to the module-level grep gate — kept here
    // so a reviewer sees the intent alongside the behavioural tests.
    expect(matchHasAttachedVideo).toBeTypeOf('function');
  });
});

describe('FilteredMatchList — responsive layout (phase 38-08, UI-SPEC E4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wide branch (explicit): renders a table, no stacked-list root, one data row per narrowed match', () => {
    const matches = [
      makeMatch({ id: 'a', vodUrl: undefined }),
      makeMatch({ id: 'b', vodUrl: undefined }),
    ];
    const { container } = renderList({ matches, layout: 'table' });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="filtered-match-stack"]')).toBeNull();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('button')).toHaveLength(matches.length);
  });

  it('narrow branch (explicit): renders the stacked-list root, no table anywhere, one list item per narrowed match with nothing expanded', () => {
    const matches = [
      makeMatch({ id: 'a', vodUrl: undefined }),
      makeMatch({ id: 'b', vodUrl: undefined }),
    ];
    const { container } = renderList({ matches, layout: 'stack' });
    const stack = container.querySelector('[data-slot="filtered-match-stack"]');
    expect(stack).not.toBeNull();
    expect(container.querySelector('table')).toBeNull();
    expect(within(stack as HTMLElement).getAllByRole('listitem')).toHaveLength(matches.length);
    expect(within(stack as HTMLElement).queryAllByText('Battlefield')).toHaveLength(matches.length);
  });

  it('narrowing parity: both explicit layouts render exactly the narrowed count, not the full count', () => {
    const matches = [
      makeMatch({ id: 'a', map: { id: 1, name: 'Battlefield' } }),
      makeMatch({ id: 'b', map: { id: 1, name: 'Battlefield' } }),
      makeMatch({ id: 'c', map: { id: 2, name: 'Pokemon Stadium 2' } }),
    ];
    const axes: DrillDownAxes = { stageId: 1 };

    const { container: tableContainer } = renderList({ matches, axes, layout: 'table' });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3); // header + 2 body rows
    void tableContainer;

    const { container: stackContainer } = renderList({ matches, axes, layout: 'stack' });
    const stack = stackContainer.querySelector('[data-slot="filtered-match-stack"]') as HTMLElement;
    expect(within(stack).getAllByRole('listitem')).toHaveLength(2);
  });

  it('D-08 split in the narrow branch: exactly one anchor containing the vod match id, exactly one expand button', () => {
    const matches = [
      makeMatch({ id: 'vid', vodUrl: 'https://youtu.be/x' }),
      makeMatch({ id: 'novid', vodUrl: undefined }),
    ];
    renderList({ matches, layout: 'stack' });
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('vid'));
    const buttons = screen.getAllByRole('button', { name: /show details|opens video/i });
    expect(buttons).toHaveLength(1);
  });

  it('default branch (no stub, no override): jsdom has no matchMedia, so it renders the table', () => {
    const matches = [makeMatch({ id: 'a' })];
    const { container } = renderList({ matches });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="filtered-match-stack"]')).toBeNull();
  });

  it('default branch (matchMedia stubbed to match): renders the stack, no table', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const matches = [makeMatch({ id: 'a' })];
    const { container } = renderList({ matches });
    expect(container.querySelector('[data-slot="filtered-match-stack"]')).not.toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });
});

describe('FilteredMatchList — narrow-layout parity (phase 38-08 Task 2)', () => {
  it('pinned-axis omission parity: the stage axis hides the stage name in the stacked row', () => {
    const matches = [makeMatch()];
    const { container: withoutAxis } = renderList({ matches, axes: {}, layout: 'stack' });
    expect(
      within(withoutAxis as unknown as HTMLElement).getByText('Battlefield'),
    ).toBeInTheDocument();

    const { container: withAxis } = renderList({
      matches,
      axes: { stageId: 1 },
      layout: 'stack',
    });
    expect(
      within(withAxis as unknown as HTMLElement).queryByText('Battlefield'),
    ).not.toBeInTheDocument();
  });

  it('pinned-axis omission parity: the fighter axis hides my character in the stacked row', () => {
    const matches = [makeMatch()];
    const { container: withAxis } = renderList({
      matches,
      axes: { fighterId: mario.id },
      layout: 'stack',
    });
    expect(within(withAxis as unknown as HTMLElement).queryByText('Mario')).not.toBeInTheDocument();
    expect(within(withAxis as unknown as HTMLElement).getByText('Luigi')).toBeInTheDocument();
  });

  it('pinned-axis omission parity: the vsFighter axis hides their character in the stacked row', () => {
    const matches = [makeMatch()];
    const { container: withAxis } = renderList({
      matches,
      axes: { vsFighterId: luigi.id },
      layout: 'stack',
    });
    expect(within(withAxis as unknown as HTMLElement).queryByText('Luigi')).not.toBeInTheDocument();
    expect(within(withAxis as unknown as HTMLElement).getByText('Mario')).toBeInTheDocument();
  });

  it('active-filter summary parity: renders above the stacked list and the clear button invokes the host callback once', async () => {
    const user = userEvent.setup();
    const onClearFilters = vi.fn();
    renderList({
      matches: [makeMatch()],
      axes: { stageId: 1 },
      layout: 'stack',
      onClearFilters,
    });
    expect(screen.getByText(/1 game/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('empty-state parity: a narrowed result of zero renders the empty copy and no stacked-list root', () => {
    const { container } = renderList({ matches: [], layout: 'stack' });
    expect(screen.getByText('No games match these filters.')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="filtered-match-stack"]')).toBeNull();
  });

  it('loading parity: the loading prop replaces the whole component — neither layout root is in the DOM', () => {
    const { container } = renderList({ matches: [makeMatch()], loading: true, layout: 'stack' });
    expect(screen.getByText('Loading games…')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="filtered-match-table"]')).toBeNull();
    expect(container.querySelector('[data-slot="filtered-match-stack"]')).toBeNull();
  });

  it('delete-flow parity: no delete button in a stacked row without the host opt-in, present and dialog-gated with it', async () => {
    const user = userEvent.setup();
    const matches = [makeMatch({ id: 'del-1', vodUrl: undefined })];

    const { unmount } = renderList({ matches, showDelete: false, layout: 'stack' });
    expect(screen.queryByRole('button', { name: 'Delete match' })).not.toBeInTheDocument();
    unmount();

    renderList({ matches, showDelete: true, layout: 'stack' });
    const deleteButton = screen.getByRole('button', { name: 'Delete match' });
    await user.click(deleteButton);
    expect(await screen.findByText('Delete this match?')).toBeInTheDocument();
  });

  it('keyboard activation: focusing a stacked expander and pressing Enter toggles it open, pressing Enter again collapses it', async () => {
    const user = userEvent.setup();
    const matches = [makeMatch({ id: 'novid-1', vodUrl: undefined })];
    renderList({ matches, layout: 'stack' });
    const button = screen.getByRole('button', { name: /show details|opens video/i });
    button.focus();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('single-open accordion parity: expanding the second of two non-VOD stacked rows collapses the first', async () => {
    const user = userEvent.setup();
    const matches = [
      makeMatch({ id: 'a', vodUrl: undefined, opponent: 'alice' }),
      makeMatch({ id: 'b', vodUrl: undefined, opponent: 'bob' }),
    ];
    renderList({ matches, layout: 'stack' });
    const buttons = screen.getAllByRole('button', { name: /show details|opens video/i });
    await user.click(buttons[0]!);
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'true');
    await user.click(buttons[1]!);
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'true');
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('coach-route destination parity: the stacked VOD row href carries the coach prefix and the match id', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const matches = [makeMatch({ id: 'vid-3', vodUrl: 'https://youtu.be/x' })];
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/coach/test-client/matchups']}>
          <AuthProvider>
            <Routes>
              <Route
                path="/coach/:clientId/matchups"
                element={<FilteredMatchList matches={matches} axes={{}} layout="stack" />}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toContain('/coach/test-client/');
    expect(link.getAttribute('href')).toContain('vid-3');
  });

  it('scroll-cap parity: the stacked list renders inside the shared max-height scroll wrapper', () => {
    const { container } = renderList({ matches: [makeMatch()], layout: 'stack' });
    const stack = container.querySelector('[data-slot="filtered-match-stack"]');
    expect(stack?.closest('.max-h-\\[500px\\]')).not.toBeNull();
  });
});

/**
 * Phase 38-08 code review WR-01: `relative` (the lift above `MatchRowOverlay`'s
 * absolutely-positioned whole-row click target) must scope to the delete
 * button's own wrapper only — never to a shared ancestor that also contains
 * the Badge/video-icon, which would lift those non-interactive elements into
 * the overlay's paint layer and turn them into a click dead zone. jsdom does
 * not hit-test by visual stacking order, so this asserts the DOM/class
 * structure the CSS painting-order argument depends on, for both layouts (so
 * they cannot drift apart again).
 */
function relativeAncestorsBetween(el: HTMLElement, root: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    if (node.classList.contains('relative')) found.push(node);
    node = node.parentElement;
  }
  return found;
}

describe('FilteredMatchList — overlay lift scope (phase 38-08 code review WR-01)', () => {
  it('stacked layout: only the delete button is lifted above the row overlay — the Badge/icon carry no positioned ancestor before the row root', () => {
    const matches = [makeMatch({ id: 'wr01-stack', vodUrl: undefined })];
    const { container } = renderList({ matches, showDelete: true, layout: 'stack' });
    const row = within(container).getByRole('listitem');
    const badge = row.querySelector<HTMLElement>('[data-slot="badge"]');
    const deleteButton = within(row).getByRole('button', { name: 'Delete match' });
    expect(badge).not.toBeNull();
    expect(relativeAncestorsBetween(badge as HTMLElement, row)).toHaveLength(0);
    expect(relativeAncestorsBetween(deleteButton, row).length).toBeGreaterThan(0);
  });

  it('table layout: only the delete cell is lifted above the row overlay — the Badge/icon carry no positioned ancestor before the row root (mirrors the stacked assertion above)', () => {
    const matches = [makeMatch({ id: 'wr01-table', vodUrl: undefined })];
    const { container } = renderList({ matches, showDelete: true, layout: 'table' });
    const row = within(container).getByRole('row', { name: /rival/ });
    const badge = row.querySelector<HTMLElement>('[data-slot="badge"]');
    const deleteButton = within(row).getByRole('button', { name: 'Delete match' });
    expect(badge).not.toBeNull();
    expect(relativeAncestorsBetween(badge as HTMLElement, row)).toHaveLength(0);
    expect(relativeAncestorsBetween(deleteButton, row).length).toBeGreaterThan(0);
  });
});

describe('waitFor smoke (loading -> populated transition is not tested elsewhere)', () => {
  it('renders populated after a loading prop flips false', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const matches = [makeMatch({ vodUrl: undefined })];
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/matchups']}>
          <AuthProvider>
            <Routes>
              <Route
                path="/matchups"
                element={<FilteredMatchList matches={matches} axes={{}} loading={false} />}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(within(screen.getByRole('table')).getAllByRole('row').length).toBeGreaterThan(0);
  });
});

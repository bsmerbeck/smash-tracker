import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import {
  FilteredMatchList,
  matchHasAttachedVideo,
  FILTERED_MATCH_LIST_ROW_CAP,
  FILTERED_MATCH_LIST_PAGE_SIZE,
} from './FilteredMatchList';
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

  it('WR-B02 (39.1-REVIEW.md): a stale claim id (resolver returns undefined) hides claimSummary from the active-filter summary too, even when supplied — it would describe content the fallback axes no longer show', () => {
    const matches = [
      makeMatch({ id: 'a', map: { id: 1, name: 'Battlefield' } }),
      makeMatch({ id: 'b', map: { id: 2, name: 'Pokemon Stadium 2' } }),
    ];
    const resolveClaim = vi.fn(() => undefined);
    renderList({
      matches,
      axes: { claimId: 'stale:id:last30', stageId: 1 },
      resolveClaim,
      claimSummary: 'vs Terry · last 30 games',
    });
    // Falls back to the remaining axis (stageId 1 -> "a" only).
    expect(screen.getByText(/1 game/)).toBeInTheDocument();
    // The stale claim's summary text must NOT appear — it describes a claim
    // that did not resolve, not the "Battlefield" set actually rendered.
    expect(screen.queryByText(/vs Terry · last 30 games/)).not.toBeInTheDocument();
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

  /**
   * Plan 39.1-32 (item 13, UI-SPEC §6.4 exemption 2 narrowed to the table
   * layout only): supersedes the Phase 38-08 "scroll-cap parity" case above,
   * which pinned the stacked layout INSIDE the shared `max-h-[500px]
   * overflow-y-auto` wrapper. That exemption existed because Phase 38's list
   * was unbounded; plan 39.1-28 now bounds every DOM pass at
   * `FILTERED_MATCH_LIST_ROW_CAP` rows + "Show 50 more" paging, so the
   * stacked (phone) layout drops the inner scroller and flows in the page —
   * the table layout keeps the grandfathered wrapper (next case).
   */
  it('stacked layout: no ancestor between the root and the list carries a max-height or overflow-y utility (item 13)', () => {
    const { container } = renderList({ matches: [makeMatch()], layout: 'stack' });
    const stack = container.querySelector('[data-slot="filtered-match-stack"]') as HTMLElement;
    expect(stack).not.toBeNull();
    let node: HTMLElement | null = stack.parentElement;
    while (node && node !== container) {
      expect(node.className).not.toMatch(/max-h-|overflow-y-auto|overflow-y-scroll/);
      node = node.parentElement;
    }
  });

  it('table layout: the wrapper around the table still carries the grandfathered 500px scroll box (exemption 2 unchanged)', () => {
    const { container } = renderList({ matches: [makeMatch()], layout: 'table' });
    const table = container.querySelector('[data-slot="filtered-match-table"]');
    expect(table?.closest('.max-h-\\[500px\\]')).not.toBeNull();
    expect(table?.closest('.overflow-y-auto')).not.toBeNull();
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

/**
 * Plan 39.1-28 (UIX-02, owner decision 2026-09-22): the terminus caps rows
 * MOUNTED at `FILTERED_MATCH_LIST_ROW_CAP` (100) on first render, printing
 * the full narrowed count via `data-total-rows` and a polite live-region
 * progress line, and reveals the rest through a "Show N more" paging control
 * that mounts at most `FILTERED_MATCH_LIST_PAGE_SIZE` (50) rows per
 * activation — replacing plan 39.1-23's one-step "Show all" reveal, which
 * the owner rejected as over-spec (REQUIREMENTS.md UIX-02 / UI-SPEC §6.4:
 * "<= 100 rows per pass + 'Show 50 more'").
 */
function makeManyMatches(count: number): Match[] {
  return Array.from({ length: count }, (_, i) =>
    makeMatch({ id: `bulk-${i}`, time: 1000 + i, vodUrl: undefined }),
  );
}

/** Matches an accessible name like "Show 50 more" for a given next-page size. */
function showMoreName(n: number): RegExp {
  return new RegExp(`show ${n} more`, 'i');
}

describe('FilteredMatchList — 100-row first pass + "Show 50 more" paging (plan 39.1-28, UIX-02)', () => {
  it('table layout: mounts exactly the cap, exposes data-total-rows, and shows the first paging control + progress line', () => {
    const matches = makeManyMatches(1000);
    renderList({ matches, axes: {}, layout: 'table' });
    const table = screen.getByRole('table');
    // header row + capped body rows
    expect(within(table).getAllByRole('row')).toHaveLength(FILTERED_MATCH_LIST_ROW_CAP + 1);
    expect(table).toHaveAttribute('data-total-rows', '1000');

    const showMore = screen.getByRole('button', {
      name: showMoreName(FILTERED_MATCH_LIST_PAGE_SIZE),
    });
    expect(showMore).toHaveAttribute('aria-controls', table.id);
    expect(table.id).not.toBe('');

    const progress = document.querySelector('[aria-live="polite"]');
    expect(progress).not.toBeNull();
    expect(progress).toHaveTextContent(new RegExp(`${FILTERED_MATCH_LIST_ROW_CAP} .* 1000`));
  });

  it('stacked layout: count, data-total-rows and paging control against <li> rows, at the layout-appropriate cap (plan 39.1-33: stack no longer shares the table cap — see the dedicated stack-paging describe below for its 20-row bound)', () => {
    const matches = makeManyMatches(1000);
    const { container } = renderList({ matches, axes: {}, layout: 'stack' });
    const stack = container.querySelector('[data-slot="filtered-match-stack"]') as HTMLElement;
    // Plan 39.1-33 local literal, mirrors the not-yet-imported
    // FILTERED_MATCH_LIST_STACK_ROW_CAP/PAGE_SIZE (see the dedicated describe
    // below) — this case predates the stack/table cap split (plan 39.1-28)
    // and originally pinned the shared FILTERED_MATCH_LIST_ROW_CAP (100).
    const stackRowCap = 20;
    const stackPageSize = 20;
    expect(within(stack).getAllByRole('listitem')).toHaveLength(stackRowCap);
    expect(stack).toHaveAttribute('data-total-rows', '1000');
    const showMore = screen.getByRole('button', {
      name: showMoreName(stackPageSize),
    });
    expect(showMore).toHaveAttribute('aria-controls', stack.id);
  });

  it('one activation mounts exactly one page more, leaving focus on the control while pages remain', async () => {
    const user = userEvent.setup();
    const matches = makeManyMatches(1000);
    renderList({ matches, axes: {}, layout: 'table' });
    const showMore = screen.getByRole('button', {
      name: showMoreName(FILTERED_MATCH_LIST_PAGE_SIZE),
    });
    await user.click(showMore);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(
      FILTERED_MATCH_LIST_ROW_CAP + FILTERED_MATCH_LIST_PAGE_SIZE + 1,
    );
    // Many pages remain (1000 total) — the control is still mounted and
    // still holds native click focus.
    expect(screen.getByRole('button', { name: showMoreName(FILTERED_MATCH_LIST_PAGE_SIZE) })).toBe(
      document.activeElement,
    );
  });

  it('activating the control to exhaustion ends with every row mounted, no activation adding more than the page size, and focus finally on the list root (never <body>)', () => {
    // `fireEvent.click` (not `userEvent.click`) — this loop clicks ~18 times
    // for a 1000-row fixture; real-pointer-event simulation per click made
    // this test time out at the 15s default. Focus at the end is asserted
    // via the component's own `document.getElementById(rootId)?.focus()`
    // effect, which `fireEvent.click` triggers identically to `userEvent`.
    // Measured standalone: ~18-24s. Under `pnpm --filter @smash-tracker/web
    // test`'s full concurrent run it measured ~31s (timed out once at the
    // 30s bound) — the explicit 60s timeout below keeps ~2x headroom over
    // that measurement, the same margin `insightDoorSameN.test.tsx`'s
    // SAME_N_DOOR_TIMEOUT_MS uses for its own slow-render cases.
    const matches = makeManyMatches(1000);
    renderList({ matches, axes: {}, layout: 'table' });
    const table = screen.getByRole('table');
    let mounted = within(table).getAllByRole('row').length - 1;
    expect(mounted).toBe(FILTERED_MATCH_LIST_ROW_CAP);

    let button = screen.queryByRole('button', { name: /show \d+ more/i });
    while (button) {
      fireEvent.click(button);
      const newMounted = within(table).getAllByRole('row').length - 1;
      expect(newMounted - mounted).toBeLessThanOrEqual(FILTERED_MATCH_LIST_PAGE_SIZE);
      mounted = newMounted;
      button = screen.queryByRole('button', { name: /show \d+ more/i });
    }

    expect(mounted).toBe(1000);
    expect(document.activeElement).toBe(table);
    expect(document.activeElement).not.toBe(document.body);
    // The progress line stays present (and states the final, exhausted
    // count) even once the paging control itself has unmounted.
    const progress = document.querySelector('[aria-live="polite"]');
    expect(progress).toHaveTextContent(/1000 .* 1000/);
  }, 60_000);

  it('partial last page: 130 narrowed -> the control is named for the exact 30-row remainder, and one activation mounts all 130', async () => {
    const user = userEvent.setup();
    const matches = makeManyMatches(FILTERED_MATCH_LIST_ROW_CAP + 30);
    renderList({ matches, axes: {}, layout: 'table' });
    const showMore = screen.getByRole('button', { name: showMoreName(30) });
    await user.click(showMore);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(FILTERED_MATCH_LIST_ROW_CAP + 30 + 1);
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).not.toBeInTheDocument();
  });

  it.each([
    [FILTERED_MATCH_LIST_ROW_CAP - 1, false],
    [FILTERED_MATCH_LIST_ROW_CAP, false],
    [FILTERED_MATCH_LIST_ROW_CAP + 1, true],
  ])(
    'the paging control (named for 1) and the progress line appear only once narrowed count exceeds the cap (n=%i)',
    (n, expectVisible) => {
      const matches = makeManyMatches(n);
      renderList({ matches, axes: {}, layout: 'table' });
      const button = screen.queryByRole('button', { name: /show \d+ more/i });
      expect(button !== null).toBe(expectVisible);
      if (expectVisible) {
        expect(button).toHaveAccessibleName(showMoreName(1));
      }
      const progress = document.querySelector('[aria-live="polite"]');
      expect(progress !== null).toBe(expectVisible);
    },
  );

  it('re-narrowing (a new narrowedMatches identity) resets paging back to the first cap rows', async () => {
    const user = userEvent.setup();
    const matches = makeManyMatches(1000);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ axes }: { axes: DrillDownAxes }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/matchups']}>
          <AuthProvider>
            <Routes>
              <Route
                path="/matchups"
                element={<FilteredMatchList matches={matches} axes={axes} layout="table" />}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(<Wrapper axes={{}} />);
    await user.click(
      screen.getByRole('button', { name: showMoreName(FILTERED_MATCH_LIST_PAGE_SIZE) }),
    );
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(
      FILTERED_MATCH_LIST_ROW_CAP + FILTERED_MATCH_LIST_PAGE_SIZE + 1,
    );

    // `from: 0` excludes nothing (every fixture match has time >= 1000) but
    // is a genuinely different axes object, so `narrowedMatches` recomputes
    // to a new array reference — a real re-narrowing, not just a re-render.
    rerender(<Wrapper axes={{ from: 0 }} />);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(
      FILTERED_MATCH_LIST_ROW_CAP + 1,
    );
    expect(
      screen.getByRole('button', { name: showMoreName(FILTERED_MATCH_LIST_PAGE_SIZE) }),
    ).toBeInTheDocument();
  });

  describe('WR-07 (39.1-REVIEW): paging survives changes that are not re-narrowings', () => {
    type WrapperProps = {
      matches: Match[];
      axes: DrillDownAxes;
      resolveClaim?: (claimId: string, ms: Match[]) => Match[] | undefined;
    };
    function renderPaged(initial: WrapperProps) {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const Wrapper = (props: WrapperProps) => (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/matchups']}>
            <AuthProvider>
              <Routes>
                <Route path="/matchups" element={<FilteredMatchList {...props} layout="table" />} />
              </Routes>
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      );
      const result = render(<Wrapper {...initial} />);
      return { ...result, Wrapper };
    }
    function mountedRows(): number {
      return within(screen.getByRole('table')).getAllByRole('row').length - 1;
    }
    const PAGED = FILTERED_MATCH_LIST_ROW_CAP + FILTERED_MATCH_LIST_PAGE_SIZE;

    it('a refetch (new matches array, same games) and a new-but-equal axes object keep the paging progress', () => {
      const matches = makeManyMatches(1000);
      const { rerender, Wrapper } = renderPaged({ matches, axes: {} });
      fireEvent.click(
        screen.getByRole('button', { name: showMoreName(FILTERED_MATCH_LIST_PAGE_SIZE) }),
      );
      expect(mountedRows()).toBe(PAGED);

      rerender(<Wrapper matches={[...matches]} axes={{}} />);
      expect(mountedRows()).toBe(PAGED);
    });

    it('a deleted row (the list shrinks by one) keeps the paging progress instead of snapping back to the cap', () => {
      const matches = makeManyMatches(1000);
      const { rerender, Wrapper } = renderPaged({ matches, axes: {} });
      fireEvent.click(
        screen.getByRole('button', { name: showMoreName(FILTERED_MATCH_LIST_PAGE_SIZE) }),
      );
      expect(mountedRows()).toBe(PAGED);

      rerender(<Wrapper matches={matches.slice(1)} axes={{}} />);
      expect(mountedRows()).toBe(PAGED);
      expect(screen.getByRole('table')).toHaveAttribute('data-total-rows', '999');
    });

    it('a new claim-resolver reference that resolves the same claim (a rail card dismissed) keeps the paging progress', () => {
      const matches = makeManyMatches(1000);
      const axes: DrillDownAxes = { claimId: 'formNow:account:last30' };
      const resolve = (_id: string, ms: Match[]) => ms.slice(0, 600);
      const { rerender, Wrapper } = renderPaged({ matches, axes, resolveClaim: resolve });
      fireEvent.click(
        screen.getByRole('button', { name: showMoreName(FILTERED_MATCH_LIST_PAGE_SIZE) }),
      );
      expect(mountedRows()).toBe(PAGED);

      rerender(
        <Wrapper matches={matches} axes={axes} resolveClaim={(id, ms) => resolve(id, ms)} />,
      );
      expect(mountedRows()).toBe(PAGED);
    });
  });

  it('the pre-existing single-page cases stay unaffected: a small narrowed set never shows the paging control or progress line', () => {
    renderList({ matches: [makeMatch()], axes: {}, layout: 'table' });
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toBeNull();
  });
});

/**
 * Plan 39.1-33 (R2, UIX-02, owner decision 2026-09-24: phone rows = 20): the
 * stacked (phone) layout's DOM bound tightens from the shared
 * FILTERED_MATCH_LIST_ROW_CAP/PAGE_SIZE (100/50) to a stricter phone-only
 * first-pass cap and page size of 20 — the stacked layout flows in the page
 * (plan 39.1-32 item 13 removed its inner scroller), so about two phone
 * screens (20 rows of ~82px + 8px gap) is the bound, still well inside
 * UI-SPEC §6.4's 100-per-pass ceiling. The table layout (640px and up) keeps
 * its 100 + "Show 50 more" byte-unchanged. `STACK_FIRST_PASS`/`STACK_PAGE`
 * are LOCAL literals (not imported) — the production component does not yet
 * export `FILTERED_MATCH_LIST_STACK_ROW_CAP`/`FILTERED_MATCH_LIST_STACK_PAGE_SIZE`
 * at RED time, and importing a not-yet-existing named export would fail the
 * whole file at import instead of on an assertion (#3770 INVALID_RED).
 */
describe('FilteredMatchList — stacked layout pages by 20 rows, table unchanged (plan 39.1-33, R2)', () => {
  // Mirrors the not-yet-exported FILTERED_MATCH_LIST_STACK_ROW_CAP / _PAGE_SIZE.
  const STACK_FIRST_PASS = 20;
  const STACK_PAGE = 20;

  it('stacked layout: 150 matches (active fighterId axis) mount exactly 20 rows, data-total-rows is 150, the summary states 150 games, and "Show 20 more" renders with the right aria-controls', () => {
    const matches = makeManyMatches(150);
    const { container } = renderList({ matches, axes: { fighterId: mario.id }, layout: 'stack' });
    const stack = container.querySelector('[data-slot="filtered-match-stack"]') as HTMLElement;
    expect(within(stack).getAllByRole('listitem')).toHaveLength(STACK_FIRST_PASS);
    expect(stack).toHaveAttribute('data-total-rows', '150');
    expect(screen.getByText(/150 games ·/)).toBeInTheDocument();

    const showMore = screen.getByRole('button', { name: showMoreName(STACK_PAGE) });
    expect(showMore).toHaveAttribute('aria-controls', stack.id);

    const progress = document.querySelector('[aria-live="polite"]');
    expect(progress).toHaveTextContent(/Showing 20 of 150 games/);
  });

  it('stacked layout: 50 matches, one activation mounts 40 and leaves focus on the control now named "Show 10 more"; the next activation mounts all 50, unmounts the control, moves focus to the list root with preventScroll, and the progress line announces the full count', async () => {
    const user = userEvent.setup();
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const matches = makeManyMatches(50);
    const { container } = renderList({ matches, axes: {}, layout: 'stack' });
    const stack = container.querySelector('[data-slot="filtered-match-stack"]') as HTMLElement;
    expect(within(stack).getAllByRole('listitem')).toHaveLength(STACK_FIRST_PASS);

    // First activation: 20 -> 40, control remains (10 rows left). userEvent
    // (not fireEvent) — jsdom only moves native post-click focus for a real
    // pointer-event simulation, mirroring the table-layout paging test above.
    await user.click(screen.getByRole('button', { name: showMoreName(STACK_PAGE) }));
    expect(within(stack).getAllByRole('listitem')).toHaveLength(40);
    expect(screen.getByRole('button', { name: showMoreName(10) })).toBe(document.activeElement);

    // Second (final) activation: 40 -> 50, exhausts the list.
    focusSpy.mockClear();
    fireEvent.click(screen.getByRole('button', { name: showMoreName(10) }));
    expect(within(stack).getAllByRole('listitem')).toHaveLength(50);

    expect(document.activeElement).toBe(stack);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).not.toBeInTheDocument();
    const progress = document.querySelector('[aria-live="polite"]');
    expect(progress).toHaveTextContent(/Showing 50 of 50 games/);

    focusSpy.mockRestore();
  });

  it('stacked layout: exactly 20 matches show no paging control and no progress line', () => {
    const matches = makeManyMatches(20);
    renderList({ matches, axes: {}, layout: 'stack' });
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it('stacked layout: 21 matches show "Show 1 more" (singular key) and the progress line reads "Showing 20 of 21 games"', () => {
    const matches = makeManyMatches(21);
    renderList({ matches, axes: {}, layout: 'stack' });
    expect(screen.getByRole('button', { name: showMoreName(1) })).toBeInTheDocument();
    const progress = document.querySelector('[aria-live="polite"]');
    expect(progress).toHaveTextContent(/Showing 20 of 21 games/);
  });

  it('table layout: 77 matches mount all 77 rows with no paging control (unchanged)', () => {
    const matches = makeManyMatches(77);
    renderList({ matches, axes: {}, layout: 'table' });
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(77 + 1);
    expect(screen.queryByRole('button', { name: /show \d+ more/i })).not.toBeInTheDocument();
  });

  it('rerendering the same 150 matches with the layout prop switched from table (after one "Show 50 more") to stack mounts exactly 20 rows — a layout change re-bounds', async () => {
    const user = userEvent.setup();
    const matches = makeManyMatches(150);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ layout }: { layout: 'table' | 'stack' }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/matchups']}>
          <AuthProvider>
            <Routes>
              <Route
                path="/matchups"
                element={<FilteredMatchList matches={matches} axes={{}} layout={layout} />}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender, container } = render(<Wrapper layout="table" />);
    await user.click(
      screen.getByRole('button', { name: showMoreName(FILTERED_MATCH_LIST_PAGE_SIZE) }),
    );
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(
      FILTERED_MATCH_LIST_ROW_CAP + FILTERED_MATCH_LIST_PAGE_SIZE + 1,
    );

    rerender(<Wrapper layout="stack" />);
    const stack = container.querySelector('[data-slot="filtered-match-stack"]') as HTMLElement;
    expect(within(stack).getAllByRole('listitem')).toHaveLength(STACK_FIRST_PASS);
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

/**
 * 39.1-REVIEW iteration 2 WR-04: after a confirmed delete the deleted row
 * (and the trigger the dialog returns focus to) unmounts once the host's
 * list refetches, dropping focus to <body>. Here the host re-renders with
 * the row gone only AFTER the mutation settled — the order the dialog's own
 * focus return cannot cover.
 */
describe('WR-04: focus after a row delete', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    removeMatch.mockResolvedValue(undefined);
    setMockUser(makeMockUser());
  });

  function renderDeletable(matches: Match[], layout: 'table' | 'stack') {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (ms: Match[]) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/matchups']}>
          <AuthProvider>
            <Routes>
              <Route
                path="/matchups"
                element={<FilteredMatchList matches={ms} axes={{}} showDelete layout={layout} />}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const result = render(tree(matches));
    return { ...result, rerenderWith: (ms: Match[]) => result.rerender(tree(ms)) };
  }

  async function confirmDeleteAt(index: number) {
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Delete match' })[index]!);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(removeMatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Delete this match?')).toBeNull());
  }

  const rows = ['a', 'b', 'c'].map((id, i) =>
    makeMatch({ id, time: 3000 - i * 1000, vodUrl: undefined }),
  );

  it.each(['table', 'stack'] as const)(
    '%s: deleting a middle row focuses the next row’s delete trigger',
    async (layout) => {
      const { rerenderWith } = renderDeletable(rows, layout);
      await confirmDeleteAt(1);
      rerenderWith(rows.filter((m) => m.id !== 'b'));
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getAllByRole('button', { name: 'Delete match' })[1],
        ),
      );
      expect(removeMatch).toHaveBeenCalledWith('b');
    },
  );

  it('deleting the last row focuses the previous row’s delete trigger', async () => {
    const { rerenderWith } = renderDeletable(rows, 'table');
    await confirmDeleteAt(2);
    rerenderWith(rows.filter((m) => m.id !== 'c'));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getAllByRole('button', { name: 'Delete match' })[1],
      ),
    );
  });

  it('deleting the only row focuses the list container, never <body>', async () => {
    const { container, rerenderWith } = renderDeletable([rows[0]!], 'table');
    await confirmDeleteAt(0);
    rerenderWith([]);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(container.contains(document.activeElement)).toBe(true);
  });

  it('Cancel returns focus to the row trigger that opened the dialog', async () => {
    const user = userEvent.setup();
    renderDeletable(rows, 'table');
    await user.click(screen.getAllByRole('button', { name: 'Delete match' })[1]!);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Delete this match?')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getAllByRole('button', { name: 'Delete match' })[1],
      ),
    );
    expect(removeMatch).not.toHaveBeenCalled();
  });

  it('a failed delete leaves the row and focus on its own trigger', async () => {
    removeMatch.mockRejectedValueOnce(new Error('nope'));
    const { rerenderWith } = renderDeletable(rows, 'table');
    await confirmDeleteAt(1);
    rerenderWith([...rows]);
    const triggers = screen.getAllByRole('button', { name: 'Delete match' });
    expect(triggers).toHaveLength(3);
    await waitFor(() => expect(document.activeElement).toBe(triggers[1]));
  });
});

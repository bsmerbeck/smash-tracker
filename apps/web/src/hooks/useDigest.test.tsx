import { StrictMode, useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router';
import { stateClassFor, type DigestStateClass, type Match } from '@smash-tracker/shared';
import { analyticsDigestStorageKey, writeStoredDigest } from '@/lib/analyticsDigest';
import { useDigest } from './useDigest';

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));

interface MatchesState {
  allMatches: Match[];
  isLoading: boolean;
  isFetching: boolean;
}
let matchesState: MatchesState;
vi.mock('@/hooks/useFilteredMatches', () => ({ useFilteredMatches: () => matchesState }));

interface WatchlistState {
  data: { items: { itemKey: string; item: Record<string, unknown> }[] } | undefined;
  isSuccess: boolean;
  isError: boolean;
  isPending: boolean;
}
let watchlistState: WatchlistState;
vi.mock('@/hooks/useWatchlist', () => ({ useWatchlist: () => watchlistState }));
vi.mock('@/hooks/useOpponentAliases', () => ({ useOpponentAliases: () => ({ data: {} }) }));

function watchlistOf(...refs: string[]): WatchlistState {
  return {
    data: {
      items: refs.map((ref, i) => ({
        itemKey: `opponent:${ref}`,
        item: { kind: 'opponent', ref, createdAt: i + 1 },
      })),
    },
    isSuccess: true,
    isError: false,
    isPending: false,
  };
}

function game(id: string, time: number, eventName?: string): Match {
  return { id, time, win: true, fighter_id: 1, opponent_id: 2, eventName } as Match;
}

function games(count: number, eventName?: (i: number) => string | undefined, t0 = 1_000): Match[] {
  return Array.from({ length: count }, (_, i) => game(`g-${i}`, t0 + i * 10, eventName?.(i)));
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/dashboard']}>{children}</MemoryRouter>;
}

/**
 * A settled hook writes on its real unmount through a zero-delay timer. RTL unmounts after
 * each test, so the next test's `setItem` spy would otherwise hear the PREVIOUS test's write.
 * Unmount and let the timer fire before the spy is restored.
 */
afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  vi.restoreAllMocks();
});

describe('useDigest (counts)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    matchesState = { allMatches: [], isLoading: false, isFetching: false };
    watchlistState = watchlistOf();
  });

  it('a first visit on a device reads as start and shows no counts', () => {
    matchesState.allMatches = games(12);
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.status).toBe('start');
    expect(result.current.newGames).toBe(0);
    expect(result.current.since).toBeNull();
    expect(result.current.canMarkAsRead).toBe(false);
  });

  it('a corrupt store reads as a first visit', () => {
    window.localStorage.setItem(analyticsDigestStorageKey('u1', null), 'not json');
    matchesState.allMatches = games(12);
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.status).toBe('start');
  });

  it('reads nothing from storage while the match query is loading', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    matchesState = { allMatches: [], isLoading: true, isFetching: true };
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.status).toBe('loading');
    expect(get).not.toHaveBeenCalled();
  });

  it('stored count 10 with 51 matches is 41 new games, expanded', () => {
    writeStoredDigest('u1', null, { lastSeenAt: 5_000, lastSeenMatchCount: 10, tracked: {} });
    matchesState.allMatches = games(51);
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.status).toBe('expanded');
    expect(result.current.newGames).toBe(41);
    expect(result.current.since).toBe(5_000);
  });

  it('counts new events from the subject matches only: first game later than lastSeenAt', () => {
    writeStoredDigest('u1', null, { lastSeenAt: 1_045, lastSeenMatchCount: 10, tracked: {} });
    // t = 1000..1140. Event "Old" starts at 1000 (before lastSeenAt); "New A" and "New B" start after.
    const matches = games(15, (i) => (i < 5 ? 'Old' : i < 10 ? 'New A' : 'New B'));
    matchesState.allMatches = matches;
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.newEvents).toBe(2);
    expect(result.current.newGames).toBe(5);
  });

  it('nothing new is quiet with no way to mark as read', () => {
    writeStoredDigest('u1', null, { lastSeenAt: 9_999, lastSeenMatchCount: 12, tracked: {} });
    matchesState.allMatches = games(12);
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.status).toBe('quiet');
    expect(result.current.canMarkAsRead).toBe(false);
    expect(result.current.since).toBe(9_999);
  });

  it('freezes the stored snapshot for the visit: a refetch adding games does not re-read storage', () => {
    writeStoredDigest('u1', null, { lastSeenAt: 5_000, lastSeenMatchCount: 10, tracked: {} });
    matchesState.allMatches = games(12);
    const { result, rerender } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.newGames).toBe(2);
    // Something else overwrites the store mid-visit; the visit's comparison point must not move.
    writeStoredDigest('u1', null, { lastSeenAt: 8_000, lastSeenMatchCount: 12, tracked: {} });
    matchesState = { ...matchesState, allMatches: games(14) };
    rerender();
    expect(result.current.newGames).toBe(4);
    expect(result.current.since).toBe(5_000);
  });

  it('Mark as read writes once, flips to quiet, and is unavailable while fetching', () => {
    writeStoredDigest('u1', null, { lastSeenAt: 5_000, lastSeenMatchCount: 10, tracked: {} });
    matchesState = { allMatches: games(51), isLoading: false, isFetching: true };
    const { result, rerender } = renderHook(() => useDigest(), { wrapper });
    const set = vi.spyOn(Storage.prototype, 'setItem');

    expect(result.current.canMarkAsRead).toBe(false);
    act(() => result.current.markAsRead());
    expect(set).not.toHaveBeenCalled();

    matchesState = { ...matchesState, isFetching: false };
    rerender();
    expect(result.current.canMarkAsRead).toBe(true);
    act(() => result.current.markAsRead());
    expect(set).toHaveBeenCalledTimes(1);
    const written = JSON.parse(String(set.mock.calls[0]![1])) as {
      lastSeenMatchCount: number;
      tracked: object;
    };
    expect(set.mock.calls[0]![0]).toBe(analyticsDigestStorageKey('u1', null));
    expect(written.lastSeenMatchCount).toBe(51);
    expect(result.current.status).toBe('quiet');
    expect(result.current.canMarkAsRead).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 2: moved items (D-05) and the write discipline (T-03 / UI-SPEC G9)
// ---------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const STORED_AT = 5_000;

/**
 * 200 alternating games against `opponent` older than 30 days, then 30 games inside the last 30
 * days: `recentWins` of them won. 27 wins reads `up` at the digest's z, 3 reads `down`, and an
 * alternating 15 reads `steady` (plan 39.2-02's tracer numbers).
 */
function rivalHistory(opponent: string, recentWins: number, nowMs: number): Match[] {
  const older = Array.from({ length: 200 }, (_, i) =>
    game(`${opponent}-old-${i}`, nowMs - (231 - i) * DAY_MS, undefined),
  ).map((m, i) => ({ ...m, win: i % 2 === 0, opponent }));
  const recent = Array.from({ length: 30 }, (_, i) => ({
    ...game(`${opponent}-new-${i}`, nowMs - (30 - i) * DAY_MS + DAY_MS / 2, undefined),
    win: i < recentWins,
    opponent,
  }));
  return [...older, ...recent] as Match[];
}

function classOf(matches: Match[], ref: string): DigestStateClass {
  return stateClassFor({
    matches,
    item: { kind: 'opponent', ref, createdAt: 1 },
    nowMs: Date.now(),
  });
}

function storeSnapshot(tracked: Record<string, DigestStateClass>, count = 0) {
  writeStoredDigest('u1', null, { lastSeenAt: STORED_AT, lastSeenMatchCount: count, tracked });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('useDigest (moved items, D-05)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    matchesState = { allMatches: [], isLoading: false, isFetching: false };
    watchlistState = watchlistOf();
  });

  it('a steady item that is now up is listed as moved with the up token', () => {
    const matches = rivalHistory('mkleo', 27, Date.now());
    expect(classOf(matches, 'mkleo')).toBe('up');
    matchesState.allMatches = matches;
    watchlistState = watchlistOf('mkleo');
    storeSnapshot({ 'opponent:mkleo': 'steady' }, matches.length);
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.movedCount).toBe(1);
    expect(result.current.movedRows.map((row) => row.movedToken)).toEqual(['up']);
    expect(result.current.movedByItemKey.get('opponent:mkleo')?.token).toBe('up');
    // Nothing new in games or events, but a tracked item moved: the digest is not quiet.
    expect(result.current.status).toBe('expanded');
  });

  it('a steady item that is now down reads down; a thin item that is now steady is not a move', () => {
    const down = rivalHistory('down', 3, Date.now());
    const steady = rivalHistory('flat', 15, Date.now());
    expect(classOf(down, 'down')).toBe('down');
    expect(classOf(steady, 'flat')).toBe('steady');
    matchesState.allMatches = [...down, ...steady];
    watchlistState = watchlistOf('down', 'flat');
    storeSnapshot(
      { 'opponent:down': 'steady', 'opponent:flat': 'thin' },
      matchesState.allMatches.length,
    );
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.movedRows.map((row) => [row.itemKey, row.movedToken])).toEqual([
      ['opponent:down', 'down'],
    ]);
    expect(result.current.movedCount).toBe(1);
  });

  it('an item absent from the snapshot is never listed', () => {
    const matches = rivalHistory('mkleo', 27, Date.now());
    matchesState.allMatches = matches;
    watchlistState = watchlistOf('mkleo');
    storeSnapshot({}, matches.length - 1);
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.movedCount).toBe(0);
    expect(result.current.movedRows).toEqual([]);
    expect(result.current.newGames).toBe(1);
  });

  it('seven moved items show five rows and a count of two more', () => {
    const now = Date.now();
    const refs = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    matchesState.allMatches = refs.flatMap((ref) => rivalHistory(ref, 27, now));
    watchlistState = watchlistOf(...refs);
    storeSnapshot(
      Object.fromEntries(refs.map((ref) => [`opponent:${ref}`, 'steady' as const])),
      matchesState.allMatches.length,
    );
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.movedCount).toBe(7);
    expect(result.current.movedRows).toHaveLength(5);
    expect(result.current.moreCount).toBe(2);
    // The Tracked section still hears about ALL seven.
    expect(result.current.movedByItemKey.size).toBe(7);
  });

  it('while the tracked list is unresolved: moved is unknown, Mark as read is off, nothing is written', () => {
    const matches = rivalHistory('mkleo', 27, Date.now());
    matchesState.allMatches = matches;
    watchlistState = { data: undefined, isSuccess: false, isError: false, isPending: true };
    storeSnapshot({ 'opponent:mkleo': 'steady' }, matches.length - 3);
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const { result, unmount } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.status).toBe('expanded');
    expect(result.current.movedCount).toBeNull();
    expect(result.current.canMarkAsRead).toBe(false);
    act(() => result.current.markAsRead());
    unmount();
    return tick().then(() => expect(set).not.toHaveBeenCalled());
  });

  it('a failed tracked list carries the stored map forward instead of overwriting it with {}', () => {
    matchesState.allMatches = games(12);
    watchlistState = { data: undefined, isSuccess: false, isError: true, isPending: false };
    storeSnapshot({ 'opponent:mkleo': 'steady' }, 10);
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.movedCount).toBe(0);
    act(() => result.current.markAsRead());
    const written = JSON.parse(String(set.mock.calls[0]![1])) as { tracked: object };
    expect(written.tracked).toEqual({ 'opponent:mkleo': 'steady' });
  });

  it('Mark as read writes every current item class and collapses the moved list', () => {
    const matches = rivalHistory('mkleo', 27, Date.now());
    matchesState.allMatches = matches;
    watchlistState = watchlistOf('mkleo');
    storeSnapshot({ 'opponent:mkleo': 'steady' }, matches.length);
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useDigest(), { wrapper });
    expect(result.current.canMarkAsRead).toBe(true);
    act(() => result.current.markAsRead());
    expect(set).toHaveBeenCalledTimes(1);
    const written = JSON.parse(String(set.mock.calls[0]![1])) as { tracked: object };
    expect(written.tracked).toEqual({ 'opponent:mkleo': 'up' });
    expect(result.current.status).toBe('quiet');
    expect(result.current.movedRows).toEqual([]);
    expect(result.current.movedByItemKey.size).toBe(0);
  });
});

describe('useDigest write discipline (T-03, UI-SPEC G9)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    matchesState = { allMatches: games(12), isLoading: false, isFetching: false };
    watchlistState = watchlistOf();
    writeStoredDigest('u1', null, { lastSeenAt: STORED_AT, lastSeenMatchCount: 10, tracked: {} });
  });

  it('leaving the Dashboard with the match query settled writes exactly once, under the mount key', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const { unmount } = renderHook(() => useDigest(), { wrapper });
    await tick();
    expect(set).not.toHaveBeenCalled();
    unmount();
    await tick();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]![0]).toBe(analyticsDigestStorageKey('u1', null));
    const written = JSON.parse(String(set.mock.calls[0]![1])) as {
      lastSeenMatchCount: number;
      lastSeenAt: number;
    };
    expect(written.lastSeenMatchCount).toBe(12);
    expect(written.lastSeenAt).toBeGreaterThan(STORED_AT);
  });

  it('unmounting while the match query is fetching writes nothing, and the digest is still expanded on return', async () => {
    matchesState = { ...matchesState, isFetching: true };
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const first = renderHook(() => useDigest(), { wrapper });
    expect(first.result.current.status).toBe('expanded');
    first.unmount();
    await tick();
    expect(set).not.toHaveBeenCalled();

    const second = renderHook(() => useDigest(), { wrapper });
    expect(second.result.current.status).toBe('expanded');
    expect(second.result.current.newGames).toBe(2);
  });

  it('a refetch that starts before the route leave cancels the pending write', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const { rerender, unmount } = renderHook(() => useDigest(), { wrapper });
    matchesState = { ...matchesState, isFetching: true };
    rerender();
    unmount();
    await tick();
    expect(set).not.toHaveBeenCalled();
  });

  function DigestHost() {
    useDigest();
    return null;
  }

  it('a StrictMode synthetic unmount writes nothing while mounted', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const { unmount } = render(
      <StrictMode>
        <MemoryRouter>
          <DigestHost />
        </MemoryRouter>
      </StrictMode>,
    );
    await tick();
    expect(set).not.toHaveBeenCalled();
    // Control: the same tree DOES write when it is really left, so the zero above is the discipline and not a dead effect.
    unmount();
    await tick();
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('FAILING CONTROL: a naive cleanup-write is caught by the same StrictMode harness', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    function NaiveHost() {
      const { isFetching, allMatches } = matchesState;
      useEffect(() => {
        if (isFetching) return undefined;
        return () => {
          writeStoredDigest('u1', null, {
            lastSeenAt: Date.now(),
            lastSeenMatchCount: allMatches.length,
            tracked: {},
          });
        };
      }, [isFetching, allMatches.length]);
      return null;
    }
    render(
      <StrictMode>
        <NaiveHost />
      </StrictMode>,
    );
    await tick();
    // The synthetic unmount fires the naive cleanup while the page is still mounted.
    expect(set.mock.calls.length).toBeGreaterThan(0);
  });

  describe('switching subject by navigation (T-39.2-49)', () => {
    let navigate: NavigateFunction;
    function Nav() {
      navigate = useNavigate();
      return null;
    }
    const routed = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/dashboard']}>
        <Nav />
        {children}
      </MemoryRouter>
    );
    const KEY_A = analyticsDigestStorageKey('u1', null);
    const KEY_B = analyticsDigestStorageKey('u1', 'client-b');

    it('with a refetch in flight, switching from A to B writes nothing under either key', async () => {
      matchesState = { allMatches: games(12), isLoading: false, isFetching: true };
      const set = vi.spyOn(Storage.prototype, 'setItem');
      const { unmount } = renderHook(() => useDigest(), { wrapper: routed });
      await act(async () => navigate('/coach/client-b/dashboard'));
      await tick();
      expect(set).not.toHaveBeenCalled();
      unmount();
      await tick();
      expect(set).not.toHaveBeenCalled();
    });

    it('settled on both subjects: A is written under A with A data, B under B with B data, never crossed', async () => {
      const set = vi.spyOn(Storage.prototype, 'setItem');
      const { unmount } = renderHook(() => useDigest(), { wrapper: routed });
      await tick();
      expect(set).not.toHaveBeenCalled();

      // Subject B's own data arrives with the navigation.
      matchesState = { allMatches: games(30), isLoading: false, isFetching: false };
      await act(async () => navigate('/coach/client-b/dashboard'));
      await tick();
      unmount();
      await tick();

      const calls = set.mock.calls.map((call) => ({
        key: String(call[0]),
        count: (JSON.parse(String(call[1])) as { lastSeenMatchCount: number }).lastSeenMatchCount,
      }));
      expect(calls).toEqual([
        { key: KEY_A, count: 12 },
        { key: KEY_B, count: 30 },
      ]);
    });
  });
});

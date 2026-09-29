import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import type { Match } from '@smash-tracker/shared';
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

function game(id: string, time: number, eventName?: string): Match {
  return { id, time, win: true, fighter_id: 1, opponent_id: 2, eventName } as Match;
}

function games(count: number, eventName?: (i: number) => string | undefined, t0 = 1_000): Match[] {
  return Array.from({ length: count }, (_, i) => game(`g-${i}`, t0 + i * 10, eventName?.(i)));
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/dashboard']}>{children}</MemoryRouter>;
}

describe('useDigest (counts)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    matchesState = { allMatches: [], isLoading: false, isFetching: false };
  });
  afterEach(() => vi.restoreAllMocks());

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

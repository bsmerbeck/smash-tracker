import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import {
  WATCHLIST_MAX_ITEMS,
  buildWatchlistItemKey,
  type WatchlistResponse,
  type WatchlistTrackInput,
} from '@smash-tracker/shared';
import { subjectScope } from '@/lib/subjectQueryKey';
import {
  parseTrackInput,
  useIsTracked,
  useTrackWatchlistItem,
  useUntrackWatchlistItem,
  useWatchlist,
  watchlistQueryKey,
} from './useWatchlist';

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { uid: 'coach-uid' } }) }));

const { list, track, untrack } = vi.hoisted(() => ({
  list: vi.fn(),
  track: vi.fn(),
  untrack: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, watchlist: { list, track, untrack } } };
});

const toastFn = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign((...args: unknown[]) => toastFn(...args), {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  }),
}));

import { ApiError } from '@/lib/api';

const OWN_SUBJECT = { mode: 'personal', clientId: null } as const;
const CLIENT_SUBJECT = { mode: 'coaching', clientId: 'client-1' } as const;

const STAGE_INPUT: WatchlistTrackInput = { kind: 'stage', ref: 113 };
const MATCHUP_INPUT: WatchlistTrackInput = {
  kind: 'matchup',
  ref: { fighterId: 1, vsFighterId: 2 },
};

function emptyList(): WatchlistResponse {
  return { items: [] };
}

function fullList(): WatchlistResponse {
  return {
    items: Array.from({ length: WATCHLIST_MAX_ITEMS }, (_, index) => ({
      itemKey: `stage:${index + 1}`,
      item: { kind: 'stage' as const, ref: index + 1, createdAt: 1000 + index },
    })),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.hash}`}</div>;
}

function makeWrapper(queryClient: QueryClient, path: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={queryClient}>
          {children}
          <LocationProbe />
        </QueryClientProvider>
      </MemoryRouter>
    );
  };
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Mounts every hook; the buttons drive the real mutations. */
function Probe() {
  const query = useWatchlist();
  const trackMutation = useTrackWatchlistItem();
  const untrackMutation = useUntrackWatchlistItem();
  const stage = useIsTracked('stage', 113);
  return (
    <div>
      <div data-testid="status">{query.status}</div>
      <div data-testid="keys">{query.data?.items.map((entry) => entry.itemKey).join(',')}</div>
      <div data-testid="stage-ready">{String(stage.ready)}</div>
      <div data-testid="stage-tracked">{String(stage.tracked)}</div>
      <button
        data-testid="track-stage"
        onClick={() => trackMutation.mutate({ input: STAGE_INPUT, name: 'Battlefield' })}
      />
      <button
        data-testid="track-matchup"
        onClick={() => trackMutation.mutate({ input: MATCHUP_INPUT, name: 'Mario vs Luigi' })}
      />
      <button
        data-testid="untrack-stage"
        onClick={() => untrackMutation.mutate({ itemKey: 'stage:113', name: 'Battlefield' })}
      />
    </div>
  );
}

function mountProbe(queryClient: QueryClient, path: string): void {
  render(<Probe />, { wrapper: makeWrapper(queryClient, path) });
}

function press(testId: string): void {
  act(() => screen.getByTestId(testId).click());
}

describe('useWatchlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(emptyList());
    track.mockResolvedValue({ itemKey: 'stage:113', item: { ...STAGE_INPUT, createdAt: 5 } });
    untrack.mockResolvedValue({ itemKey: 'stage:113' });
  });

  it('keys the query by the subject: an own-account list and a client list never share an entry', () => {
    expect(watchlistQueryKey(OWN_SUBJECT)).toEqual([...subjectScope(OWN_SUBJECT), 'watchlist']);
    expect(watchlistQueryKey(CLIENT_SUBJECT)).toEqual([
      ...subjectScope(CLIENT_SUBJECT),
      'watchlist',
    ]);
    expect(watchlistQueryKey(OWN_SUBJECT)).toEqual(['personal', 'watchlist']);
    expect(watchlistQueryKey(CLIENT_SUBJECT)).toEqual(['client', 'client-1', 'watchlist']);
  });

  it('reads into the own-account key on an own route and the client key on a coach route', async () => {
    const own = newClient();
    mountProbe(own, '/dashboard');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('success'));
    expect(own.getQueryData(watchlistQueryKey(OWN_SUBJECT))).toEqual(emptyList());
    expect(own.getQueryData(watchlistQueryKey(CLIENT_SUBJECT))).toBeUndefined();
  });

  it('reads into the client key, and only the client key, under /coach/:clientId', async () => {
    const client = newClient();
    mountProbe(client, '/coach/client-1/dashboard');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('success'));
    expect(client.getQueryData(watchlistQueryKey(CLIENT_SUBJECT))).toEqual(emptyList());
    expect(client.getQueryData(watchlistQueryKey(OWN_SUBJECT))).toBeUndefined();
  });

  it('invalidates EXACTLY the own-account key after a track (the key itself, production-gap #9)', async () => {
    const queryClient = newClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    mountProbe(queryClient, '/dashboard');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('success'));

    press('track-stage');
    await waitFor(() => expect(track).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...subjectScope(OWN_SUBJECT), 'watchlist'],
    });
    for (const call of invalidate.mock.calls) {
      expect(call[0]).toEqual({ queryKey: ['personal', 'watchlist'] });
    }
  });

  it('invalidates EXACTLY the client key after a track and after an untrack under a client subject', async () => {
    const queryClient = newClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    mountProbe(queryClient, '/coach/client-1/dashboard');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('success'));

    press('track-stage');
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    press('untrack-stage');
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));

    for (const call of invalidate.mock.calls) {
      expect(call[0]).toEqual({ queryKey: [...subjectScope(CLIENT_SUBJECT), 'watchlist'] });
      expect(call[0]).toEqual({ queryKey: ['client', 'client-1', 'watchlist'] });
    }
  });

  it('applies a track optimistically to the subject key and reflects it through useIsTracked', async () => {
    let releaseTrack: (value: unknown) => void = () => undefined;
    track.mockReturnValueOnce(new Promise((resolve) => (releaseTrack = resolve)));
    const queryClient = newClient();
    mountProbe(queryClient, '/dashboard');
    await waitFor(() => expect(screen.getByTestId('stage-ready').textContent).toBe('true'));
    expect(screen.getByTestId('stage-tracked').textContent).toBe('false');

    press('track-stage');
    await waitFor(() => expect(screen.getByTestId('stage-tracked').textContent).toBe('true'));
    releaseTrack({ itemKey: 'stage:113', item: { ...STAGE_INPUT, createdAt: 5 } });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Tracking Battlefield.'));
  });

  it('untracks optimistically and announces it', async () => {
    list.mockResolvedValue({
      items: [{ itemKey: 'stage:113', item: { ...STAGE_INPUT, createdAt: 5 } }],
    });
    mountProbe(newClient(), '/dashboard');
    await waitFor(() => expect(screen.getByTestId('stage-tracked').textContent).toBe('true'));

    list.mockResolvedValue(emptyList());
    press('untrack-stage');
    await waitFor(() => expect(untrack).toHaveBeenCalledWith('stage:113'));
    await waitFor(() => expect(screen.getByTestId('stage-tracked').textContent).toBe('false'));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('No longer tracking Battlefield.'),
    );
  });

  it('a 409 watchlist-full restores the previous cache and offers "Manage tracked" for an own account', async () => {
    const full = fullList();
    list.mockResolvedValue(full);
    track.mockRejectedValueOnce(
      new ApiError(409, 'Tracked list is full', { code: 'watchlist-full', message: 'x' }),
    );
    const queryClient = newClient();
    mountProbe(queryClient, '/dashboard');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('success'));
    const before = JSON.stringify(queryClient.getQueryData(watchlistQueryKey(OWN_SUBJECT)));

    press('track-stage');
    await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1));

    expect(JSON.stringify(queryClient.getQueryData(watchlistQueryKey(OWN_SUBJECT)))).toBe(before);
    expect(screen.getByTestId('keys').textContent).not.toContain('stage:113');
    expect(toastError).not.toHaveBeenCalled();
    const [message, options] = toastFn.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe('Tracked list is full — 25 of 25. Untrack something first.');
    expect(options.action.label).toBe('Manage tracked');

    act(() => options.action.onClick());
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/dashboard#tracked'),
    );
  });

  it('the manage action lands on the subject-aware dashboard under a client subject', async () => {
    list.mockResolvedValue(fullList());
    track.mockRejectedValueOnce(
      new ApiError(409, 'Tracked list is full', { code: 'watchlist-full' }),
    );
    mountProbe(newClient(), '/coach/client-1/matchups');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('success'));

    press('track-matchup');
    await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1));
    const [, options] = toastFn.mock.calls[0] as [string, { action: { onClick: () => void } }];
    act(() => options.action.onClick());
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/coach/client-1/dashboard#tracked'),
    );
  });

  it('a generic 500 rolls back and shows the error toast, never the full-list message', async () => {
    track.mockRejectedValueOnce(new ApiError(500, 'Internal Server Error'));
    const queryClient = newClient();
    mountProbe(queryClient, '/dashboard');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('success'));

    press('track-stage');
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't update the tracked list. Try again."),
    );
    expect(toastFn).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(watchlistQueryKey(OWN_SUBJECT))).toEqual(emptyList());
  });

  it('a 409 without the watchlist-full code is the generic error, not the full-list message', async () => {
    track.mockRejectedValueOnce(new ApiError(409, 'Conflict', { code: 'something-else' }));
    mountProbe(newClient(), '/dashboard');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('success'));

    press('track-stage');
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastFn).not.toHaveBeenCalled();
  });

  it('useIsTracked is not ready while the list is pending and never reads an unloaded list as untracked-and-ready', async () => {
    list.mockReturnValue(new Promise(() => undefined));
    mountProbe(newClient(), '/dashboard');
    expect(screen.getByTestId('status').textContent).toBe('pending');
    expect(screen.getByTestId('stage-ready').textContent).toBe('false');
  });

  it('useIsTracked is not ready when the list query errored', async () => {
    list.mockRejectedValue(new ApiError(500, 'boom'));
    mountProbe(newClient(), '/dashboard');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
    expect(screen.getByTestId('stage-ready').textContent).toBe('false');
  });
});

describe('parseTrackInput', () => {
  it('canonicalises an opponent tag and derives the same key the server will', () => {
    const input = parseTrackInput('opponent', '  MkLeo ');
    expect(input).toEqual({ kind: 'opponent', ref: 'mkleo' });
    expect(input && buildWatchlistItemKey(input)).toBe('opponent:mkleo');
  });

  it('returns null for a ref the server would refuse', () => {
    expect(parseTrackInput('opponent', 'a.b')).toBeNull();
    expect(parseTrackInput('opponent', '   ')).toBeNull();
    expect(parseTrackInput('stage', 0)).toBeNull();
    expect(parseTrackInput('stage', undefined)).toBeNull();
    expect(parseTrackInput('matchup', { fighterId: 1, vsFighterId: 0 })).toBeNull();
  });
});

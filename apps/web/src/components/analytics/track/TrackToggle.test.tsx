import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { WATCHLIST_MAX_ITEMS } from '@smash-tracker/shared';
import { watchlistQueryKey } from '@/hooks/useWatchlist';
import { TrackToggle, type TrackToggleProps } from './TrackToggle';

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'user-1' } }) }));

const toastFn = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign((...args: unknown[]) => toastFn(...args), {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  }),
}));

interface StoredItem {
  itemKey: string;
  item: { kind: string; ref: unknown; createdAt: number };
}

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A server-side list plus the per-request handlers each test can override. */
let serverItems: StoredItem[] = [];
let putResponse: () => Response = () => jsonResponse({}, 500);
let getResponse: () => Response | Promise<Response> = () => jsonResponse({ items: serverItems });

/** The subject's alias map and games, served for the identity hop (39.2-REVIEW WEB-WR-04). */
let aliasMap: Record<string, string> = {};
let serverMatches: unknown[] = [];

function installServer() {
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    const method = String(init.method);
    if (method === 'GET' && String(url).includes('/api/opponents/aliases')) {
      return Promise.resolve(jsonResponse(aliasMap));
    }
    if (method === 'GET' && String(url).includes('/api/matches')) {
      return Promise.resolve(jsonResponse(serverMatches));
    }
    if (method === 'GET') {
      return Promise.resolve(getResponse());
    }
    if (method === 'PUT') {
      return Promise.resolve(putResponse());
    }
    const key = decodeURIComponent(url.split('/api/watchlist/items/')[1] ?? '');
    return Promise.resolve(jsonResponse({ itemKey: key }));
  });
}

function requests(method: string): { url: string; body: unknown }[] {
  return fetchMock.mock.calls
    .filter((call) => String((call[1] as RequestInit).method) === method)
    .map((call) => {
      const init = call[1] as RequestInit;
      return { url: String(call[0]), body: init.body ? JSON.parse(String(init.body)) : undefined };
    });
}

/** The watchlist reads only: the toggle also reads the games and alias map for the identity hop. */
function watchlistGets(): { url: string }[] {
  return requests('GET').filter((request) => request.url.includes('/api/watchlist'));
}

function fullList(): StoredItem[] {
  return Array.from({ length: WATCHLIST_MAX_ITEMS }, (_, index) => ({
    itemKey: `stage:${index + 1}`,
    item: { kind: 'stage', ref: index + 1, createdAt: 1000 + index },
  }));
}

function renderToggle(props: TrackToggleProps, path = '/opponents/mkleo') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <TrackToggle {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

const MKLEO: TrackToggleProps = { kind: 'opponent', itemRef: 'mkleo', name: 'MkLeo' };

describe('TrackToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    serverItems = [];
    aliasMap = {};
    serverMatches = [];
    putResponse = () => jsonResponse({}, 500);
    getResponse = () => jsonResponse({ items: serverItems });
    installServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('always shows its word beside the icon, never icon-only, and starts unpressed', async () => {
    renderToggle(MKLEO);
    const toggle = await screen.findByRole('button', { name: 'Track MkLeo' });
    expect(toggle).toHaveTextContent('Track');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(toggle).toBeEnabled());
  });

  it('is disabled and sends NO write while the list query is pending (production-gap #8)', async () => {
    getResponse = () => new Promise<Response>(() => undefined);
    const user = userEvent.setup();
    renderToggle(MKLEO);
    const toggle = await screen.findByRole('button', { name: 'Track MkLeo' });
    expect(toggle).toBeDisabled();

    await user.click(toggle);

    expect(requests('PUT')).toHaveLength(0);
    expect(requests('DELETE')).toHaveLength(0);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('is disabled and sends NO write when the list query errored', async () => {
    getResponse = () => jsonResponse({ error: 'x', message: 'boom', statusCode: 500 }, 500);
    const user = userEvent.setup();
    renderToggle(MKLEO);
    const toggle = await screen.findByRole('button', { name: 'Track MkLeo' });
    await waitFor(() => expect(watchlistGets()).toHaveLength(1));
    await waitFor(() => expect(toggle).toBeDisabled());

    await user.click(toggle);

    expect(requests('PUT')).toHaveLength(0);
  });

  it('press issues ONE PUT with kind + canonical ref, and reads Tracked once the list holds it', async () => {
    putResponse = () => {
      serverItems = [
        { itemKey: 'opponent:mkleo', item: { kind: 'opponent', ref: 'mkleo', createdAt: 7 } },
      ];
      return jsonResponse(serverItems[0]);
    };
    const user = userEvent.setup();
    renderToggle({ kind: 'opponent', itemRef: '  MkLeo ', name: 'MkLeo' });
    const toggle = await screen.findByRole('button', { name: 'Track MkLeo' });
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(toggle);

    await waitFor(() => expect(requests('PUT')).toHaveLength(1));
    expect(requests('PUT')[0]).toEqual({
      url: expect.stringContaining('/api/watchlist/items'),
      body: { kind: 'opponent', ref: 'mkleo' },
    });
    const tracked = await screen.findByRole('button', { name: 'Stop tracking MkLeo' });
    expect(tracked).toHaveAttribute('aria-pressed', 'true');
    expect(tracked).toHaveTextContent('Tracked');
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Tracking MkLeo.'));
  });

  it('a pressed toggle DELETEs the URL-encoded derived key', async () => {
    serverItems = [
      { itemKey: 'opponent:mkleo', item: { kind: 'opponent', ref: 'mkleo', createdAt: 7 } },
    ];
    const user = userEvent.setup();
    renderToggle(MKLEO);
    const toggle = await screen.findByRole('button', { name: 'Stop tracking MkLeo' });
    await waitFor(() => expect(toggle).toBeEnabled());

    serverItems = [];
    await user.click(toggle);

    await waitFor(() => expect(requests('DELETE')).toHaveLength(1));
    expect(requests('DELETE')[0]?.url).toContain('/api/watchlist/items/opponent%3Amkleo');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Track MkLeo' })).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );
    expect(toastSuccess).toHaveBeenCalledWith('No longer tracking MkLeo.');
  });

  it('derives the matchup and stage refs into the PUT body', async () => {
    const user = userEvent.setup();
    putResponse = () => jsonResponse({ itemKey: 'stage:113', item: {} }, 500);

    const first = renderToggle({
      kind: 'matchup',
      itemRef: { fighterId: 3, vsFighterId: 7 },
      name: 'Donkey Kong vs Link',
    });
    const matchup = await screen.findByRole('button', { name: 'Track Donkey Kong vs Link' });
    await waitFor(() => expect(matchup).toBeEnabled());
    await user.click(matchup);
    await waitFor(() => expect(requests('PUT')).toHaveLength(1));
    expect(requests('PUT')[0]?.body).toEqual({
      kind: 'matchup',
      ref: { fighterId: 3, vsFighterId: 7 },
    });
    first.unmount();

    renderToggle({ kind: 'stage', itemRef: 113, name: 'Battlefield' });
    const stage = await screen.findByRole('button', { name: 'Track Battlefield' });
    await waitFor(() => expect(stage).toBeEnabled());
    await user.click(stage);
    await waitFor(() => expect(requests('PUT')).toHaveLength(2));
    expect(requests('PUT')[1]?.body).toEqual({ kind: 'stage', ref: 113 });
  });

  it('a failed write (500) reverts the toggle and shows the generic error, not the full-list message', async () => {
    putResponse = () => jsonResponse({ error: 'x', message: 'boom', statusCode: 500 }, 500);
    const user = userEvent.setup();
    renderToggle(MKLEO);
    const toggle = await screen.findByRole('button', { name: 'Track MkLeo' });
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(toggle);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't update the tracked list. Try again."),
    );
    expect(toastFn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Track MkLeo' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('the 26th item: the 409 leaves the toggle unpressed, the cached list unchanged, and offers Manage tracked', async () => {
    serverItems = fullList();
    putResponse = () =>
      jsonResponse(
        {
          error: 'Conflict',
          message: 'Watchlist is full',
          statusCode: 409,
          code: 'watchlist-full',
        },
        409,
      );
    const user = userEvent.setup();
    const { queryClient } = renderToggle(MKLEO);
    const toggle = await screen.findByRole('button', { name: 'Track MkLeo' });
    await waitFor(() => expect(toggle).toBeEnabled());
    const before = JSON.stringify(
      queryClient.getQueryData(watchlistQueryKey({ mode: 'personal', clientId: null })),
    );
    expect(JSON.parse(before).items).toHaveLength(WATCHLIST_MAX_ITEMS);

    await user.click(toggle);

    await waitFor(() => expect(requests('PUT')).toHaveLength(1));
    await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1));
    expect(toastFn.mock.calls[0]?.[0]).toBe(
      'Tracked list is full — 25 of 25. Untrack something first.',
    );
    expect(toastFn.mock.calls[0]?.[1]).toEqual({
      action: { label: 'Manage tracked', onClick: expect.any(Function) },
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Track MkLeo' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await waitFor(() =>
      expect(
        JSON.stringify(
          queryClient.getQueryData(watchlistQueryKey({ mode: 'personal', clientId: null })),
        ),
      ).toBe(before),
    );
    expect(requests('DELETE')).toHaveLength(0);
  });

  it.each([
    ['an opponent tag holding an RTDB path character', { kind: 'opponent', itemRef: 'a.b' }],
    ['the id-0 no-selection stage', { kind: 'stage', itemRef: 0 }],
    ['a missing ref', { kind: 'stage', itemRef: undefined }],
  ] as const)('renders nothing for %s', async (_label, props) => {
    renderToggle({ ...props, name: 'x' });
    await waitFor(() => expect(watchlistGets()).toHaveLength(1));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  describe('an alias-merged identity (39.2-REVIEW WEB-WR-04)', () => {
    it('reads Tracked for the resolved identity when the item was stored under a since-merged tag', async () => {
      aliasMap = { leo: 'mkleo' };
      serverItems = [
        { itemKey: 'opponent:leo', item: { kind: 'opponent', ref: 'leo', createdAt: 1 } },
      ];
      renderToggle(MKLEO);
      const toggle = await screen.findByRole('button', { name: 'Stop tracking MkLeo' });
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
    });

    it('untracking from the hub deletes every stored key of the identity, so no Dashboard row survives', async () => {
      aliasMap = { leo: 'mkleo' };
      serverItems = [
        { itemKey: 'opponent:leo', item: { kind: 'opponent', ref: 'leo', createdAt: 1 } },
        { itemKey: 'opponent:mkleo', item: { kind: 'opponent', ref: 'mkleo', createdAt: 2 } },
      ];
      const user = userEvent.setup();
      renderToggle(MKLEO);
      const toggle = await screen.findByRole('button', { name: 'Stop tracking MkLeo' });
      await waitFor(() => expect(toggle).toBeEnabled());
      await user.click(toggle);
      await waitFor(() => expect(requests('DELETE')).toHaveLength(2));
      const deleted = requests('DELETE')
        .map((request) => decodeURIComponent(request.url.split('/api/watchlist/items/')[1] ?? ''))
        .sort();
      expect(deleted).toEqual(['opponent:leo', 'opponent:mkleo']);
      expect(requests('PUT')).toHaveLength(0);
    });

    it('never spends a second slot: pressing after a merge sends no PUT', async () => {
      aliasMap = { leo: 'mkleo' };
      serverItems = [
        { itemKey: 'opponent:leo', item: { kind: 'opponent', ref: 'leo', createdAt: 1 } },
      ];
      const user = userEvent.setup();
      renderToggle(MKLEO);
      const toggle = await screen.findByRole('button', { name: /MkLeo/ });
      await waitFor(() => expect(toggle).toBeEnabled());
      await user.click(toggle);
      await waitFor(() => expect(requests('DELETE').length + requests('PUT').length).toBe(1));
      expect(requests('PUT')).toHaveLength(0);
    });
  });
});

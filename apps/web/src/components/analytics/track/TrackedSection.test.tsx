import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import i18n from '@/i18n';
import {
  INSIGHT_TEMPLATES,
  trackedItemScope,
  type DigestMovedToken,
  type HorizonKey,
  type Match,
} from '@smash-tracker/shared';
import { toast } from 'sonner';
import { deltaChipView } from '@/components/analytics/deltaChipView';
import { TrackedSection } from './TrackedSection';

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'user-1' } }) }));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
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

let serverItems: StoredItem[] = [];
let aliasMap: Record<string, string> = {};
let getResponse: () => Response | Promise<Response> = () => jsonResponse({ items: serverItems });

function installServer() {
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    const method = String(init.method);
    if (String(url).includes('/api/opponents/aliases')) {
      return Promise.resolve(jsonResponse(aliasMap));
    }
    if (method === 'GET') {
      return Promise.resolve(getResponse());
    }
    const key = decodeURIComponent(String(url).split('/api/watchlist/items/')[1] ?? '');
    // A DELETE really removes the item, so the refetch after the mutation settles agrees with it.
    serverItems = serverItems.filter((entry) => entry.itemKey !== key);
    return Promise.resolve(jsonResponse({ itemKey: key }));
  });
}

function requests(method: string): { url: string }[] {
  return fetchMock.mock.calls
    .filter((call) => String((call[1] as RequestInit).method) === method)
    .map((call) => ({ url: String(call[0]) }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function game(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return { fighter_id: 1, opponent_id: 2, ...overrides } as Match;
}

/** A game vs mkleo wins on this rule: about 39% of games, evenly interleaved so no recent window drifts from the whole. */
function mkleoWins(index: number): boolean {
  return (index * 7) % 18 < 7;
}

/** `count` games vs mkleo, one per day, oldest first. */
function mkleoGames(now: number, count: number): Match[] {
  return Array.from({ length: count }, (_, i) =>
    game({
      id: `mk-${i}`,
      // Half a day off every whole-day boundary, so a millisecond of clock drift between the fixture's
      // `now` and the section's own never moves a game across the 30/90-day window edge.
      time: now - (count - i) * DAY_MS + DAY_MS / 2,
      win: mkleoWins(i),
      opponent: 'mkleo',
    }),
  );
}

/** Enough history that no recent window reaches 60% of it (which the ladder reads as "collapsed"). */
const LONG_HISTORY = 200;
const LONG_WINS = Array.from({ length: LONG_HISTORY }, (_, i) => i).filter(mkleoWins).length;

/** 8 games on stage 1 by fighter 10 vs 12 against steve, 6 won: a matchup item and a stage item both read them. */
function steveGames(now: number): Match[] {
  return Array.from({ length: 8 }, (_, i) =>
    game({
      id: `st-${i}`,
      fighter_id: 10,
      opponent_id: 12,
      time: now - (8 - i) * DAY_MS,
      win: i < 6,
      opponent: 'steve',
      map: { id: 1, name: 'Battlefield' },
    }),
  );
}

function item(kind: string, ref: unknown, key: string, createdAt = 1000): StoredItem {
  return { itemKey: key, item: { kind, ref, createdAt } };
}

const MKLEO_ITEM = item('opponent', 'mkleo', 'opponent:mkleo');
const MATCHUP_ITEM = item('matchup', { fighterId: 10, vsFighterId: 12 }, 'matchup:10-12');
const STAGE_ITEM = item('stage', 1, 'stage:1');

function renderSection(
  props: {
    matches?: Match[];
    horizon?: HorizonKey;
    moved?: ReadonlyMap<string, { token: DigestMovedToken; salience: number }>;
  } = {},
  path = '/dashboard',
) {
  const now = Date.now();
  const matches = props.matches ?? [...mkleoGames(now, LONG_HISTORY), ...steveGames(now)];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <TrackedSection matches={matches} horizon={props.horizon ?? 'last30'} moved={props.moved} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient, matches };
}

/** The chip the engine's own formNow read produces for one item, mapped through `deltaChipView`. */
function expectedChip(matches: Match[], itemToRead: StoredItem, horizon: HorizonKey) {
  const formNow = INSIGHT_TEMPLATES.find((template) => template.id === 'formNow')!;
  const scope = trackedItemScope(itemToRead.item as Parameters<typeof trackedItemScope>[0]);
  const insight = formNow.build({ matches, scope, horizon, nowMs: Date.now() })[0]!;
  return deltaChipView({
    state: insight.state,
    deltaPoints: insight.deltaPoints,
    recentGames: insight.window.games,
    horizon,
    horizonOwnedByParent: true,
    t: i18n.t.bind(i18n),
  });
}

describe('TrackedSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    serverItems = [];
    aliasMap = {};
    getResponse = () => jsonResponse({ items: serverItems });
    installServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('empty: one compact card with "0 of 25" and the muted line, no rows and no strips', async () => {
    renderSection();
    expect(await screen.findByText(/Nothing tracked yet/)).toBeInTheDocument();
    const section = document.getElementById('tracked')!;
    expect(section).toHaveTextContent('Tracked');
    expect(section).toHaveTextContent('0 of 25');
    expect(section.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(0);
    expect(section.querySelectorAll('[data-slot="mini-strip"]')).toHaveLength(0);
  });

  it('pending: renders the 3-row list skeleton in place, without waiting on anything else', async () => {
    getResponse = () => new Promise<Response>(() => undefined);
    renderSection();
    const section = document.getElementById('tracked')!;
    expect(section).toBeInTheDocument();
    const status = within(section).getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    // The list skeleton's title block plus exactly three row blocks.
    expect(section.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(4);
    expect(section.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(0);
  });

  it('error: the GET failure is the one loadError line and nothing else', async () => {
    getResponse = () => jsonResponse({ error: 'x', message: 'boom', statusCode: 500 }, 500);
    renderSection();
    expect(await screen.findByText(/Tracked items couldn't be loaded/)).toBeInTheDocument();
    const section = document.getElementById('tracked')!;
    expect(section.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(0);
    expect(section.querySelector('[data-slot="tracked-count"]')).toBeEmptyDOMElement();
  });

  it('populated: Record, the engine chip and a 10-game strip for the opponent, most games first', async () => {
    serverItems = [STAGE_ITEM, MATCHUP_ITEM, MKLEO_ITEM];
    const { matches } = renderSection();
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(3),
    );
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="tracked-row"]'));
    // The longest history first, then the two 8-game items in key order.
    expect(rows.map((row) => row.dataset.itemKey)).toEqual([
      'opponent:mkleo',
      'matchup:10-12',
      'stage:1',
    ]);

    const mkleo = rows[0]!;
    expect(within(mkleo).getByText(`${LONG_WINS}–${LONG_HISTORY - LONG_WINS}`)).toBeInTheDocument();
    expect(mkleo).toHaveTextContent(`${Math.round((LONG_WINS / LONG_HISTORY) * 100)}%`);
    expect(mkleo).toHaveTextContent(String(LONG_HISTORY));
    expect(mkleo).toHaveTextContent('mkleo');

    const strip = mkleo.querySelector('[data-slot="mini-strip"]')!;
    expect(strip).toHaveAttribute('aria-label', `Form strip, 10 of ${LONG_HISTORY} games`);
    expect(
      strip.querySelectorAll(
        '[data-slot="mini-strip-tick-win"], [data-slot="mini-strip-tick-loss"]',
      ),
    ).toHaveLength(10);

    // D-05: the chip is exactly the engine's read mapped through deltaChipView, no row-local direction.
    const expected = expectedChip(matches, MKLEO_ITEM, 'last30')!;
    const chip = mkleo.querySelector('[data-slot="delta-chip"]')!;
    expect(chip).toHaveAttribute('data-state', expected.state);
    expect(chip).toHaveTextContent(expected.valueLabel);
    expect(expected.state).toBe('steady');
  });

  it('collapsed: when the recent window IS the history the row carries no chip, and says so in its name', async () => {
    serverItems = [MKLEO_ITEM];
    renderSection({ matches: mkleoGames(Date.now(), 12) });
    const link = await screen.findByRole('link', { name: /^Opponent mkleo/ });
    expect(link).toHaveAccessibleName(expect.stringContaining('= all games'));
    expect(document.querySelector('[data-slot="delta-chip"]')).toBeNull();
  });

  it('the row chip follows the page horizon, still straight from the engine', async () => {
    serverItems = [MKLEO_ITEM];
    const { matches } = renderSection({ horizon: 'last90' });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(1),
    );
    const expected = expectedChip(matches, MKLEO_ITEM, 'last90')!;
    const chip = document.querySelector('[data-slot="delta-chip"]')!;
    expect(chip).toHaveAttribute('data-state', expected.state);
    expect(chip).toHaveAttribute('data-recent-games', String(expected.recentGames));
  });

  it('partial: a stage with no games shows the none chip and no strip, a short history a short strip', async () => {
    serverItems = [item('stage', 9, 'stage:9'), MATCHUP_ITEM];
    renderSection({
      matches: steveGames(Date.now()).slice(0, 4),
    });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(2),
    );
    const emptyStage = document.querySelector('[data-item-key="stage:9"]')!;
    expect(emptyStage.querySelector('[data-slot="delta-chip"]')).toHaveAttribute(
      'data-state',
      'none',
    );
    expect(emptyStage.querySelector('[data-slot="mini-strip"]')).toBeNull();

    const matchup = document.querySelector('[data-item-key="matchup:10-12"]')!;
    const ticks = matchup.querySelectorAll(
      '[data-slot="mini-strip-tick-win"], [data-slot="mini-strip-tick-loss"]',
    );
    expect(ticks).toHaveLength(4);
  });

  it('a stage that no longer resolves renders its stored ref as text with the same door', async () => {
    serverItems = [item('stage', 9999, 'stage:9999')];
    renderSection();
    const link = await screen.findByRole('link', { name: /9999/ });
    expect(link).toHaveAttribute('href', '/stages/9999');
  });

  it('links each kind to its own surface', async () => {
    serverItems = [MKLEO_ITEM, MATCHUP_ITEM, STAGE_ITEM];
    renderSection();
    const opponent = await screen.findByRole('link', { name: /^Opponent mkleo/ });
    expect(opponent).toHaveAttribute('href', '/opponents/mkleo');
    const matchup = screen.getByRole('link', { name: /^Matchup / });
    expect(matchup).toHaveAttribute('href', '/matchups?fighter=10&vs=12');
    const stage = screen.getByRole('link', { name: /^Stage Battlefield/ });
    expect(stage).toHaveAttribute('href', '/stages/1');
  });

  it('under a coach route the links stay inside the client workspace', async () => {
    serverItems = [MKLEO_ITEM, STAGE_ITEM];
    const now = Date.now();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { Routes, Route } = await import('react-router');
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/coach/client-9/dashboard']}>
          <Routes>
            <Route
              path="/coach/:clientId/dashboard"
              element={
                <TrackedSection
                  matches={[...mkleoGames(now, LONG_HISTORY), ...steveGames(now)]}
                  horizon="last30"
                />
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const opponent = await screen.findByRole('link', { name: /^Opponent mkleo/ });
    expect(opponent).toHaveAttribute('href', '/coach/client-9/opponents/mkleo');
    expect(screen.getByRole('link', { name: /^Stage / })).toHaveAttribute(
      'href',
      '/coach/client-9/stages/1',
    );
  });

  it('caps at 8 rows until "Show all N", then shows every item inline', async () => {
    serverItems = Array.from({ length: 9 }, (_, index) =>
      item('stage', index + 1, `stage:${index + 1}`, 1000 + index),
    );
    const user = userEvent.setup();
    renderSection({ matches: [] });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(8),
    );
    const showAll = screen.getByRole('button', { name: 'Show all 9' });

    await user.click(showAll);

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(9),
    );
    expect(document.getElementById('tracked')).toHaveTextContent('9 of 25');
  });

  it('untrack removes the row, sends one DELETE for its key, and moves focus to the next row link', async () => {
    serverItems = [MKLEO_ITEM, MATCHUP_ITEM];
    const user = userEvent.setup();
    renderSection();
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(2),
    );
    const first = document.querySelector<HTMLElement>('[data-item-key="opponent:mkleo"]')!;
    const nextLink = document
      .querySelector<HTMLElement>('[data-item-key="matchup:10-12"]')!
      .querySelector<HTMLElement>('a')!;

    await user.click(within(first).getByRole('button', { name: 'Stop tracking mkleo' }));

    await waitFor(() =>
      expect(document.querySelector('[data-item-key="opponent:mkleo"]')).toBeNull(),
    );
    expect(requests('DELETE')).toHaveLength(1);
    expect(decodeURIComponent(requests('DELETE')[0]!.url)).toContain(
      '/api/watchlist/items/opponent:mkleo',
    );
    expect(document.activeElement).toBe(nextLink);
  });

  it('untracking the last row moves focus to the section heading', async () => {
    serverItems = [MKLEO_ITEM];
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Stop tracking mkleo' }));
    await waitFor(() => expect(document.querySelector('[data-slot="tracked-row"]')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Tracked' }));
  });

  it('E7: an opponent tracked under a since-merged tag displays once, under the resolved identity', async () => {
    aliasMap = { mkleo2: 'mkleo' };
    serverItems = [
      item('opponent', 'mkleo2', 'opponent:mkleo2', 500),
      item('opponent', 'mkleo', 'opponent:mkleo', 1000),
    ];
    renderSection();
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(1),
    );
    expect(document.querySelector('[data-slot="tracked-row"]')).toHaveAttribute(
      'data-item-key',
      'opponent:mkleo',
    );
    // Both stored items remain: the count is the stored list, the display is deduped.
    expect(document.getElementById('tracked')).toHaveTextContent('2 of 25');
  });
  describe('untracking a row that folds several stored keys (39.2-REVIEW WEB-IN multi-key untrack)', () => {
    const MERGED = [
      item('opponent', 'mkleo2', 'opponent:mkleo2', 500),
      item('opponent', 'mkleo', 'opponent:mkleo', 1000),
    ];

    it('deletes every folded key and announces the row ONCE', async () => {
      aliasMap = { mkleo2: 'mkleo' };
      serverItems = [...MERGED];
      const user = userEvent.setup();
      renderSection();
      await user.click(await screen.findByRole('button', { name: 'Stop tracking mkleo' }));
      await waitFor(() => expect(requests('DELETE')).toHaveLength(2));
      await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalled());
      expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });

    it('a delete that fails rolls back only its own key, never one that already succeeded, with one error toast', async () => {
      aliasMap = { mkleo2: 'mkleo' };
      serverItems = [...MERGED];
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init: RequestInit) => {
        const method = String(init.method);
        if (method === 'DELETE' && decodeURIComponent(String(url)).endsWith('opponent:mkleo2')) {
          return Promise.resolve(
            jsonResponse({ error: 'x', message: 'boom', statusCode: 500 }, 500),
          );
        }
        return base(url, init);
      });
      const user = userEvent.setup();
      renderSection();
      await user.click(await screen.findByRole('button', { name: 'Stop tracking mkleo' }));
      // Hold the post-mutation refetch so the cache shows exactly what the mutation left.
      getResponse = () => new Promise<Response>(() => undefined);
      await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
      // opponent:mkleo was deleted on the server: it must not come back; mkleo2 is restored.
      await waitFor(() => expect(document.getElementById('tracked')).toHaveTextContent('1 of 25'));
      expect(document.querySelector('[data-slot="tracked-row"]')).toHaveAttribute(
        'data-item-key',
        'opponent:mkleo2',
      );
    });
  });

  it('plan 39.2-12: a moved item sorts above a higher-volume unmoved one, shows its token, and the header states the order', async () => {
    serverItems = [MKLEO_ITEM, STAGE_ITEM];
    const moved = new Map([['stage:1', { token: 'down' as const, salience: 3 }]]);
    renderSection({ moved });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(2),
    );
    const keys = Array.from(document.querySelectorAll('[data-slot="tracked-row"]')).map(
      (row) => (row as HTMLElement).dataset.itemKey,
    );
    // mkleo has 200 games, the stage 8: without the moved flag mkleo leads.
    expect(keys).toEqual(['stage:1', 'opponent:mkleo']);
    const stageRow = document.querySelector('[data-item-key="stage:1"]')!;
    expect(stageRow.querySelector('[data-slot="tracked-row-moved"]')?.textContent).toBe(
      'moved — now trending down',
    );
    expect(
      document.querySelector('[data-item-key="opponent:mkleo"] [data-slot="tracked-row-moved"]'),
    ).toBeNull();
    expect(document.querySelector('[data-slot="tracked-sort-note"]')?.textContent).toBe(
      'moved first · then most games',
    );
  });

  it('plan 39.2-12: moved items order among themselves by engine salience, then unmoved by most games', async () => {
    serverItems = [MKLEO_ITEM, MATCHUP_ITEM, STAGE_ITEM];
    const moved = new Map([
      ['stage:1', { token: 'up' as const, salience: 1 }],
      ['matchup:10-12', { token: 'steady' as const, salience: 9 }],
    ]);
    renderSection({ moved });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(3),
    );
    const keys = Array.from(document.querySelectorAll('[data-slot="tracked-row"]')).map(
      (row) => (row as HTMLElement).dataset.itemKey,
    );
    expect(keys).toEqual(['matchup:10-12', 'stage:1', 'opponent:mkleo']);
  });

  it('plan 39.2-12: the moved token is part of the row accessible name', async () => {
    serverItems = [STAGE_ITEM];
    renderSection({ moved: new Map([['stage:1', { token: 'up' as const, salience: 1 }]]) });
    const link = await screen.findByRole('link', { name: /moved — now trending up/ });
    expect(link).toBeInTheDocument();
  });

  it('plan 39.2-12: with nothing moved the order is unchanged and no token renders', async () => {
    serverItems = [MKLEO_ITEM, STAGE_ITEM];
    renderSection();
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(2),
    );
    const keys = Array.from(document.querySelectorAll('[data-slot="tracked-row"]')).map(
      (row) => (row as HTMLElement).dataset.itemKey,
    );
    expect(keys).toEqual(['opponent:mkleo', 'stage:1']);
    expect(document.querySelector('[data-slot="tracked-row-moved"]')).toBeNull();
  });
});

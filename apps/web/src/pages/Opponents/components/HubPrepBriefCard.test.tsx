import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PrepBriefStatus, TournamentEntry } from '@smash-tracker/shared';
import { resolveOpponentIdentities } from '@smash-tracker/shared';
import { AuthContext, type AuthContextValue } from '@/context/AuthContext';
import { FOURTEEN_DAYS_MS } from '@/lib/prepEntryPoints';
import { derivePrepSurfaceMode } from '@/lib/prepSurfaceMode';
import type { TournamentBlock } from '@/pages/Opponents/tournamentHistory';
import { HubPrepBriefCard } from './HubPrepBriefCard';

const listTournaments = vi.fn();
const getPrep = vi.fn();
/** Every mocked response that WILL settle — a deliberately pending read is never added. */
let settleable: Promise<unknown>[] = [];

vi.mock('@/lib/api', () => ({
  api: {
    tournaments: { list: (...args: unknown[]) => listTournaments(...args) },
    prep: { get: (...args: unknown[]) => getPrep(...args) },
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function makeEntry(overrides: Partial<TournamentEntry> & { entryKey: string }): TournamentEntry {
  return {
    eventName: `Event ${overrides.entryKey}`,
    firstSetAt: NOW - 10 * DAY_MS,
    lastSetAt: NOW - 10 * DAY_MS,
    setsPlayed: 1,
    source: 'manual',
    ...overrides,
  };
}

function makeImported(overrides: Partial<TournamentEntry> & { entryKey: string }): TournamentEntry {
  return makeEntry({ ...overrides, origin: 'admin-imported' } as Partial<TournamentEntry> & {
    entryKey: string;
  });
}

/** A tournament block against this opponent that `resolveTournamentEntry` maps onto `entry`. */
function blockFor(entry: TournamentEntry): TournamentBlock {
  return {
    displayName: entry.eventName,
    eventName: entry.eventName,
    sets: [],
    startTime: entry.firstSetAt,
    endTime: entry.lastSetAt,
    wins: 1,
    losses: 0,
  };
}

function briefListing(...names: string[]): PrepBriefStatus {
  return {
    activated: true,
    brief: {
      likelyOpponents: Object.fromEntries(names.map((name) => [name, true])),
    },
  } as unknown as PrepBriefStatus;
}

const inWindow: PrepBriefStatus = { activated: true, reviewAt: NOW - DAY_MS };

/** The identity resolver the hub builds, over an alias map (the alias-chain hop). */
function hubResolver(aliasMap: Record<string, string> = {}) {
  return resolveOpponentIdentities([], aliasMap);
}

function renderCard({
  entries,
  statuses = {},
  blocks = [],
  aliasMap = {},
  resolveOpponent,
}: {
  entries: TournamentEntry[];
  statuses?: Record<string, PrepBriefStatus | 'pending' | 'error'>;
  blocks?: TournamentBlock[];
  aliasMap?: Record<string, string>;
  resolveOpponent?: (match: { opponent: string }) => string;
}) {
  listTournaments.mockImplementation(() => track(Promise.resolve(entries)));
  getPrep.mockImplementation((entryKey: string) => {
    const status = statuses[entryKey];
    if (status === 'pending') return new Promise(() => {});
    if (status === 'error') return track(Promise.reject(new Error('boom')));
    return track(Promise.resolve(status ?? { activated: false }));
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auth = { user: { uid: 'test-uid' } } as unknown as AuthContextValue;
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/opponents/rival']}>
          <HubPrepBriefCard
            opponentIdentity="rival"
            opponentTag="Rival"
            resolveOpponent={resolveOpponent ?? hubResolver(aliasMap)}
            tournamentBlocks={blocks}
          />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

function track<T>(promise: Promise<T>): Promise<T> {
  settleable.push(promise.catch(() => undefined));
  return promise;
}

/**
 * Waits until every settleable read (and any read it triggers) has settled,
 * so a state assertion is made on the FINAL render — a fall-through state
 * shown while a status is still pending can never make a negative case pass.
 */
async function settle(): Promise<void> {
  let seen = -1;
  while (seen !== settleable.length) {
    seen = settleable.length;
    await act(async () => {
      await Promise.all(settleable);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function cardState(): Promise<string | null> {
  await settle();
  return screen.queryByTestId('hub-prep-brief-card')?.getAttribute('data-state') ?? null;
}

function doorHref(): string | null {
  return screen.getByRole('link').getAttribute('href');
}

describe('HubPrepBriefCard (PREP-05, D-11/D-13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settleable = [];
  });

  describe('upcoming and add-event', () => {
    it('shows the upcoming copy and a door into the prep page when the nearest upcoming entry lists this opponent', async () => {
      const upcoming = makeEntry({
        entryKey: 'up1',
        eventName: 'Genesis',
        firstSetAt: NOW + 3 * DAY_MS,
      });
      renderCard({ entries: [upcoming], statuses: { up1: briefListing('rival') } });

      expect(await cardState()).toBe('upcoming');
      expect(screen.getByTestId('hub-prep-brief-card')).toHaveTextContent(
        "You're likely to face Rival at Genesis",
      );
      expect(screen.getByText('Prep brief')).toBeInTheDocument();
      expect(doorHref()).toBe('/tournaments/up1/prep');
    });

    it('shows the add-event copy and a door to the tournaments page with no qualifying upcoming entry', async () => {
      renderCard({ entries: [] });

      expect(await cardState()).toBe('addEvent');
      expect(screen.getByTestId('hub-prep-brief-card')).toHaveTextContent(
        'Add an upcoming event to start tracking Rival as a likely opponent.',
      );
      expect(doorHref()).toBe('/tournaments');
      expect(getPrep).not.toHaveBeenCalled();
    });

    it('shows add-event when the upcoming entry does not list this opponent', async () => {
      const upcoming = makeEntry({ entryKey: 'up1', firstSetAt: NOW + DAY_MS });
      renderCard({ entries: [upcoming], statuses: { up1: briefListing('someone-else') } });

      expect(await cardState()).toBe('addEvent');
    });

    it('matches through the RESOLVED identity: a likely-opponent name stored under an alias still finds the event', async () => {
      const upcoming = makeEntry({ entryKey: 'up1', firstSetAt: NOW + DAY_MS });
      renderCard({
        entries: [upcoming],
        statuses: { up1: briefListing('rival-alt') },
        aliasMap: { 'rival-alt': 'rival' },
      });

      expect(await cardState()).toBe('upcoming');
      expect(doorHref()).toBe('/tournaments/up1/prep');
    });

    it('control: the same alias-only brief does NOT match through a raw-tag comparison', async () => {
      const upcoming = makeEntry({ entryKey: 'up1', firstSetAt: NOW + DAY_MS });
      renderCard({
        entries: [upcoming],
        statuses: { up1: briefListing('rival-alt') },
        resolveOpponent: ({ opponent }) => opponent,
      });

      expect(await cardState()).toBe('addEvent');
    });

    it('links to the nearest qualifying upcoming entry by start date, skipping a nearer one that does not list the opponent', async () => {
      const nearest = makeEntry({ entryKey: 'a-near', firstSetAt: NOW + DAY_MS });
      const middle = makeEntry({ entryKey: 'z-mid', firstSetAt: NOW + 2 * DAY_MS });
      const far = makeEntry({ entryKey: 'b-far', firstSetAt: NOW + 5 * DAY_MS });
      renderCard({
        entries: [far, middle, nearest],
        statuses: {
          'a-near': briefListing('someone-else'),
          'z-mid': briefListing('rival'),
          'b-far': briefListing('rival'),
        },
      });

      expect(await cardState()).toBe('upcoming');
      expect(doorHref()).toBe('/tournaments/z-mid/prep');
    });

    it('breaks a start-date tie between qualifying upcoming entries by entry key ascending', async () => {
      const sameDay = NOW + 2 * DAY_MS;
      renderCard({
        entries: [
          makeEntry({ entryKey: 'm-key', firstSetAt: sameDay }),
          makeEntry({ entryKey: 'c-key', firstSetAt: sameDay }),
        ],
        statuses: { 'm-key': briefListing('rival'), 'c-key': briefListing('rival') },
      });

      expect(await cardState()).toBe('upcoming');
      expect(doorHref()).toBe('/tournaments/c-key/prep');
    });

    it('renders nothing while an upcoming brief read is unresolved — unknown is never the add-event state', async () => {
      const upcoming = makeEntry({ entryKey: 'up1', firstSetAt: NOW + DAY_MS });
      renderCard({ entries: [upcoming], statuses: { up1: 'pending' } });

      await waitFor(() => expect(getPrep).toHaveBeenCalledWith('up1'));
      expect(screen.queryByTestId('hub-prep-brief-card')).not.toBeInTheDocument();
    });

    it('code review IN-01: listed only on the 6th upcoming entry (past the read cap), the card never says "add an upcoming event"', async () => {
      const entries = [1, 2, 3, 4, 5, 6].map((day) =>
        makeEntry({ entryKey: `up${day}`, firstSetAt: NOW + day * DAY_MS }),
      );
      renderCard({
        entries,
        statuses: {
          up1: briefListing('someone-else'),
          up2: briefListing('someone-else'),
          up3: briefListing('someone-else'),
          up4: briefListing('someone-else'),
          up5: briefListing('someone-else'),
          up6: briefListing('rival'),
        },
      });

      expect(await cardState()).toBe('laterEvents');
      const card = screen.getByTestId('hub-prep-brief-card');
      expect(card).not.toHaveTextContent(/Add an upcoming event/);
      expect(card).toHaveTextContent(
        "Rival isn't a likely opponent at your nearest upcoming events. Check your tournaments for later ones.",
      );
      expect(doorHref()).toBe('/tournaments');
      expect(getPrep).not.toHaveBeenCalledWith('up6');
    });

    it('control: with exactly five upcoming entries, none listing this opponent, add-event is still the truthful state', async () => {
      const entries = [1, 2, 3, 4, 5].map((day) =>
        makeEntry({ entryKey: `up${day}`, firstSetAt: NOW + day * DAY_MS }),
      );
      renderCard({
        entries,
        statuses: Object.fromEntries(
          entries.map((entry) => [entry.entryKey, briefListing('someone-else')]),
        ),
      });

      expect(await cardState()).toBe('addEvent');
    });

    it('never offers a future-dated admin-imported entry as upcoming, and never reads its brief', async () => {
      const imported = makeImported({ entryKey: 'imp-future', firstSetAt: NOW + DAY_MS });
      renderCard({ entries: [imported], statuses: { 'imp-future': briefListing('rival') } });

      expect(await cardState()).toBe('addEvent');
      expect(getPrep).not.toHaveBeenCalledWith('imp-future');
    });
  });

  describe('debrief override (C1-H6: the server decides review mode)', () => {
    const shared = makeEntry({
      entryKey: 'past1',
      eventName: 'Summit',
      firstSetAt: NOW - 3 * DAY_MS,
      lastSetAt: NOW - 3 * DAY_MS + 6 * 60 * 60 * 1000,
    });

    it('shows debrief copy for a shared event whose server status is activated and converted within fourteen days', async () => {
      renderCard({ entries: [shared], statuses: { past1: inWindow }, blocks: [blockFor(shared)] });

      expect(await cardState()).toBe('debrief');
      expect(screen.getByTestId('hub-prep-brief-card')).toHaveTextContent('Review Summit');
      expect(doorHref()).toBe('/tournaments/past1/prep');
    });

    it('the same qualifying status resolves to review on the destination page (derivePrepSurfaceMode)', () => {
      expect(derivePrepSurfaceMode(inWindow)).toBe('review');
    });

    it('the debrief override wins over a qualifying upcoming entry, never both together', async () => {
      const upcoming = makeEntry({ entryKey: 'up1', firstSetAt: NOW + DAY_MS });
      renderCard({
        entries: [shared, upcoming],
        statuses: { past1: inWindow, up1: briefListing('rival') },
        blocks: [blockFor(shared)],
      });

      expect(await cardState()).toBe('debrief');
      expect(screen.getAllByTestId('hub-prep-brief-card')).toHaveLength(1);
      expect(screen.getAllByRole('link')).toHaveLength(1);
    });

    it.each<[string, PrepBriefStatus]>([
      ['not activated', { activated: false, reviewAt: NOW - DAY_MS }],
      ['activated with reviewAt absent', { activated: true }],
      ['reviewAt in the future', { activated: true, reviewAt: NOW + DAY_MS }],
      [
        'reviewAt older than fourteen days',
        { activated: true, reviewAt: NOW - FOURTEEN_DAYS_MS - DAY_MS },
      ],
    ])('shows NO debrief affordance when the server status is %s', async (_label, status) => {
      renderCard({ entries: [shared], statuses: { past1: status }, blocks: [blockFor(shared)] });

      await waitFor(() => expect(getPrep).toHaveBeenCalledWith('past1'));
      expect(await cardState()).toBe('addEvent');
      expect(screen.queryByText(/Review Summit/)).not.toBeInTheDocument();
    });

    it('a manually-entered event whose firstSetAt is the start of today opens NO debrief — no server reviewAt exists for it', async () => {
      const startOfToday = new Date(NOW);
      startOfToday.setHours(0, 0, 0, 0);
      const manualToday = makeEntry({
        entryKey: 'today',
        eventName: 'Today Locals',
        source: 'manual',
        firstSetAt: startOfToday.getTime(),
        lastSetAt: startOfToday.getTime(),
      });
      renderCard({
        entries: [manualToday],
        statuses: { today: { activated: true } },
        blocks: [blockFor(manualToday)],
      });

      await waitFor(() => expect(getPrep).toHaveBeenCalledWith('today'));
      expect(await cardState()).toBe('addEvent');
      expect(screen.queryByText(/Review Today Locals/)).not.toBeInTheDocument();
    });

    it('code review WEB-01: a PENDING debrief status renders nothing — never a door the settled render would retract', async () => {
      renderCard({ entries: [shared], statuses: { past1: 'pending' }, blocks: [blockFor(shared)] });
      await waitFor(() => expect(getPrep).toHaveBeenCalledWith('past1'));
      expect(await cardState()).toBeNull();
    });

    it('code review WEB-01: a PENDING debrief status hides a qualifying upcoming door too, until the status lands', async () => {
      const upcoming = makeEntry({ entryKey: 'up1', firstSetAt: NOW + DAY_MS });
      renderCard({
        entries: [shared, upcoming],
        statuses: { past1: 'pending', up1: briefListing('rival') },
        blocks: [blockFor(shared)],
      });
      await waitFor(() => expect(getPrep).toHaveBeenCalledWith('up1'));
      expect(await cardState()).toBeNull();
    });

    it('an ERRORED debrief status falls through to the next state, so a failing endpoint never hides the card for good', async () => {
      renderCard({ entries: [shared], statuses: { past1: 'error' }, blocks: [blockFor(shared)] });
      await waitFor(() => expect(getPrep).toHaveBeenCalledWith('past1'));
      expect(await cardState()).toBe('addEvent');

      const upcoming = makeEntry({ entryKey: 'up1', firstSetAt: NOW + DAY_MS });
      cleanup();
      renderCard({
        entries: [shared, upcoming],
        statuses: { past1: 'error', up1: briefListing('rival') },
        blocks: [blockFor(shared)],
      });
      expect(await cardState()).toBe('upcoming');
    });

    it('C1-H7: a past-dated ADMIN-IMPORTED shared entry produces no debrief and no upcoming affordance, and its status is never read', async () => {
      const imported = makeImported({
        entryKey: 'imp-past',
        eventName: 'Imported Major',
        firstSetAt: NOW - 2 * DAY_MS,
        lastSetAt: NOW - 2 * DAY_MS,
      });
      renderCard({
        entries: [imported],
        statuses: { 'imp-past': inWindow },
        blocks: [blockFor(imported)],
      });

      expect(await cardState()).toBe('addEvent');
      expect(screen.queryByText(/Imported Major/)).not.toBeInTheDocument();
      expect(getPrep).not.toHaveBeenCalledWith('imp-past');
    });

    it('an entry with no usable end date does not open the debrief window and renders no invalid date', async () => {
      const undated = makeEntry({
        entryKey: 'undated',
        eventName: 'Undated Weekly',
        firstSetAt: 0,
        lastSetAt: 0,
      });
      const { container } = renderCard({
        entries: [undated],
        statuses: { undated: inWindow },
        blocks: [blockFor(undated)],
      });

      expect(await cardState()).toBe('addEvent');
      expect(container.textContent).not.toMatch(/Invalid Date|NaN/);
      expect(getPrep).not.toHaveBeenCalledWith('undated');
    });

    it('picks the most recent shared event by end date among several', async () => {
      const older = makeEntry({
        entryKey: 'a-older',
        eventName: 'Older Event',
        firstSetAt: NOW - 6 * DAY_MS,
        lastSetAt: NOW - 6 * DAY_MS,
      });
      const newer = makeEntry({
        entryKey: 'z-newer',
        eventName: 'Newer Event',
        firstSetAt: NOW - 2 * DAY_MS,
        lastSetAt: NOW - 2 * DAY_MS,
      });
      renderCard({
        entries: [older, newer],
        statuses: { 'a-older': inWindow, 'z-newer': inWindow },
        blocks: [blockFor(older), blockFor(newer)],
      });

      expect(await cardState()).toBe('debrief');
      expect(doorHref()).toBe('/tournaments/z-newer/prep');
    });

    it('breaks an end-date tie between shared events by entry key ascending', async () => {
      const sameEnd = NOW - 2 * DAY_MS;
      const m = makeEntry({
        entryKey: 'm-key',
        eventName: 'M Event',
        firstSetAt: sameEnd,
        lastSetAt: sameEnd,
      });
      const c = makeEntry({
        entryKey: 'c-key',
        eventName: 'C Event',
        firstSetAt: sameEnd,
        lastSetAt: sameEnd,
      });
      renderCard({
        entries: [m, c],
        statuses: { 'm-key': inWindow, 'c-key': inWindow },
        blocks: [blockFor(m), blockFor(c)],
      });

      expect(await cardState()).toBe('debrief');
      expect(doorHref()).toBe('/tournaments/c-key/prep');
    });
  });

  describe('chrome (D-11: free, no paid treatment)', () => {
    it('renders exactly one outline door and no primary-filled button', async () => {
      renderCard({ entries: [] });
      await cardState();
      const door = screen.getByRole('link');
      expect(door.getAttribute('data-variant')).toBe('outline');
      expect(screen.getByTestId('hub-prep-brief-card').innerHTML).not.toMatch(
        /text-primary|bg-primary|sparkles/i,
      );
    });
  });
});

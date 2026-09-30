import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { insightDismissalsStorageKey } from '@/lib/insightDismissals';
import { FOURTEEN_DAYS_MS } from '@/lib/prepEntryPoints';
import { RecapCandidateGate } from '@/components/analytics/track/RecapCandidateGate';
import type { RecapCandidateResult } from './useRecapCandidate';
import { evaluateRecapCandidate, recapDismissalId, selectNewestEvent } from './useRecapCandidate';

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));

interface MatchesState {
  allMatches: Match[];
  isLoading: boolean;
  isFetching: boolean;
}
let matchesState: MatchesState;
vi.mock('@/hooks/useFilteredMatches', () => ({ useFilteredMatches: () => matchesState }));

interface EntriesState {
  data: TournamentEntry[] | undefined;
  isPending: boolean;
  isError: boolean;
}
let entriesState: EntriesState;
const useTournamentEntriesSpy = vi.fn(() => entriesState);
vi.mock('@/hooks/useTournamentEntries', () => ({
  useTournamentEntries: () => useTournamentEntriesSpy(),
}));

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function game(id: string, time: number, eventName?: string): Match {
  return {
    id,
    time,
    win: true,
    fighter_id: 1,
    opponent_id: 2,
    eventName,
    tournamentName: eventName,
  } as Match;
}

/** Nine games of one event ending `endedAgoMs` before NOW. */
function eventGames(name: string, endedAgoMs: number): Match[] {
  return Array.from({ length: 9 }, (_, i) =>
    game(`${name}-${i}`, NOW - endedAgoMs - (8 - i) * HOUR, name),
  );
}

function entryFor(name: string, endedAgoMs: number, extra: Partial<TournamentEntry> = {}) {
  return {
    eventName: name,
    tournamentName: name,
    entryKey: 'sn26',
    firstSetAt: NOW - endedAgoMs - 10 * HOUR,
    lastSetAt: NOW - endedAgoMs,
    setsPlayed: 3,
    placement: 3,
    numEntrants: 2048,
    ...extra,
  } as TournamentEntry;
}

/** The last result the probe saw, written from an effect (never during render). */
const sink: { latest: RecapCandidateResult | null } = { latest: null };

function Sink({ recap }: { recap: RecapCandidateResult }) {
  useEffect(() => {
    sink.latest = recap;
  });
  return null;
}

function Probe({ lastSeenAt, ready = true }: { lastSeenAt: number | null; ready?: boolean }) {
  return (
    <RecapCandidateGate lastSeenAt={lastSeenAt} ready={ready}>
      {(recap) => <Sink recap={recap} />}
    </RecapCandidateGate>
  );
}

function mount(path: string, lastSeenAt: number | null, ready = true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe lastSeenAt={lastSeenAt} ready={ready} />
    </MemoryRouter>,
  );
}

describe('useRecapCandidate (plan 39.2-13: visibility, enrichment, dismissal)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    window.localStorage.clear();
    sink.latest = null;
    matchesState = { allMatches: [], isLoading: false, isFetching: false };
    entriesState = { data: [], isPending: false, isError: false };
    useTournamentEntriesSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('an event inside 14 days and newer than last seen is the candidate, enriched with its registry entry', () => {
    matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
    entriesState.data = [entryFor('Supernova 2026', 3 * DAY)];
    mount('/dashboard', NOW - 10 * DAY);
    expect(sink.latest?.status).toBe('ready');
    expect(sink.latest?.candidate?.eventKey).toBe('Supernova 2026');
    expect(sink.latest?.candidate?.games).toHaveLength(9);
    expect(sink.latest?.candidate?.entry?.entryKey).toBe('sn26');
    expect(sink.latest?.candidate?.entry?.resolution.tier).toBeDefined();
    expect(sink.latest?.candidate?.dismissalId).toBe('recap:sn26');
  });

  it('a first visit on a device (no last seen) lets any in-window event qualify', () => {
    matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
    mount('/dashboard', null);
    expect(sink.latest?.status).toBe('ready');
  });

  it('an event older than last seen is not a candidate', () => {
    matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
    mount('/dashboard', NOW - 1 * DAY);
    expect(sink.latest?.status).toBe('none');
    expect(sink.latest?.candidate).toBeNull();
  });

  it('an event that ended 15 days ago is not a candidate, and one that ended 13 days ago is', () => {
    matchesState.allMatches = eventGames('Old Event', 15 * DAY);
    const { unmount } = mount('/dashboard', null);
    expect(sink.latest?.status).toBe('none');
    unmount();
    matchesState.allMatches = eventGames('Recent Event', 13 * DAY);
    mount('/dashboard', null);
    expect(sink.latest?.status).toBe('ready');
  });

  it('the window constant is the shared one: the boundary sits exactly at FOURTEEN_DAYS_MS', () => {
    const event = selectNewestEvent(eventGames('Edge', 0))!;
    const at = (ageMs: number) =>
      evaluateRecapCandidate({
        event: { ...event, newestGame: { ...event.newestGame, time: NOW - ageMs } },
        lastSeenAt: null,
        nowMs: NOW,
        dismissedIds: [],
        entry: null,
      });
    expect(at(FOURTEEN_DAYS_MS)).not.toBeNull();
    expect(at(FOURTEEN_DAYS_MS + 1)).toBeNull();
  });

  it('an event whose registry end is still ahead is not complete, so no candidate', () => {
    matchesState.allMatches = eventGames('Supernova 2026', 1 * HOUR);
    // A multi-day event whose last day is still ahead: games are attributed, the end is not reached.
    entriesState.data = [entryFor('Supernova 2026', -2 * DAY, { firstSetAt: NOW - 12 * HOUR })];
    mount('/dashboard', null);
    expect(sink.latest?.status).toBe('none');
  });

  it('a dismissed event yields no candidate, and dismiss() stores the recap id for this subject', () => {
    matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
    entriesState.data = [entryFor('Supernova 2026', 3 * DAY)];
    const { unmount } = mount('/dashboard', null);
    expect(sink.latest?.status).toBe('ready');
    act(() => sink.latest?.dismiss());
    expect(sink.latest?.status).toBe('none');
    const stored = window.localStorage.getItem(insightDismissalsStorageKey('u1', null));
    expect(JSON.parse(stored ?? '[]')).toEqual(['recap:sn26']);
    unmount();
    mount('/dashboard', null);
    expect(sink.latest?.status).toBe('none');
  });

  it('an event with no registry entry dismisses under its event key', () => {
    matchesState.allMatches = eventGames('Local Weekly', 2 * DAY);
    mount('/dashboard', null);
    expect(sink.latest?.candidate?.entry).toBeNull();
    expect(sink.latest?.candidate?.dismissalId).toBe(recapDismissalId(null, 'Local Weekly'));
    expect(sink.latest?.candidate?.dismissalId).toBe('recap:Local Weekly');
  });

  it('holds as loading while the registry resolves for an event that could qualify', () => {
    matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
    entriesState = { data: undefined, isPending: true, isError: false };
    mount('/dashboard', null);
    expect(sink.latest?.status).toBe('loading');
    cleanup();
    matchesState.allMatches = eventGames('Ancient', 40 * DAY);
    mount('/dashboard', null);
    expect(sink.latest?.status).toBe('none');
  });

  it('a failed registry read degrades to the matches-only candidate', () => {
    matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
    entriesState = { data: undefined, isPending: false, isError: true };
    mount('/dashboard', null);
    expect(sink.latest?.status).toBe('ready');
    expect(sink.latest?.candidate?.entry).toBeNull();
  });

  it('decides nothing before the digest snapshot is ready', () => {
    matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
    mount('/dashboard', null, false);
    expect(sink.latest?.status).toBe('none');
  });

  it('a subject with no named event has no candidate', () => {
    matchesState.allMatches = [game('x', NOW - DAY)];
    mount('/dashboard', null);
    expect(sink.latest?.status).toBe('none');
  });

  describe('coach and workspace subjects (D-17, T-39.2-53)', () => {
    it('a coach subject gets a matches-only candidate and the registry hook is never called', () => {
      matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
      // The viewer's own registry has the event; the client's card must not see it.
      entriesState.data = [entryFor('Supernova 2026', 3 * DAY)];
      mount('/coach/client-1/dashboard', null);
      expect(sink.latest?.status).toBe('ready');
      expect(sink.latest?.candidate?.entry).toBeNull();
      expect(sink.latest?.candidate?.dismissalId).toBe('recap:Supernova 2026');
      expect(useTournamentEntriesSpy).not.toHaveBeenCalled();
    });

    it('a workspace subject never calls the registry hook either', () => {
      matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
      mount('/workspace/tenant-1/dashboard', null);
      expect(sink.latest?.status).toBe('ready');
      expect(sink.latest?.candidate?.entry).toBeNull();
      expect(useTournamentEntriesSpy).not.toHaveBeenCalled();
    });

    it('control: the own-account path does call the registry hook', () => {
      matchesState.allMatches = eventGames('Supernova 2026', 3 * DAY);
      mount('/dashboard', null);
      expect(useTournamentEntriesSpy).toHaveBeenCalled();
    });
  });
});

describe('selectNewestEvent', () => {
  it('picks the event holding the newest game and returns all of its games only', () => {
    const picked = selectNewestEvent([
      ...eventGames('Older', 9 * DAY),
      ...eventGames('Newer', 2 * DAY),
      game('unnamed', NOW),
    ]);
    expect(picked?.eventKey).toBe('Newer');
    expect(picked?.games).toHaveLength(9);
  });

  it('is null when no game names an event', () => {
    expect(selectNewestEvent([game('a', 1), game('b', 2)])).toBeNull();
  });
});

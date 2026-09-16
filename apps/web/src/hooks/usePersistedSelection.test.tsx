import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { usePersistedSelection } from './usePersistedSelection';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import { analyticsSelectionStorageKey, persistSelection } from '@/lib/analyticsSelection';

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
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getMe = vi.fn();

function defaultProfile() {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: null,
  };
}

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getMe: (...args: unknown[]) => getMe(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const dk = SpriteList.find((s) => s.id === 2)!; // Donkey Kong
const link = SpriteList.find((s) => s.id === 3)!; // Link
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi
const peach = SpriteList.find((s) => s.id === 14)!; // Peach
const bowser = SpriteList.find((s) => s.id === 16)!; // Bowser

/** Mirrors MatchupsPage.test.tsx's makeMatch helper. */
function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

const FIGHTER_SPRITES = [mario, bowser, peach];

function Probe() {
  const { fighter, opponent, setFighter, setOpponent, isLoading } = usePersistedSelection({
    fighterSprites: FIGHTER_SPRITES,
  });
  return (
    <div>
      <div data-testid="loading">{String(isLoading)}</div>
      <div data-testid="fighter">{fighter?.id ?? 'none'}</div>
      <div data-testid="opponent">{opponent?.id ?? 'none'}</div>
      <button onClick={() => setFighter(mario)}>select-mario</button>
      <button onClick={() => setFighter(bowser)}>select-bowser</button>
      <button onClick={() => setFighter(peach)}>select-peach</button>
      <button onClick={() => setOpponent(luigi)}>select-opponent-luigi</button>
      {/* Mirrors MatchupMatrix.selectPairing (MatchupMatrix.tsx:47-55): ONE
          handler calling setFighter then setOpponent back to back. */}
      <button
        onClick={() => {
          setFighter(mario);
          setOpponent(link);
        }}
      >
        select-pairing-mario-link
      </button>
    </div>
  );
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/matchups" element={<Probe />} />
              <Route path="/coach/:clientId/matchups" element={<Probe />} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('usePersistedSelection', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue(defaultProfile());
    setMockUser(makeMockUser());
  });

  it('subject-switch no-bleed: personal, two clients, and a second uid each show their own selection', async () => {
    const user = userEvent.setup();
    // Mario is the computed default (most recent, tied 1-1 on games) — so
    // seeing Bowser anywhere other than personal (where it was explicitly
    // chosen below) can only mean a cross-subject leak, not coincidence.
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, time: 2 }),
      makeMatch({ id: 'm2', fighter_id: bowser.id, opponent_id: link.id, time: 1 }),
    ]);

    // Personal (test-uid): explicitly choose Bowser.
    const { unmount: unmountPersonal } = renderAt('/matchups');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    await user.click(screen.getByText('select-bowser'));
    await waitFor(() => expect(screen.getByTestId('fighter')).toHaveTextContent(String(bowser.id)));
    unmountPersonal();

    // Client A (same uid): its key has nothing stored — must NOT see Bowser.
    const { unmount: unmountClientA } = renderAt('/coach/client-a/matchups');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('fighter')).not.toHaveTextContent(String(bowser.id));
    unmountClientA();

    // Client B: same independence from both personal and Client A.
    const { unmount: unmountClientB } = renderAt('/coach/client-b/matchups');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('fighter')).not.toHaveTextContent(String(bowser.id));
    unmountClientB();

    // A second uid, same personal scope: also independent.
    setMockUser(makeMockUser({ uid: 'test-uid-2' }));
    renderAt('/matchups');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('fighter')).not.toHaveTextContent(String(bowser.id));

    // Assert directly on storage keys, so a failure names which key bled.
    expect(
      JSON.parse(
        window.localStorage.getItem(analyticsSelectionStorageKey('test-uid', null)) ?? '{}',
      ),
    ).toMatchObject({ fighterId: bowser.id });
    expect(
      window.localStorage.getItem(analyticsSelectionStorageKey('test-uid', 'client-a')),
    ).toBeNull();
    expect(
      window.localStorage.getItem(analyticsSelectionStorageKey('test-uid', 'client-b')),
    ).toBeNull();
    expect(
      window.localStorage.getItem(analyticsSelectionStorageKey('test-uid-2', null)),
    ).toBeNull();
  });

  it('in-flight no-write: setItem is never called while the match query has not settled, even with a stored record present', async () => {
    listMatches.mockReturnValue(new Promise(() => {})); // never settles
    persistSelection('test-uid', null, { fighterId: mario.id });

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderAt('/matchups');

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('true'));
    expect(setItemSpy).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });

  it('stale remembered fighter falls back to the computed most-used id without persisting the fallback', async () => {
    // Peach has zero matches in this history — a stale remembered value.
    persistSelection('test-uid', null, { fighterId: peach.id });
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, time: 1 }),
    ]);

    renderAt('/matchups');

    await waitFor(() => expect(screen.getByTestId('fighter')).toHaveTextContent(String(mario.id)));

    const stored = JSON.parse(
      window.localStorage.getItem(analyticsSelectionStorageKey('test-uid', null)) ?? '{}',
    );
    expect(stored.fighterId).toBe(peach.id);
  });

  it('opponent re-derive: switching to a fighter that has never faced the remembered opponent re-derives it', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, time: 1 }),
      makeMatch({ id: 'm2', fighter_id: bowser.id, opponent_id: dk.id, time: 2 }),
    ]);

    renderAt('/matchups');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await user.click(screen.getByText('select-mario'));
    await user.click(screen.getByText('select-opponent-luigi'));
    await waitFor(() => expect(screen.getByTestId('opponent')).toHaveTextContent(String(luigi.id)));

    await user.click(screen.getByText('select-bowser'));

    // Bowser has never faced Luigi — the opponent re-derives to Bowser's
    // own most-faced opponent (Donkey Kong), not the remembered Luigi.
    await waitFor(() => expect(screen.getByTestId('opponent')).toHaveTextContent(String(dk.id)));

    // The re-derived fallback is never persisted — the stored value still
    // holds the remembered Luigi id.
    const stored = JSON.parse(
      window.localStorage.getItem(analyticsSelectionStorageKey('test-uid', null)) ?? '{}',
    );
    expect(stored.opponentId).toBe(luigi.id);
  });

  it('opponent re-derive: switching to a fighter that HAS faced the remembered opponent keeps it', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, time: 1 }),
      // Peach's OWN most-faced opponent is Donkey Kong (2 games) — if the
      // remembered Luigi were discarded and recomputed instead of kept,
      // this assertion would see Donkey Kong, not Luigi.
      makeMatch({ id: 'm2', fighter_id: peach.id, opponent_id: luigi.id, time: 2 }),
      makeMatch({ id: 'm3', fighter_id: peach.id, opponent_id: dk.id, time: 3 }),
      makeMatch({ id: 'm4', fighter_id: peach.id, opponent_id: dk.id, time: 4 }),
    ]);

    renderAt('/matchups');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await user.click(screen.getByText('select-mario'));
    await user.click(screen.getByText('select-opponent-luigi'));
    await waitFor(() => expect(screen.getByTestId('opponent')).toHaveTextContent(String(luigi.id)));

    await user.click(screen.getByText('select-peach'));

    await waitFor(() => expect(screen.getByTestId('opponent')).toHaveTextContent(String(luigi.id)));
  });

  it('a single click invoking setFighter then setOpponent updates both fields atomically (M-5)', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({ id: 'm1', fighter_id: mario.id, opponent_id: luigi.id, time: 1 }),
      makeMatch({ id: 'm2', fighter_id: mario.id, opponent_id: link.id, time: 2 }),
    ]);

    renderAt('/matchups');
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await user.click(screen.getByText('select-pairing-mario-link'));

    await waitFor(() => {
      expect(screen.getByTestId('fighter')).toHaveTextContent(String(mario.id));
      expect(screen.getByTestId('opponent')).toHaveTextContent(String(link.id));
    });

    const stored = JSON.parse(
      window.localStorage.getItem(analyticsSelectionStorageKey('test-uid', null)) ?? '{}',
    );
    expect(stored).toMatchObject({ fighterId: mario.id, opponentId: link.id });
  });
});

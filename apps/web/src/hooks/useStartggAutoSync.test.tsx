import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { useStartggAutoSync } from './useStartgg';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

const toastInfo = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    info: (...args: unknown[]) => toastInfo(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const status = vi.fn();
const sync = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    startgg: {
      status: (...args: unknown[]) => status(...args),
      sync: (...args: unknown[]) => sync(...args),
    },
  },
}));

const summary = {
  sets: 4,
  imported: 9,
  setsWithoutGames: 0,
  gamesUnmappedCharacter: 0,
  gamesMissingSelections: 0,
  gamesUnknownStage: 0,
  dqSets: 0,
};

function Harness() {
  useStartggAutoSync();
  return <div>shell</div>;
}

function renderHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Harness />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('useStartggAutoSync', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
  });

  it('runs one sync for a freshly-linked account that has never synced', async () => {
    // First status: never synced. The post-sync invalidation refetches it;
    // the second response carries the stamp, mirroring the real API.
    status
      .mockResolvedValueOnce({ linked: true, gamerTag: 'pilot', playerId: 1, slug: 'user/x' })
      .mockResolvedValue({
        linked: true,
        gamerTag: 'pilot',
        playerId: 1,
        slug: 'user/x',
        lastSyncAt: Date.now(),
      });
    sync.mockResolvedValue(summary);

    renderHarness();

    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(toastInfo).toHaveBeenCalledWith('Importing your start.gg tournament matches…');
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('start.gg import complete: 9 games from 4 sets.'),
    );
    // The post-sync status refetch must not re-trigger the sync.
    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(1));
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not sync when the account has synced before', async () => {
    status.mockResolvedValue({
      linked: true,
      gamerTag: 'pilot',
      playerId: 1,
      slug: 'user/x',
      lastSyncAt: 1_700_000_000_000,
    });

    renderHarness();

    await screen.findByText('shell');
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(sync).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('does not sync when no account is linked', async () => {
    status.mockResolvedValue({ linked: false });

    renderHarness();

    await screen.findByText('shell');
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(sync).not.toHaveBeenCalled();
  });

  it('shows the failure toast when the first sync fails, without retrying', async () => {
    status.mockResolvedValue({ linked: true, gamerTag: 'pilot', playerId: 1, slug: 'user/x' });
    sync.mockRejectedValue(new Error('boom'));

    renderHarness();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'start.gg import failed. You can retry from Settings → Integrations.',
      ),
    );
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

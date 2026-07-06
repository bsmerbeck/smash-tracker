import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { IntegrationsPage } from './IntegrationsPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    signInWithCustomToken: mock.signInWithCustomToken,
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
const authorize = vi.fn();
const sync = vi.fn();
const unlink = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

const parryggStatus = vi.fn().mockResolvedValue({ linked: false });

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    startgg: {
      status: (...args: unknown[]) => status(...args),
      authorize: (...args: unknown[]) => authorize(...args),
      sync: (...args: unknown[]) => sync(...args),
      unlink: (...args: unknown[]) => unlink(...args),
    },
    parrygg: {
      status: (...args: unknown[]) => parryggStatus(...args),
      search: vi.fn().mockResolvedValue([]),
      link: vi.fn(),
      unlink: vi.fn(),
      verifyStart: vi.fn(),
      verifyComplete: vi.fn(),
      sync: vi.fn(),
    },
  },
}));

function renderPage(initialEntry = '/settings/integrations') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <Routes>
            <Route path="/settings/integrations" element={<IntegrationsPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('IntegrationsPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    parryggStatus.mockResolvedValue({ linked: false });
    setMockUser(makeMockUser());
  });

  it('offers to connect when no account is linked', async () => {
    status.mockResolvedValue({ linked: false });

    renderPage();

    expect(await screen.findByRole('button', { name: 'Connect start.gg account' })).toBeEnabled();
  });

  it('starts the link flow via the authorize endpoint', async () => {
    const user = userEvent.setup();
    status.mockResolvedValue({ linked: false });
    // jsdom's window.location.assign throws a "not implemented" that the
    // mutation surfaces as an error state — the assertion below only cares
    // that the authorize endpoint was hit.
    authorize.mockResolvedValue({ url: 'https://start.gg/oauth/authorize?x=1' });

    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Connect start.gg account' }));

    await waitFor(() => expect(authorize).toHaveBeenCalled());
  });

  it('shows linked status and runs a sync with a summary toast', async () => {
    const user = userEvent.setup();
    status.mockResolvedValue({
      linked: true,
      gamerTag: 'Pandem1c',
      playerId: 1802316,
      slug: 'user/07dc2239',
      lastSyncAt: 1_700_000_000_000,
    });
    sync.mockResolvedValue({
      sets: 74,
      imported: 112,
      setsWithoutGames: 24,
      gamesUnmappedCharacter: 0,
      gamesMissingSelections: 0,
      gamesUnknownStage: 0,
      dqSets: 0,
    });

    renderPage();

    expect(await screen.findByText('Pandem1c')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Sync now/ }));
    await waitFor(() => expect(sync).toHaveBeenCalled());
    expect(await screen.findByText(/Imported 112 games from 74 sets/)).toBeInTheDocument();
  });

  it('surfaces DQ sets skipped in the sync summary', async () => {
    const user = userEvent.setup();
    status.mockResolvedValue({
      linked: true,
      gamerTag: 'Pandem1c',
      playerId: 1802316,
      slug: 'user/07dc2239',
      lastSyncAt: 1_700_000_000_000,
    });
    sync.mockResolvedValue({
      sets: 74,
      imported: 108,
      setsWithoutGames: 20,
      gamesUnmappedCharacter: 0,
      gamesMissingSelections: 0,
      gamesUnknownStage: 0,
      dqSets: 3,
    });

    renderPage();

    await user.click(await screen.findByRole('button', { name: /Sync now/ }));
    await waitFor(() => expect(sync).toHaveBeenCalled());
    expect(await screen.findByText(/3 DQs skipped/)).toBeInTheDocument();
  });

  it('unlinks after confirmation', async () => {
    const user = userEvent.setup();
    status.mockResolvedValue({ linked: true, gamerTag: 'Pandem1c', playerId: 1, slug: 's' });
    unlink.mockResolvedValue(undefined);

    renderPage();

    await user.click(await screen.findByRole('button', { name: /Unlink/ }));
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(unlink).toHaveBeenCalled());
  });
});

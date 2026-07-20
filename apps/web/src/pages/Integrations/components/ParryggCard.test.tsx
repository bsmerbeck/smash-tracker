import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { ParryggCard } from './ParryggCard';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    getRedirectResult: mock.getRedirectResult,
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
const search = vi.fn();
const link = vi.fn();
const unlink = vi.fn();
const verifyStart = vi.fn();
const verifyComplete = vi.fn();
const sync = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    parrygg: {
      status: (...args: unknown[]) => status(...args),
      search: (...args: unknown[]) => search(...args),
      link: (...args: unknown[]) => link(...args),
      unlink: (...args: unknown[]) => unlink(...args),
      verifyStart: (...args: unknown[]) => verifyStart(...args),
      verifyComplete: (...args: unknown[]) => verifyComplete(...args),
      sync: (...args: unknown[]) => sync(...args),
    },
  },
}));

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ParryggCard />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('ParryggCard', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
  });

  it('shows a search box when unlinked, and links the chosen candidate', async () => {
    const user = userEvent.setup();
    status.mockResolvedValue({ linked: false });
    search.mockResolvedValue([{ id: 'p1', gamerTag: 'Hungrybox', locationCountry: 'US' }]);
    link.mockResolvedValue({
      linked: true,
      gamerTag: 'Hungrybox',
      parryUserId: 'p1',
      verified: false,
    });

    renderCard();

    const input = await screen.findByLabelText('Search parry.gg gamer tag');
    await user.type(input, 'hungry');

    expect(await screen.findByText('Hungrybox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(link).toHaveBeenCalledWith({ parryUserId: 'p1' }));
  });

  it('shows linked-unverified status with a Verify action', async () => {
    status.mockResolvedValue({
      linked: true,
      gamerTag: 'Hungrybox',
      parryUserId: 'p1',
      verified: false,
    });

    renderCard();

    expect(await screen.findByText('Hungrybox')).toBeInTheDocument();
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
  });

  it('shows linked-verified status without a Verify action', async () => {
    status.mockResolvedValue({
      linked: true,
      gamerTag: 'Hungrybox',
      parryUserId: 'p1',
      verified: true,
    });

    renderCard();

    expect(await screen.findByText('Hungrybox')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
  });

  it('runs the verify flow: shows the code, then checks and closes on success', async () => {
    const user = userEvent.setup();
    status.mockResolvedValue({
      linked: true,
      gamerTag: 'Hungrybox',
      parryUserId: 'p1',
      verified: false,
    });
    verifyStart.mockResolvedValue({ code: 'ST-ABC123', expiresAt: Date.now() + 600_000 });
    verifyComplete.mockResolvedValue({ verified: true, verifiedAt: Date.now() });

    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('ST-ABC123')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(verifyComplete).toHaveBeenCalled());
  });

  it('shows an inline error when verification fails', async () => {
    const user = userEvent.setup();
    status.mockResolvedValue({
      linked: true,
      gamerTag: 'Hungrybox',
      parryUserId: 'p1',
      verified: false,
    });
    verifyStart.mockResolvedValue({ code: 'ST-ABC123', expiresAt: Date.now() + 600_000 });
    verifyComplete.mockRejectedValue(
      new Error('Verification code not found in your parry.gg bio yet.'),
    );

    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Verify' }));
    await screen.findByText('ST-ABC123');
    await user.click(screen.getByRole('button', { name: 'Check' }));

    expect(await screen.findByText(/Verification code not found/)).toBeInTheDocument();
  });

  it('runs a sync and shows the summary toast text', async () => {
    const user = userEvent.setup();
    status.mockResolvedValue({
      linked: true,
      gamerTag: 'Hungrybox',
      parryUserId: 'p1',
      verified: true,
      lastSyncAt: 1_700_000_000_000,
    });
    sync.mockResolvedValue({
      matches: 10,
      imported: 22,
      dqOrIncomplete: 1,
      otherGame: 0,
      unknownGame: 2,
      teamEntrants: 0,
      unmappedCharacters: 0,
      unmappedStages: 1,
      setsWithoutGameData: 0,
    });

    renderCard();

    await user.click(await screen.findByRole('button', { name: /Sync now/ }));
    await waitFor(() => expect(sync).toHaveBeenCalled());
    expect(await screen.findByText(/Imported 22 games from 10 matches/)).toBeInTheDocument();
  });

  it('unlinks after confirmation', async () => {
    const user = userEvent.setup();
    status.mockResolvedValue({
      linked: true,
      gamerTag: 'Hungrybox',
      parryUserId: 'p1',
      verified: true,
    });
    unlink.mockResolvedValue(undefined);

    renderCard();

    await user.click(await screen.findByRole('button', { name: /Unlink/ }));
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(unlink).toHaveBeenCalled());
  });
});

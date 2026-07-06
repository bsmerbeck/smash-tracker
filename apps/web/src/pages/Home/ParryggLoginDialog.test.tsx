import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { ParryggLoginDialog } from './ParryggLoginDialog';
import { resetAuthMock, signInWithCustomToken } from '@/test/mockAuth';

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

const loginSearch = vi.fn();
const loginStart = vi.fn();
const loginComplete = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ApiError: actual.ApiError,
    api: {
      users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
      parrygg: {
        login: {
          search: (...args: unknown[]) => loginSearch(...args),
          start: (...args: unknown[]) => loginStart(...args),
          complete: (...args: unknown[]) => loginComplete(...args),
        },
      },
    },
  };
});

const CANDIDATE = { id: 'p1', gamerTag: 'Hungrybox', sponsorName: 'Liquid' };

function renderDialog(onOpenChange: (open: boolean) => void = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ParryggLoginDialog open onOpenChange={onOpenChange} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('ParryggLoginDialog', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
  });

  it('walks search -> pick -> code -> verify -> signed in', async () => {
    const user = userEvent.setup();
    loginSearch.mockResolvedValue([CANDIDATE]);
    loginStart.mockResolvedValue({
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      code: 'ST-ABC123',
      expiresAt: Date.now() + 600_000,
    });
    loginComplete.mockResolvedValue({ token: 'custom-token-xyz', gamerTag: 'Hungrybox' });
    signInWithCustomToken.mockResolvedValue({ user: { uid: 'parrygg-p1' } });

    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    await user.type(screen.getByLabelText(/parry\.gg gamer tag/i), 'hbox');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    expect(await screen.findByText('Hungrybox')).toBeInTheDocument();
    await user.click(screen.getByText('Hungrybox'));

    await waitFor(() => expect(loginStart).toHaveBeenCalledWith({ parryUserId: 'p1' }));
    expect(await screen.findByText('ST-ABC123')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(loginComplete).toHaveBeenCalledWith({ parryUserId: 'p1' }));
    expect(signInWithCustomToken).toHaveBeenCalledWith(expect.anything(), 'custom-token-xyz');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows no-match copy when search returns nothing', async () => {
    const user = userEvent.setup();
    loginSearch.mockResolvedValue([]);
    renderDialog();

    await user.type(screen.getByLabelText(/parry\.gg gamer tag/i), 'nobody');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    expect(await screen.findByText(/no matching parry\.gg accounts/i)).toBeInTheDocument();
  });

  it('shows an inline error when the code is not yet in the bio', async () => {
    const user = userEvent.setup();
    loginSearch.mockResolvedValue([CANDIDATE]);
    loginStart.mockResolvedValue({
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      code: 'ST-ABC123',
      expiresAt: Date.now() + 600_000,
    });
    const { ApiError } = await import('@/lib/api');
    loginComplete.mockRejectedValue(
      new ApiError(
        400,
        'Login code not found in your parry.gg bio yet. Paste "ST-ABC123" into your bio and try again.',
      ),
    );

    renderDialog();

    await user.type(screen.getByLabelText(/parry\.gg gamer tag/i), 'hbox');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await user.click(await screen.findByText('Hungrybox'));
    await screen.findByText('ST-ABC123');

    await user.click(screen.getByRole('button', { name: /^verify$/i }));

    expect(await screen.findByText(/code not found in your parry\.gg bio/i)).toBeInTheDocument();
    expect(signInWithCustomToken).not.toHaveBeenCalled();
  });

  it('offers a restart when the code has expired', async () => {
    const user = userEvent.setup();
    loginSearch.mockResolvedValue([CANDIDATE]);
    loginStart.mockResolvedValue({
      parryUserId: 'p1',
      gamerTag: 'Hungrybox',
      code: 'ST-ABC123',
      expiresAt: Date.now() + 600_000,
    });
    const { ApiError } = await import('@/lib/api');
    loginComplete.mockRejectedValue(
      new ApiError(
        400,
        'No login code is pending, or it has expired — start over and request a new one',
      ),
    );

    renderDialog();

    await user.type(screen.getByLabelText(/parry\.gg gamer tag/i), 'hbox');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await user.click(await screen.findByText('Hungrybox'));
    await screen.findByText('ST-ABC123');

    await user.click(screen.getByRole('button', { name: /^verify$/i }));

    expect(await screen.findByText(/that code expired/i)).toBeInTheDocument();
    const restartButton = screen.getByRole('button', { name: /start over/i });

    await user.click(restartButton);

    expect(await screen.findByLabelText(/parry\.gg gamer tag/i)).toHaveValue('');
  });

  it('surfaces a network failure from search without crashing', async () => {
    const user = userEvent.setup();
    loginSearch.mockRejectedValue(new Error('network down'));
    renderDialog();

    await user.type(screen.getByLabelText(/parry\.gg gamer tag/i), 'hbox');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    expect(await screen.findByText(/couldn't search parry\.gg right now/i)).toBeInTheDocument();
  });
});

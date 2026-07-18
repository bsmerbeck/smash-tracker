import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './AuthContext';
import { useAuth } from '@/hooks/useAuth';
import {
  resetAuthMock,
  signInWithEmailAndPassword,
  signInWithPopup,
  setMockUser,
  makeMockUser,
} from '@/test/mockAuth';

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
    EmailAuthProvider: mock.EmailAuthProvider,
    reauthenticateWithCredential: mock.reauthenticateWithCredential,
    updatePassword: mock.updatePassword,
    sendPasswordResetEmail: mock.sendPasswordResetEmail,
    updateProfile: mock.updateProfile,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
    },
  },
}));

const readReferral = vi.fn();
const clearReferral = vi.fn();
const stampReferral = vi.fn();

vi.mock('@/lib/shareReferral', () => ({
  read: (...args: unknown[]) => readReferral(...args),
  clear: (...args: unknown[]) => clearReferral(...args),
  stamp: (...args: unknown[]) => stampReferral(...args),
}));

const postCanonicalEvent = vi.fn();

vi.mock('@/lib/canonicalEvents', () => ({
  postCanonicalEvent: (...args: unknown[]) => postCanonicalEvent(...args),
}));

/** Minimal consumer exercising `signInWithEmail`, whose implementation calls
 * the module-private `provisionUser()` (FUNNEL-02 attribution) on success. */
function TestConsumer() {
  const { signInWithEmail } = useAuth();
  return (
    <button type="button" onClick={() => void signInWithEmail('test@example.com', 'password123')}>
      sign in
    </button>
  );
}

function renderWithProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** Minimal consumer exercising `signInWithGoogle` (MEAS-09: `signup_cta_clicked`). */
function GoogleTestConsumer() {
  const { signInWithGoogle } = useAuth();
  return (
    <button type="button" onClick={() => void signInWithGoogle()}>
      sign in with google
    </button>
  );
}

function renderWithGoogleProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <GoogleTestConsumer />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('AuthContext.provisionUser — referral attribution (FUNNEL-02)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    signInWithEmailAndPassword.mockResolvedValue(undefined);
    readReferral.mockReturnValue(null);
  });

  it('calls upsertMe with { referredByShareId } and clears the stamp when a fresh stamp is present', async () => {
    const user = userEvent.setup();
    readReferral.mockReturnValue('share-token-abc');
    renderWithProvider();

    await user.click(screen.getByRole('button', { name: 'sign in' }));

    await waitFor(() =>
      expect(upsertMe).toHaveBeenCalledExactlyOnceWith({ referredByShareId: 'share-token-abc' }),
    );
    expect(clearReferral).toHaveBeenCalledOnce();
  });

  it('calls upsertMe with no arguments (preserving the exact bodyless call) when no stamp is present', async () => {
    const user = userEvent.setup();
    readReferral.mockReturnValue(null);
    renderWithProvider();

    await user.click(screen.getByRole('button', { name: 'sign in' }));

    await waitFor(() => expect(upsertMe).toHaveBeenCalledTimes(1));
    expect(upsertMe).toHaveBeenCalledWith();
    expect(clearReferral).not.toHaveBeenCalled();
  });
});

describe('AuthContext — query cache clear on uid transition (FB-01)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    readReferral.mockReturnValue(null);
  });

  function renderWithQueryClient() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clearSpy = vi.spyOn(queryClient, 'clear');
    const cancelQueriesSpy = vi.spyOn(queryClient, 'cancelQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <div />
        </AuthProvider>
      </QueryClientProvider>,
    );
    return { queryClient, clearSpy, cancelQueriesSpy };
  }

  it('does NOT clear the query cache on the first onAuthStateChanged callback (app boot)', async () => {
    const { clearSpy } = renderWithQueryClient();

    // Give any pending microtasks a chance to run before asserting the negative.
    await waitFor(() => expect(clearSpy).not.toHaveBeenCalled());
  });

  it('cancels then clears the query cache on every subsequent uid transition, but not on a repeat of the same uid', async () => {
    const { clearSpy, cancelQueriesSpy } = renderWithQueryClient();

    expect(clearSpy).not.toHaveBeenCalled();

    // null -> uidA (sign-in)
    act(() => setMockUser(makeMockUser({ uid: 'uidA' })));
    await waitFor(() => expect(clearSpy).toHaveBeenCalledTimes(1));
    expect(cancelQueriesSpy).toHaveBeenCalledTimes(1);
    const cancelOrder = cancelQueriesSpy.mock.invocationCallOrder[0]!;
    const clearOrder = clearSpy.mock.invocationCallOrder[0]!;
    expect(cancelOrder).toBeLessThan(clearOrder);

    // uidA -> uidA again (same uid, no transition)
    act(() => setMockUser(makeMockUser({ uid: 'uidA' })));
    await Promise.resolve();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // uidA -> uidB (account switch)
    act(() => setMockUser(makeMockUser({ uid: 'uidB' })));
    await waitFor(() => expect(clearSpy).toHaveBeenCalledTimes(2));

    // uidB -> null (sign-out)
    act(() => setMockUser(null));
    await waitFor(() => expect(clearSpy).toHaveBeenCalledTimes(3));
  });
});

describe('AuthContext.signInWithGoogle — signup_cta_clicked (MEAS-09)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    readReferral.mockReturnValue(null);
    signInWithPopup.mockResolvedValue(undefined);
  });

  it('fires signup_cta_clicked once, before the popup is triggered', async () => {
    const callOrder: string[] = [];
    postCanonicalEvent.mockImplementation(() => callOrder.push('postCanonicalEvent'));
    signInWithPopup.mockImplementation(async () => {
      callOrder.push('signInWithPopup');
    });

    const user = userEvent.setup();
    renderWithGoogleProvider();

    await user.click(screen.getByRole('button', { name: 'sign in with google' }));

    await waitFor(() => expect(signInWithPopup).toHaveBeenCalledOnce());
    expect(postCanonicalEvent).toHaveBeenCalledExactlyOnceWith('signup_cta_clicked');
    expect(callOrder).toEqual(['postCanonicalEvent', 'signInWithPopup']);
  });
});

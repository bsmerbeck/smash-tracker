import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './AuthContext';
import { useAuth } from '@/hooks/useAuth';
import { useProfile, profileQueryKey } from '@/hooks/useProfile';
import {
  resetAuthMock,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signInWithCustomToken,
  getRedirectResult,
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
    signInWithRedirect: mock.signInWithRedirect,
    getRedirectResult: mock.getRedirectResult,
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
const getMe = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getMe: (...args: unknown[]) => getMe(...args),
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
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <GoogleTestConsumer />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy };
}

type ProvisioningAction =
  'signInWithEmail' | 'signUpWithEmail' | 'signInWithGoogle' | 'signInWithToken';

/** Mounts both `useAuth()` (to trigger a sign-in action) and `useProfile()`
 * (to observe the profile query's own resolved state) — the post-signup
 * profile-refresh tests below need to see the query actually unstick, not
 * just that `upsertMe` was called. */
function ProfileConsumer({ action }: { action: ProvisioningAction }) {
  const auth = useAuth();
  const { data: profile } = useProfile();
  const trigger = () => {
    switch (action) {
      case 'signInWithEmail':
        void auth.signInWithEmail('test@example.com', 'password123');
        return;
      case 'signUpWithEmail':
        void auth.signUpWithEmail('test@example.com', 'password123');
        return;
      case 'signInWithGoogle':
        void auth.signInWithGoogle();
        return;
      case 'signInWithToken':
        void auth.signInWithToken('mock-custom-token');
        return;
    }
  };
  return (
    <>
      <button type="button" onClick={trigger}>
        trigger
      </button>
      <div>{profile ? profile.email : 'no-profile'}</div>
    </>
  );
}

function renderWithProfileConsumer(action: ProvisioningAction) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const clearSpy = vi.spyOn(queryClient, 'clear');
  const cancelQueriesSpy = vi.spyOn(queryClient, 'cancelQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ProfileConsumer action={action} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy, clearSpy, cancelQueriesSpy };
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

describe('AuthContext.signInWithGoogle — popup-blocked redirect fallback (ONBD-01)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    readReferral.mockReturnValue(null);
  });

  it('falls back to signInWithRedirect ONLY on auth/popup-blocked, and never calls provisionUser (upsertMe) in this same attempt', async () => {
    signInWithPopup.mockRejectedValue(
      Object.assign(new Error('popup blocked'), { code: 'auth/popup-blocked' }),
    );
    signInWithRedirect.mockResolvedValue(undefined);

    const user = userEvent.setup();
    const { invalidateSpy } = renderWithGoogleProvider();

    await user.click(screen.getByRole('button', { name: 'sign in with google' }));

    await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledOnce());
    // The full-page navigation means nothing after signInWithRedirect runs
    // for THIS attempt — provisionUser (upsertMe) is NOT called here; it's
    // the boot-time getRedirectResult effect's job (see below). No profile
    // invalidation happens on this attempt either.
    expect(upsertMe).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: profileQueryKey }),
    );
  });

  it('re-throws every OTHER error unchanged (e.g. a genuine user cancel), never redirecting', async () => {
    const cancelError = Object.assign(new Error('popup closed'), {
      code: 'auth/popup-closed-by-user',
    });
    signInWithPopup.mockRejectedValue(cancelError);

    function ThrowingConsumer() {
      const { signInWithGoogle } = useAuth();
      const [caught, setCaught] = useState<string | null>(null);
      return (
        <button
          type="button"
          onClick={() =>
            void signInWithGoogle().catch((error: unknown) =>
              setCaught((error as { code?: string }).code ?? 'unknown'),
            )
          }
        >
          {caught ? `caught:${caught}` : 'sign in with google'}
        </button>
      );
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ThrowingConsumer />
        </AuthProvider>
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'sign in with google' }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'caught:auth/popup-closed-by-user' }),
      ).toBeInTheDocument(),
    );
    expect(signInWithRedirect).not.toHaveBeenCalled();
  });
});

describe('AuthContext — boot-time getRedirectResult completion (ONBD-01)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    readReferral.mockReturnValue(null);
  });

  it('calls provisionUser (upsertMe) when a redirect just completed (getRedirectResult resolves a credential)', async () => {
    getRedirectResult.mockResolvedValue({ user: makeMockUser() });

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider>
          <div />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(upsertMe).toHaveBeenCalledTimes(1));
  });

  it('does NOT call provisionUser on an ordinary boot (getRedirectResult resolves null — the default)', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider>
          <div />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getRedirectResult).toHaveBeenCalledOnce());
    expect(upsertMe).not.toHaveBeenCalled();
  });

  it('never throws / never blocks sign-in state when getRedirectResult rejects', async () => {
    getRedirectResult.mockRejectedValue(new Error('redirect_uri_mismatch'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider>
          <div />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getRedirectResult).toHaveBeenCalledOnce());
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    expect(upsertMe).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('AuthContext — post-signup profile refresh (fixes the post-signup black screen)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    readReferral.mockReturnValue(null);
    getMe.mockReset();
    // A prior test in this describe (the race-reproduction test below)
    // replaces `upsertMe`'s implementation with a manually-resolved deferred
    // promise; `vi.clearAllMocks()` clears call history but NOT mock
    // implementations, so every test needs its own explicit reset back to
    // the ordinary resolved-immediately baseline.
    upsertMe.mockReset().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
  });

  it('refetches the profile after a successful sign-up provision, unsticking a query parked on its earlier 404 (race reproduction)', async () => {
    // The signed-in uid is already stable across this render (set on the
    // FIRST onAuthStateChanged callback, which the FB-01 guard never clears
    // the cache for) so the profile query's 404->success transition below is
    // driven purely by the provision-then-invalidate fix under test, not
    // entangled with the FB-01 cache-clear race (that ordering is covered
    // separately below).
    setMockUser(makeMockUser());
    getMe.mockRejectedValueOnce(new Error('profile not found'));
    getMe.mockResolvedValue({ uid: 'test-uid', email: 'fresh@example.com' });
    createUserWithEmailAndPassword.mockResolvedValue(undefined);

    let resolveUpsert!: (value: { uid: string; email: string }) => void;
    upsertMe.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpsert = resolve;
        }),
    );

    const user = userEvent.setup();
    const { queryClient } = renderWithProfileConsumer('signUpWithEmail');

    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryClient.getQueryState(profileQueryKey)?.status).toBe('error'));
    expect(screen.getByText('no-profile')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'trigger' }));
    await waitFor(() => expect(upsertMe).toHaveBeenCalledTimes(1));

    // Before the fix, nothing would ever tell the query it's now
    // satisfiable — the deferred upsertMe resolving here is what confirms
    // the fix (not just a passage of time) drives the refetch.
    resolveUpsert({ uid: 'test-uid', email: 'fresh@example.com' });

    await waitFor(() => expect(screen.getByText('fresh@example.com')).toBeInTheDocument());
    expect(getMe).toHaveBeenCalledTimes(2);
  });

  it.each<[ProvisioningAction, () => void]>([
    ['signInWithEmail', () => signInWithEmailAndPassword.mockResolvedValue(undefined)],
    ['signUpWithEmail', () => createUserWithEmailAndPassword.mockResolvedValue(undefined)],
    ['signInWithGoogle', () => signInWithPopup.mockResolvedValue(undefined)],
    ['signInWithToken', () => signInWithCustomToken.mockResolvedValue(undefined)],
  ])('refreshes the profile query after a successful %s', async (action, arrangeAuthMock) => {
    arrangeAuthMock();
    getMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

    const user = userEvent.setup();
    const { invalidateSpy } = renderWithProfileConsumer(action);

    await user.click(screen.getByRole('button', { name: 'trigger' }));

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: profileQueryKey }),
      ),
    );
  });

  it('refreshes the profile query after the boot-time getRedirectResult credential branch provisions successfully', async () => {
    getRedirectResult.mockResolvedValue({ user: makeMockUser() });
    getMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <div />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(upsertMe).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: profileQueryKey }),
      ),
    );
  });

  it('never invalidates the profile query when the provision fails, but sign-in still resolves and the failure is logged', async () => {
    signInWithEmailAndPassword.mockResolvedValue(undefined);
    upsertMe.mockRejectedValueOnce(new Error('write failed'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const user = userEvent.setup();
    const { invalidateSpy } = renderWithProfileConsumer('signInWithEmail');

    await user.click(screen.getByRole('button', { name: 'trigger' }));

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: profileQueryKey }),
    );
    consoleErrorSpy.mockRestore();
  });

  it('orders the profile invalidation after the FB-01 cache clear when a flow both transitions uid and provisions', async () => {
    signInWithEmailAndPassword.mockImplementation(async () => {
      setMockUser(makeMockUser());
    });
    getMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

    const user = userEvent.setup();
    const { invalidateSpy, clearSpy } = renderWithProfileConsumer('signInWithEmail');

    await user.click(screen.getByRole('button', { name: 'trigger' }));

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: profileQueryKey }),
      ),
    );
    expect(clearSpy).toHaveBeenCalledTimes(1);

    const invalidateCallIndex = invalidateSpy.mock.calls.findIndex(([arg]) => {
      const queryKey = (arg as { queryKey?: unknown })?.queryKey;
      return (
        Array.isArray(queryKey) && JSON.stringify(queryKey) === JSON.stringify(profileQueryKey)
      );
    });
    const clearOrder = clearSpy.mock.invocationCallOrder[0]!;
    const invalidateOrder = invalidateSpy.mock.invocationCallOrder[invalidateCallIndex]!;
    expect(clearOrder).toBeLessThan(invalidateOrder);
  });
});

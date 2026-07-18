import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { SignInCard, POPUP_FOCUS_GRACE_MS } from './SignInCard';
import { resetAuthMock, signInWithPopup } from '@/test/mockAuth';

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
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

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
    },
    parrygg: {
      login: {
        search: vi.fn(),
        start: vi.fn(),
        complete: vi.fn(),
      },
    },
  },
  ApiError: class ApiError extends Error {},
}));

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SignInCard />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('SignInCard', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
  });

  it('surfaces a validation error when submitting an invalid email', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/enter a valid email address/i)).toBeInTheDocument();
  });
});

describe('SignInCard — Google popup abandonment grace timer (FB-02)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-enables all buttons via the focus-return grace timer while the popup promise is still pending, and suppresses a late popup-closed rejection toast', async () => {
    let rejectPending: ((error: unknown) => void) | undefined;
    const pending = new Promise((_resolve, reject) => {
      rejectPending = reject;
    });
    // Prevent an unhandled-rejection warning once the promise is rejected below.
    pending.catch(() => {});
    signInWithPopup.mockReturnValue(pending);

    renderCard();

    const googleButton = screen.getByRole('button', { name: /continue with google/i });
    const emailButton = screen.getByRole('button', { name: /^sign in$/i });

    // Plain fireEvent.click (not userEvent, which deadlocks against fake timers).
    act(() => {
      fireEvent.click(googleButton);
    });

    expect(googleButton).toBeDisabled();
    expect(emailButton).toBeDisabled();

    // Simulate the popup window closing and the main window regaining focus.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // Promise still unsettled at this point — the grace timer alone resets submitting.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POPUP_FOCUS_GRACE_MS);
    });

    expect(googleButton).not.toBeDisabled();
    expect(emailButton).not.toBeDisabled();
    expect(toastError).not.toHaveBeenCalled();

    // The popup's rejection finally arrives (Firebase v12's delayed settle) —
    // since buttons were already silently re-enabled, no confusing toast.
    await act(async () => {
      rejectPending?.({ code: 'auth/popup-closed-by-user' });
      await Promise.resolve();
    });

    expect(toastError).not.toHaveBeenCalled();

    // A retry still works — submitting can go true again.
    signInWithPopup.mockReturnValue(new Promise(() => {}));
    act(() => {
      fireEvent.click(googleButton);
    });
    expect(googleButton).toBeDisabled();
  });

  it('WR-01: a late rejection from an ABANDONED attempt never toasts, never re-enables the buttons mid-retry, and never kills the retry attempt’s grace timer', async () => {
    let rejectFirst: ((error: unknown) => void) | undefined;
    const firstPending = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    firstPending.catch(() => {});
    signInWithPopup.mockReturnValueOnce(firstPending);

    renderCard();
    const googleButton = screen.getByRole('button', { name: /continue with google/i });

    // Attempt 1: popup abandoned, grace timer re-enables the buttons while
    // the SDK promise is still pending (the FB-02 baseline).
    act(() => {
      fireEvent.click(googleButton);
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POPUP_FOCUS_GRACE_MS);
    });
    expect(googleButton).not.toBeDisabled();

    // Attempt 2: the user retries while attempt 1's promise is STILL pending.
    signInWithPopup.mockReturnValue(new Promise(() => {}));
    act(() => {
      fireEvent.click(googleButton);
    });
    expect(googleButton).toBeDisabled();

    // Attempt 1's rejection finally lands (7-8s late): it is stale — no
    // toast, and attempt 2's submitting state stays intact.
    await act(async () => {
      rejectFirst?.({ code: 'auth/popup-closed-by-user' });
      await Promise.resolve();
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(googleButton).toBeDisabled();

    // Attempt 2's own abandonment path still works — its focus-return grace
    // timer was NOT torn down by attempt 1's stale settle.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POPUP_FOCUS_GRACE_MS);
    });
    expect(googleButton).not.toBeDisabled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('still toasts when the popup rejects before the grace timer fires (e.g. auth/popup-blocked)', async () => {
    signInWithPopup.mockRejectedValue({ code: 'auth/popup-blocked' });
    renderCard();

    const googleButton = screen.getByRole('button', { name: /continue with google/i });

    await act(async () => {
      fireEvent.click(googleButton);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(googleButton).not.toBeDisabled();
  });
});

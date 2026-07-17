import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from './AuthContext';
import { useAuth } from '@/hooks/useAuth';
import { resetAuthMock, signInWithEmailAndPassword } from '@/test/mockAuth';

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
  return render(
    <AuthProvider>
      <TestConsumer />
    </AuthProvider>,
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

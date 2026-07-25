import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { OwnedWorkspace } from '@smash-tracker/shared';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { CoachAccessCard } from './CoachAccessCard';

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

import { AuthProvider } from '@/context/AuthContext';

const revokeDelegation = vi.fn();

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return { MockApiError };
});

vi.mock('@/lib/api', () => ({
  api: {
    clientWorkspaces: {
      revokeDelegation: (...args: unknown[]) => revokeDelegation(...args),
    },
  },
  ApiError: MockApiError,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderCard(workspace: OwnedWorkspace) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <CoachAccessCard workspace={workspace} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const withCoach: OwnedWorkspace = {
  tenantId: 't1',
  label: 'My Workspace',
  claimedAt: 1,
  delegateCoachUid: 'coach-1',
};

const withoutCoach: OwnedWorkspace = {
  tenantId: 't1',
  label: 'My Workspace',
  claimedAt: 1,
  delegateCoachUid: null,
};

describe('CoachAccessCard', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the delegated coach and offers a Revoke control when a coach is present', () => {
    renderCard(withCoach);
    expect(screen.getByText(/coach-1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  it('renders the no-coach-access state with no Revoke control when delegateCoachUid is null', () => {
    renderCard(withoutCoach);
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
  });

  it('cancelling the confirm step changes nothing and issues no request', () => {
    renderCard(withCoach);
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(revokeDelegation).not.toHaveBeenCalled();
  });

  it('confirming calls revokeDelegation exactly once and shows a success toast', async () => {
    revokeDelegation.mockResolvedValue(undefined);
    renderCard(withCoach);

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }));

    await waitFor(() => expect(revokeDelegation).toHaveBeenCalledTimes(1));
    expect(revokeDelegation).toHaveBeenCalledWith('t1', 'coach-1');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
  });

  it('a failed revoke shows an error toast and leaves the card in its prior state', async () => {
    revokeDelegation.mockRejectedValue(new Error('nope'));
    renderCard(withCoach);

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/coach-1/)).toBeInTheDocument();
  });
});

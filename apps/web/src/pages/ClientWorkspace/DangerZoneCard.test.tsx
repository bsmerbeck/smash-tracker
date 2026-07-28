import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { toast } from 'sonner';
import type { OwnedWorkspace } from '@smash-tracker/shared';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { DangerZoneCard } from './DangerZoneCard';

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

const deleteWorkspace = vi.fn();

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
      deleteWorkspace: (...args: unknown[]) => deleteWorkspace(...args),
    },
  },
  ApiError: MockApiError,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const workspace: OwnedWorkspace = {
  tenantId: 't1',
  label: 'My Workspace',
  claimedAt: 1,
  delegateCoachUid: 'coach-1',
};

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/workspace/t1/overview']}>
          <Routes>
            <Route
              path="/workspace/t1/overview"
              element={<DangerZoneCard workspace={workspace} />}
            />
            <Route path="/dashboard" element={<div>Personal Dashboard</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...utils, invalidateSpy };
}

describe('DangerZoneCard', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the confirmation dialog with the destructive button disabled until the exact label is typed', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /delete this workspace/i }));

    const confirmButton = screen.getByRole('button', { name: /^delete workspace$/i });
    expect(confirmButton).toBeDisabled();

    const input = screen.getByLabelText(/type "my workspace" to confirm/i);
    fireEvent.change(input, { target: { value: 'my workspace' } }); // wrong case
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'My Workspac' } }); // partial
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'My Workspace' } }); // exact
    expect(confirmButton).not.toBeDisabled();
  });

  it('confirming calls deleteWorkspace exactly once with the tenantId, invalidates both caches, and navigates to Personal', async () => {
    deleteWorkspace.mockResolvedValue(undefined);
    const { invalidateSpy } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: /delete this workspace/i }));
    const input = screen.getByLabelText(/type "my workspace" to confirm/i);
    fireEvent.change(input, { target: { value: 'My Workspace' } });
    fireEvent.click(screen.getByRole('button', { name: /^delete workspace$/i }));

    await waitFor(() => expect(deleteWorkspace).toHaveBeenCalledTimes(1));
    expect(deleteWorkspace).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Personal Dashboard')).toBeInTheDocument();

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(['client-workspaces']);
    expect(invalidatedKeys).toContainEqual(['coaching-clients']);
  });

  it('a 403 mid-flight surfaces an error toast instead of hanging, and does not navigate', async () => {
    deleteWorkspace.mockRejectedValue(new MockApiError(403, 'Access changed'));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /delete this workspace/i }));
    const input = screen.getByLabelText(/type "my workspace" to confirm/i);
    fireEvent.change(input, { target: { value: 'My Workspace' } });
    fireEvent.click(screen.getByRole('button', { name: /^delete workspace$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('Access changed');
    expect(screen.queryByText('Personal Dashboard')).not.toBeInTheDocument();
    // The dialog stays open (no hang, no silent success) so the owner sees why —
    // `onError` never clears `pendingDelete` or navigates.
    expect(screen.getByRole('button', { name: /^delete workspace$/i })).toBeInTheDocument();
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { OwnerWorkspaceOverviewPage } from './OwnerWorkspaceOverviewPage';

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

const workspacesList = vi.fn();
const matchesList = vi.fn();

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
      list: (...args: unknown[]) => workspacesList(...args),
      revokeDelegation: vi.fn(),
      deleteWorkspace: vi.fn(),
    },
    matches: {
      list: (...args: unknown[]) => matchesList(...args),
    },
  },
  ApiError: MockApiError,
}));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/workspace/:tenantId/overview" element={<OwnerWorkspaceOverviewPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('OwnerWorkspaceOverviewPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the workspace label and the Coach access card', async () => {
    workspacesList.mockResolvedValue([
      { tenantId: 't1', label: 'My Workspace', claimedAt: 1, delegateCoachUid: 'coach-1' },
    ]);
    matchesList.mockResolvedValue([]);

    renderAt('/workspace/t1/overview');

    expect(await screen.findByText(/My Workspace/)).toBeInTheDocument();
    expect(await screen.findByText('Coach access')).toBeInTheDocument();
  });

  // Quick 260726-r6: the owner-facing destructive "danger zone" section
  // renders below the Coach access card for a workspace this account owns.
  it('renders the danger zone delete-workspace affordance for an owned workspace', async () => {
    workspacesList.mockResolvedValue([
      { tenantId: 't1', label: 'My Workspace', claimedAt: 1, delegateCoachUid: 'coach-1' },
    ]);
    matchesList.mockResolvedValue([]);

    renderAt('/workspace/t1/overview');

    expect(await screen.findByText('Danger zone')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /delete this workspace/i }),
    ).toBeInTheDocument();
  });
});

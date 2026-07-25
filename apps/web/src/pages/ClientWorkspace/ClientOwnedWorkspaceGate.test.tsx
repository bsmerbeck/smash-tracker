import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { OwnedWorkspaceList } from '@smash-tracker/shared';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { ClientOwnedWorkspaceGate } from './ClientOwnedWorkspaceGate';

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

const list = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    clientWorkspaces: {
      list: (...args: unknown[]) => list(...args),
    },
  },
}));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/workspace/:tenantId/*"
              element={<ClientOwnedWorkspaceGate>{'workspace content'}</ClientOwnedWorkspaceGate>}
            />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('ClientOwnedWorkspaceGate', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  it('renders nothing while the owned-workspace list is loading', () => {
    list.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = renderAt('/workspace/t1/vods');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the children when the list contains the tenantId', async () => {
    const workspaces: OwnedWorkspaceList = [
      { tenantId: 't1', label: 'My Workspace', claimedAt: 1, delegateCoachUid: null },
    ];
    list.mockResolvedValue(workspaces);
    renderAt('/workspace/t1/vods');
    expect(await screen.findByText('workspace content')).toBeInTheDocument();
  });

  it('renders a not-authorized state when the list does not contain the tenantId', async () => {
    list.mockResolvedValue([]);
    renderAt('/workspace/t1/vods');
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
  });
});

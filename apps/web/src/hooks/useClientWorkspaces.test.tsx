import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  clientWorkspacesQueryKey,
  useClientWorkspaces,
  useRevokeCoachDelegation,
} from './useClientWorkspaces';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

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
const workspacesRevokeDelegation = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    clientWorkspaces: {
      list: (...args: unknown[]) => workspacesList(...args),
      revokeDelegation: (...args: unknown[]) => workspacesRevokeDelegation(...args),
    },
  },
}));

function Wrapper({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function ListProbe() {
  const list = useClientWorkspaces();
  if (!list.isSuccess) {
    return <div>loading</div>;
  }
  return <div>workspaces: {list.data.length}</div>;
}

function RevokeProbe({ tenantId, delegateUid }: { tenantId: string; delegateUid: string }) {
  const revoke = useRevokeCoachDelegation();
  return (
    <div>
      <button onClick={() => revoke.mutate({ tenantId, delegateUid })}>revoke</button>
      {revoke.isSuccess && <div>revoked</div>}
    </div>
  );
}

describe('useClientWorkspaces', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is disabled while the user is signed out', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <Wrapper queryClient={queryClient}>
        <ListProbe />
      </Wrapper>,
    );

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(workspacesList).not.toHaveBeenCalled();
  });

  it('calls api.clientWorkspaces.list() once signed in', async () => {
    setMockUser(makeMockUser());
    workspacesList.mockResolvedValue([
      { tenantId: 't1', label: 'Pandemic', claimedAt: 1, delegateCoachUid: 'coach1' },
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <Wrapper queryClient={queryClient}>
        <ListProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('workspaces: 1')).toBeInTheDocument());
    expect(workspacesList).toHaveBeenCalledTimes(1);
  });

  it('useRevokeCoachDelegation calls api.clientWorkspaces.revokeDelegation and invalidates clientWorkspacesQueryKey on success', async () => {
    setMockUser(makeMockUser());
    workspacesRevokeDelegation.mockResolvedValue(undefined);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient}>
        <RevokeProbe tenantId="t1" delegateUid="coach1" />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('revoke'));

    await waitFor(() => expect(screen.getByText('revoked')).toBeInTheDocument());
    expect(workspacesRevokeDelegation).toHaveBeenCalledWith('t1', 'coach1');

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(clientWorkspacesQueryKey);
  });
});

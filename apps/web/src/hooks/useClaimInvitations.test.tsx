import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  claimInvitationStatusQueryKey,
  useClaimInvitationStatus,
  useIssueClaimInvitation,
  useRevokeClaimInvitation,
} from './useClaimInvitations';
import { coachingClientsQueryKey } from './useCoachingClients';
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

const claimsStatus = vi.fn();
const claimsIssue = vi.fn();
const claimsRevoke = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    claims: {
      status: (...args: unknown[]) => claimsStatus(...args),
      issue: (...args: unknown[]) => claimsIssue(...args),
      revoke: (...args: unknown[]) => claimsRevoke(...args),
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

function StatusProbe({ clientId }: { clientId?: string }) {
  const status = useClaimInvitationStatus(clientId);
  if (!status.isSuccess) {
    return <div>loading</div>;
  }
  return <div>outstanding: {String(status.data.outstanding)}</div>;
}

function IssueProbe({ clientId }: { clientId: string }) {
  const issue = useIssueClaimInvitation();
  return (
    <div>
      <button onClick={() => issue.mutate(clientId)}>issue</button>
      {issue.isSuccess && <div>code: {issue.data.code}</div>}
    </div>
  );
}

function RevokeProbe({ clientId }: { clientId: string }) {
  const revoke = useRevokeClaimInvitation();
  return (
    <div>
      <button onClick={() => revoke.mutate(clientId)}>revoke</button>
      {revoke.isSuccess && <div>revoked</div>}
    </div>
  );
}

describe('useClaimInvitations', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('useClaimInvitationStatus is disabled when the user is signed out', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <Wrapper queryClient={queryClient}>
        <StatusProbe clientId="tetra" />
      </Wrapper>,
    );

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(claimsStatus).not.toHaveBeenCalled();
  });

  it('useClaimInvitationStatus is disabled when clientId is empty', () => {
    setMockUser(makeMockUser());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <Wrapper queryClient={queryClient}>
        <StatusProbe />
      </Wrapper>,
    );

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(claimsStatus).not.toHaveBeenCalled();
  });

  it('useClaimInvitationStatus calls api.claims.status(clientId) once signed in with a clientId', async () => {
    setMockUser(makeMockUser());
    claimsStatus.mockResolvedValue({ outstanding: true, expiresAt: 1000 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <Wrapper queryClient={queryClient}>
        <StatusProbe clientId="tetra" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('outstanding: true')).toBeInTheDocument());
    expect(claimsStatus).toHaveBeenCalledWith('tetra');
  });

  it('useIssueClaimInvitation resolves { code, expiresAt } and invalidates both keys on success', async () => {
    setMockUser(makeMockUser());
    claimsIssue.mockResolvedValue({ code: 'ABCDE-FGHJK', expiresAt: 5000 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient}>
        <IssueProbe clientId="tetra" />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('issue'));

    await waitFor(() => expect(screen.getByText('code: ABCDE-FGHJK')).toBeInTheDocument());
    expect(claimsIssue).toHaveBeenCalledWith('tetra');

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(coachingClientsQueryKey);
    expect(invalidatedKeys).toContainEqual(claimInvitationStatusQueryKey('tetra'));
  });

  it('useRevokeClaimInvitation invalidates both keys on success', async () => {
    setMockUser(makeMockUser());
    claimsRevoke.mockResolvedValue(undefined);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <Wrapper queryClient={queryClient}>
        <RevokeProbe clientId="tetra" />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('revoke'));

    await waitFor(() => expect(screen.getByText('revoked')).toBeInTheDocument());
    expect(claimsRevoke).toHaveBeenCalledWith('tetra');

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(coachingClientsQueryKey);
    expect(invalidatedKeys).toContainEqual(claimInvitationStatusQueryKey('tetra'));
  });

  it('never writes the issued code into the query cache — only the mutation result carries it', async () => {
    setMockUser(makeMockUser());
    claimsIssue.mockResolvedValue({ code: 'SECRET-CODE', expiresAt: 5000 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <Wrapper queryClient={queryClient}>
        <IssueProbe clientId="tetra" />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('issue'));

    await waitFor(() => expect(screen.getByText('code: SECRET-CODE')).toBeInTheDocument());

    const cacheDump = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    );
    expect(cacheDump).not.toContain('SECRET-CODE');
  });
});

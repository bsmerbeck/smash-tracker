import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useCreateGroup,
  useDeleteGroup,
  useGroupLeaderboard,
  useGroups,
  useJoinGroup,
  useLeaveGroup,
} from './useGroups';
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

const groupsList = vi.fn();
const groupsCreate = vi.fn();
const groupsJoin = vi.fn();
const groupsLeaderboard = vi.fn();
const groupsLeave = vi.fn();
const groupsRemove = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    groups: {
      list: (...args: unknown[]) => groupsList(...args),
      create: (...args: unknown[]) => groupsCreate(...args),
      join: (...args: unknown[]) => groupsJoin(...args),
      leaderboard: (...args: unknown[]) => groupsLeaderboard(...args),
      leave: (...args: unknown[]) => groupsLeave(...args),
      remove: (...args: unknown[]) => groupsRemove(...args),
    },
  },
}));

const GROUP = {
  id: 'g1',
  name: 'The Crew',
  ownerUid: 'test-uid',
  inviteCode: 'ABCDEFGH',
  createdAt: 1_700_000_000_000,
  memberCount: 2,
};

const LEADERBOARD = {
  group: GROUP,
  entries: [
    {
      uid: 'test-uid',
      displayName: 'Me',
      rating: 1550,
      rd: 120,
      games: 10,
      lastMatchAt: 1_700_000_000_000,
      isYou: true,
    },
  ],
};

function Wrapper({ children }: { children: ReactNode }) {
  const [queryClient] = [new QueryClient({ defaultOptions: { queries: { retry: false } } })];
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function ListProbe() {
  const list = useGroups();
  if (!list.isSuccess) {
    return <div>loading</div>;
  }
  return <div>groups: {list.data.length}</div>;
}

function CreateProbe() {
  const create = useCreateGroup();
  return (
    <div>
      <button onClick={() => create.mutate('The Crew')}>create</button>
      {create.isSuccess && <div>created: {create.data.name}</div>}
    </div>
  );
}

function JoinProbe() {
  const join = useJoinGroup();
  return (
    <div>
      <button onClick={() => join.mutate('ABCDEFGH')}>join</button>
      {join.isSuccess && <div>joined: {join.data.name}</div>}
    </div>
  );
}

function LeaderboardProbe({ groupId }: { groupId: string | null }) {
  const leaderboard = useGroupLeaderboard(groupId);
  if (!leaderboard.isSuccess) {
    return <div>loading</div>;
  }
  return <div>entries: {leaderboard.data.entries.length}</div>;
}

function LeaveProbe() {
  const leave = useLeaveGroup();
  return (
    <div>
      <button onClick={() => leave.mutate('g1')}>leave</button>
      {leave.isSuccess && <div>left</div>}
    </div>
  );
}

function DeleteProbe() {
  const del = useDeleteGroup();
  return (
    <div>
      <button onClick={() => del.mutate('g1')}>delete</button>
      {del.isSuccess && <div>deleted</div>}
    </div>
  );
}

describe('useGroups', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('useGroups resolves the list response', async () => {
    groupsList.mockResolvedValue([GROUP]);

    render(
      <Wrapper>
        <ListProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('groups: 1')).toBeInTheDocument());
  });

  it('useCreateGroup posts the name and resolves the created group', async () => {
    groupsCreate.mockResolvedValue(GROUP);

    render(
      <Wrapper>
        <CreateProbe />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('create'));

    await waitFor(() => expect(screen.getByText('created: The Crew')).toBeInTheDocument());
    expect(groupsCreate).toHaveBeenCalledWith('The Crew');
  });

  it('useJoinGroup posts the code and resolves the joined group', async () => {
    groupsJoin.mockResolvedValue(GROUP);

    render(
      <Wrapper>
        <JoinProbe />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('join'));

    await waitFor(() => expect(screen.getByText('joined: The Crew')).toBeInTheDocument());
    expect(groupsJoin).toHaveBeenCalledWith('ABCDEFGH');
  });

  it('useGroupLeaderboard resolves the leaderboard response when a groupId is given', async () => {
    groupsLeaderboard.mockResolvedValue(LEADERBOARD);

    render(
      <Wrapper>
        <LeaderboardProbe groupId="g1" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('entries: 1')).toBeInTheDocument());
    expect(groupsLeaderboard).toHaveBeenCalledWith('g1');
  });

  it('useGroupLeaderboard does not fetch when groupId is null', () => {
    render(
      <Wrapper>
        <LeaderboardProbe groupId={null} />
      </Wrapper>,
    );

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(groupsLeaderboard).not.toHaveBeenCalled();
  });

  it('useLeaveGroup resolves on success', async () => {
    groupsLeave.mockResolvedValue(undefined);

    render(
      <Wrapper>
        <LeaveProbe />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('leave'));

    await waitFor(() => expect(screen.getByText('left')).toBeInTheDocument());
    expect(groupsLeave).toHaveBeenCalledWith('g1');
  });

  it('useDeleteGroup resolves on success', async () => {
    groupsRemove.mockResolvedValue(undefined);

    render(
      <Wrapper>
        <DeleteProbe />
      </Wrapper>,
    );

    fireEvent.click(screen.getByText('delete'));

    await waitFor(() => expect(screen.getByText('deleted')).toBeInTheDocument());
    expect(groupsRemove).toHaveBeenCalledWith('g1');
  });
});

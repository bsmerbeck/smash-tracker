import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { GroupsPage } from './GroupsPage';
import { ApiError } from '@/lib/api';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

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

const groupsList = vi.fn();
const groupsCreate = vi.fn();
const groupsJoin = vi.fn();
const groupsLeaderboard = vi.fn();
const groupsLeave = vi.fn();
const groupsRemove = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    api: {
      users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
      groups: {
        list: (...args: unknown[]) => groupsList(...args),
        create: (...args: unknown[]) => groupsCreate(...args),
        join: (...args: unknown[]) => groupsJoin(...args),
        leaderboard: (...args: unknown[]) => groupsLeaderboard(...args),
        leave: (...args: unknown[]) => groupsLeave(...args),
        remove: (...args: unknown[]) => groupsRemove(...args),
      },
    },
    ApiError: MockApiError,
  };
});

const OWNED_GROUP = {
  id: 'g1',
  name: 'The Crew',
  ownerUid: 'test-uid',
  inviteCode: 'ABCDEFGH',
  createdAt: 1_700_000_000_000,
  memberCount: 2,
};

const MEMBER_GROUP = {
  id: 'g2',
  name: 'Locals Group',
  ownerUid: 'someone-else',
  inviteCode: 'ZZZZ2222',
  createdAt: 1_700_000_000_000,
  memberCount: 3,
};

const LEADERBOARD_FOR_OWNED = {
  group: OWNED_GROUP,
  entries: [
    {
      uid: 'test-uid',
      displayName: 'Me',
      rating: 1600,
      rd: 90,
      games: 20,
      lastMatchAt: Date.now() - 60 * 60 * 1000,
      isYou: true,
    },
    {
      uid: 'friend-uid',
      displayName: 'Friendo',
      rating: 1500,
      rd: 200,
      games: 5,
      lastMatchAt: null,
      isYou: false,
    },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/groups']}>
        <AuthProvider>
          <Routes>
            <Route path="/groups" element={<GroupsPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GroupsPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  it('shows the empty state when the caller has no groups', async () => {
    groupsList.mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText('No groups yet')).toBeInTheDocument();
  });

  it('lists the caller groups as cards', async () => {
    groupsList.mockResolvedValue([OWNED_GROUP, MEMBER_GROUP]);

    renderPage();

    expect(await screen.findByText('The Crew')).toBeInTheDocument();
    expect(screen.getByText('Locals Group')).toBeInTheDocument();
    expect(screen.getByText('2 members')).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
  });

  it('selecting a group loads and renders its leaderboard, highlighting the caller row', async () => {
    const user = userEvent.setup();
    groupsList.mockResolvedValue([OWNED_GROUP]);
    groupsLeaderboard.mockResolvedValue(LEADERBOARD_FOR_OWNED);

    renderPage();
    await user.click(await screen.findByText('The Crew'));

    expect(await screen.findByRole('heading', { name: 'The Crew' })).toBeInTheDocument();
    expect(screen.getByText('Me')).toBeInTheDocument();
    expect(screen.getByText('Friendo')).toBeInTheDocument();
    expect(screen.getByText('(you)')).toBeInTheDocument();
    expect(screen.getByText('ABCDEFGH')).toBeInTheDocument();
    expect(groupsLeaderboard).toHaveBeenCalledWith('g1');
  });

  it('shows Delete for the owner and Leave for a non-owner member', async () => {
    const user = userEvent.setup();
    groupsList.mockResolvedValue([OWNED_GROUP, MEMBER_GROUP]);
    groupsLeaderboard.mockImplementation((groupId: string) =>
      Promise.resolve(
        groupId === 'g1'
          ? LEADERBOARD_FOR_OWNED
          : {
              group: MEMBER_GROUP,
              entries: [{ ...LEADERBOARD_FOR_OWNED.entries[0], isYou: false }],
            },
      ),
    );

    renderPage();

    await user.click(await screen.findByText('The Crew'));
    expect(await screen.findByRole('button', { name: 'Delete group' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave group' })).not.toBeInTheDocument();

    await user.click(screen.getByText('Locals Group'));
    expect(await screen.findByRole('button', { name: 'Leave group' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete group' })).not.toBeInTheDocument();
  });

  it('creates a group via the dialog and selects it', async () => {
    const user = userEvent.setup();
    groupsList.mockResolvedValueOnce([]).mockResolvedValue([OWNED_GROUP]);
    groupsCreate.mockResolvedValue(OWNED_GROUP);
    groupsLeaderboard.mockResolvedValue(LEADERBOARD_FOR_OWNED);

    renderPage();
    await screen.findByText('No groups yet');

    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.type(screen.getByLabelText('Group name'), 'The Crew');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(groupsCreate).toHaveBeenCalledWith('The Crew'));
    expect(await screen.findByRole('heading', { name: 'The Crew' })).toBeInTheDocument();
  });

  it('joins a group via the dialog and selects it', async () => {
    const user = userEvent.setup();
    groupsList.mockResolvedValueOnce([]).mockResolvedValue([OWNED_GROUP]);
    groupsJoin.mockResolvedValue(OWNED_GROUP);
    groupsLeaderboard.mockResolvedValue(LEADERBOARD_FOR_OWNED);

    renderPage();
    await screen.findByText('No groups yet');

    await user.click(screen.getByRole('button', { name: 'Join with code' }));
    await user.type(screen.getByLabelText('Invite code'), 'abcdefgh');
    await user.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(groupsJoin).toHaveBeenCalledWith('ABCDEFGH'));
    expect(await screen.findByRole('heading', { name: 'The Crew' })).toBeInTheDocument();
  });

  it('shows an inline destructive alert with the API message when joining fails', async () => {
    const user = userEvent.setup();
    groupsList.mockResolvedValue([]);
    groupsJoin.mockRejectedValue(new ApiError(404, 'No group found for that invite code'));

    renderPage();
    await screen.findByText('No groups yet');

    await user.click(screen.getByRole('button', { name: 'Join with code' }));
    await user.type(screen.getByLabelText('Invite code'), 'NOPE0000');
    await user.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByText('No group found for that invite code')).toBeInTheDocument();
  });

  it('deletes the group as owner via the confirm dialog and clears the selection', async () => {
    const user = userEvent.setup();
    groupsList.mockResolvedValueOnce([OWNED_GROUP]).mockResolvedValue([]);
    groupsLeaderboard.mockResolvedValue(LEADERBOARD_FOR_OWNED);
    groupsRemove.mockResolvedValue(undefined);

    renderPage();
    await user.click(await screen.findByText('The Crew'));
    await screen.findByRole('heading', { name: 'The Crew' });

    await user.click(screen.getByRole('button', { name: 'Delete group' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(groupsRemove).toHaveBeenCalledWith('g1'));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'The Crew' })).not.toBeInTheDocument(),
    );
  });

  it('leaves the group as a non-owner via the confirm dialog and clears the selection', async () => {
    const user = userEvent.setup();
    groupsList.mockResolvedValueOnce([MEMBER_GROUP]).mockResolvedValue([]);
    groupsLeaderboard.mockResolvedValue({
      group: MEMBER_GROUP,
      entries: [{ ...LEADERBOARD_FOR_OWNED.entries[0], isYou: true }],
    });
    groupsLeave.mockResolvedValue(undefined);

    renderPage();
    await user.click(await screen.findByText('Locals Group'));
    await screen.findByRole('heading', { name: 'Locals Group' });

    await user.click(screen.getByRole('button', { name: 'Leave group' }));
    await user.click(screen.getByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(groupsLeave).toHaveBeenCalledWith('g2'));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Locals Group' })).not.toBeInTheDocument(),
    );
  });
});

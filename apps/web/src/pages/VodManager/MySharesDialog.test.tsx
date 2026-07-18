import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ShareSummary } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { MySharesDialog } from './MySharesDialog';

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

const listVodShares = vi.fn();
const revokeVodShare = vi.fn().mockResolvedValue(undefined);
const bulkVodShares = vi.fn().mockResolvedValue({ processed: 0, skipped: 0 });
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      users: {
        upsertMe: (...args: unknown[]) => upsertMe(...args),
      },
      vodShares: {
        list: (...args: unknown[]) => listVodShares(...args),
        revoke: (...args: unknown[]) => revokeVodShare(...args),
        bulk: (...args: unknown[]) => bulkVodShares(...args),
      },
    },
  };
});

function activeShare(overrides: Partial<ShareSummary> = {}): ShareSummary {
  return {
    shareId: 'share-active',
    matchId: 'match-1',
    permissions: 'view',
    createdAt: 1_700_000_000_000,
    redaction: { includedNotes: true, includedTags: false, showDisplayName: false },
    status: 'active',
    url: 'https://grandfinals.gg/s/tok-active',
    result: 'win',
    fighterId: 1,
    opponentFighterId: 8,
    ...overrides,
  };
}

function revokedShare(overrides: Partial<ShareSummary> = {}): ShareSummary {
  return activeShare({
    shareId: 'share-revoked',
    status: 'revoked',
    revokedAt: 1_700_100_000_000,
    url: 'https://grandfinals.gg/s/tok-revoked',
    ...overrides,
  });
}

function renderDialog(onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MySharesDialog open onOpenChange={onOpenChange} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('MySharesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    listVodShares.mockResolvedValue([activeShare(), revokedShare()]);
    revokeVodShare.mockResolvedValue(undefined);
    bulkVodShares.mockResolvedValue({ processed: 2, skipped: 0 });
  });

  afterEach(() => {
    resetAuthMock();
  });

  it('lists active and revoked shares with the correct row treatment', async () => {
    renderDialog();

    await screen.findByText('My shares');
    expect(await screen.findAllByText('Mario vs Fox')).toHaveLength(2);
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    // Active row exposes copy + revoke actions; the revoked row drops both.
    expect(screen.getAllByRole('button', { name: 'Copy share link' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Revoke share link' })).toHaveLength(1);
  });

  it('clicking Revoke opens the honest-copy AlertDialog and confirming invokes the revoke mutation', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Revoke share link' }));

    expect(await screen.findByText('Revoke this share link?')).toBeInTheDocument();
    expect(
      screen.getByText(
        'People who already opened it lose access now. Previews already posted in Discord may keep showing the old preview.',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke link' }));

    await waitFor(() => expect(revokeVodShare).toHaveBeenCalledWith('share-active'));
  });

  it('shows the empty state when there are no shares', async () => {
    listVodShares.mockResolvedValue([]);
    renderDialog();

    expect(await screen.findByText('No shares yet')).toBeInTheDocument();
    expect(
      screen.getByText('Share a VOD review from its Share button to see it listed here.'),
    ).toBeInTheDocument();
  });
});

describe('MySharesDialog selection mode + bulk actions (FB-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    listVodShares.mockResolvedValue([activeShare(), revokedShare()]);
    revokeVodShare.mockResolvedValue(undefined);
    bulkVodShares.mockResolvedValue({ processed: 2, skipped: 0 });
  });

  afterEach(() => {
    resetAuthMock();
  });

  it('entering selection mode reveals per-row checkboxes, select-all, and a live count', async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findAllByText('Mario vs Fox');
    await user.click(screen.getByRole('button', { name: 'Select' }));

    // select-all + 2 per-row checkboxes.
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByText('0 selected')).toBeInTheDocument();
    // Bulk buttons are disabled with nothing selected.
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('selecting two shares and confirming bulk Revoke fires ONE mutation with both ids, then clears selection', async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findAllByText('Mario vs Fox');
    await user.click(screen.getByRole('button', { name: 'Select' }));

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: 'Select this share' });
    expect(rowCheckboxes).toHaveLength(2);
    await user.click(rowCheckboxes[0]!);
    await user.click(rowCheckboxes[1]!);

    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    // ONE dialog-level confirm summarizing the count for this action.
    expect(await screen.findByText('Revoke selected share links?')).toBeInTheDocument();
    expect(
      screen.getByText(
        'People who already opened these 2 links lose access now. Previews already posted in Discord may keep showing the old preview.',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke link' }));

    await waitFor(() => expect(bulkVodShares).toHaveBeenCalledTimes(1));
    expect(bulkVodShares).toHaveBeenCalledWith({
      action: 'revoke',
      shareIds: expect.arrayContaining(['share-active', 'share-revoked']),
    });
    // Selection cleared + selection mode exited after a successful bulk action.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument(),
    );
  });

  it('bulk Delete opens its own count-summarizing confirm and fires the delete action', async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findAllByText('Mario vs Fox');
    await user.click(screen.getByRole('button', { name: 'Select' }));

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: 'Select this share' });
    await user.click(rowCheckboxes[0]!);

    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Delete selected share links?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(bulkVodShares).toHaveBeenCalledWith({
        action: 'delete',
        shareIds: ['share-active'],
      }),
    );
    expect(bulkVodShares).toHaveBeenCalledTimes(1);
  });

  it('leaving selection mode via Cancel clears the selection', async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findAllByText('Mario vs Fox');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const rowCheckboxes = screen.getAllByRole('checkbox', { name: 'Select this share' });
    await user.click(rowCheckboxes[0]!);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Selection UI is gone entirely (selectionMode false).
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

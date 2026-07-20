import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { ShareDialog } from './ShareDialog';

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

const listVodShares = vi.fn().mockResolvedValue([]);
const createVodShare = vi.fn();
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
        create: (...args: unknown[]) => createVodShare(...args),
      },
    },
  };
});

function baseMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'match-1',
    fighter_id: 1,
    opponent_id: 8,
    time: 1_700_000_000_000,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: 'close game',
    matchType: 'offline-tourney',
    win: true,
    vodUrl: 'https://youtube.com/watch?v=abc123',
    ...overrides,
  };
}

function renderDialog(match: Match, onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ShareDialog match={match} open onOpenChange={onOpenChange} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('ShareDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listVodShares.mockResolvedValue([]);
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    resetAuthMock();
  });

  it('renders the create step with the three toggles at their default states', async () => {
    renderDialog(baseMatch());

    expect(await screen.findByText('Share this review')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Include your notes' })).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(screen.getByRole('switch', { name: 'Include tags' })).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(screen.getByRole('switch', { name: 'Show your display name' })).toHaveAttribute(
      'data-state',
      'unchecked',
    );

    expect(screen.getByText('Match result')).toBeInTheDocument();
    expect(screen.getByText('Characters')).toBeInTheDocument();
    expect(screen.getByText('Stage')).toBeInTheDocument();
    expect(screen.getByText('Your notes')).toBeInTheDocument();
    expect(screen.getByText('Tags')).toBeInTheDocument();
    expect(screen.queryByText('Your name')).not.toBeInTheDocument();
  });

  it('toggling updates the summary chips (account with a display name)', async () => {
    setMockUser(makeMockUser({ displayName: 'TestPlayer' }));
    const user = userEvent.setup();
    renderDialog(baseMatch());

    await screen.findByText('Share this review');
    await user.click(screen.getByRole('switch', { name: 'Include your notes' }));
    await user.click(screen.getByRole('switch', { name: 'Show your display name' }));

    expect(screen.queryByText('Your notes')).not.toBeInTheDocument();
    expect(screen.getByText('Your name')).toBeInTheDocument();
  });

  it('disables the display-name toggle and never shows the Name chip when the account has no display name', async () => {
    // Default mock user has no displayName — the server would silently drop
    // the name, so the dialog must not pretend one will be attached.
    renderDialog(baseMatch());

    await screen.findByText('Share this review');
    const nameSwitch = screen.getByRole('switch', { name: 'Show your display name' });
    expect(nameSwitch).toBeDisabled();
    expect(
      screen.getByText('Your account has no display name — set one in Profile to attach it'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Your name')).not.toBeInTheDocument();
  });

  it('submitting calls the create mutation and advances to the created step showing the url', async () => {
    const user = userEvent.setup();
    createVodShare.mockResolvedValue({
      shareId: 'share-1',
      token: 'tok',
      url: 'https://grandfinals.gg/s/tok',
    });
    renderDialog(baseMatch());

    await screen.findByText('Share this review');
    await user.click(screen.getByRole('button', { name: 'Create share link' }));

    await waitFor(() => expect(createVodShare).toHaveBeenCalledTimes(1));
    expect(createVodShare).toHaveBeenCalledWith({
      kind: 'review',
      matchId: 'match-1',
      permissions: 'view',
      redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
    });

    expect(await screen.findByText('Share link ready')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://grandfinals.gg/s/tok')).toBeInTheDocument();
  });

  it('defaults the permission tier to View with the view-tier helper copy', async () => {
    renderDialog(baseMatch());

    await screen.findByText('Share this review');
    expect(screen.getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Edit (coaching)' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(
      screen.getByText(
        'The link holder can watch and read what you include — nothing on this review can be changed.',
      ),
    ).toBeInTheDocument();
  });

  it('selecting Edit shows the honest coaching copy and sends permissions: edit on a review-kind create', async () => {
    // COACH-01: the edit tier is only ever offered for VOD reviews — this
    // dialog structurally cannot create a recap (`kind: 'review'` is
    // hardcoded in its create body, asserted below); the recap surface
    // (GenerateRecapDialog) has no tier control at all, and the API's
    // createShareInputSchema refine 400s a recap+edit combination anyway.
    const user = userEvent.setup();
    createVodShare.mockResolvedValue({
      shareId: 'share-1',
      token: 'tok',
      url: 'https://grandfinals.gg/s/tok',
    });
    renderDialog(baseMatch());

    await screen.findByText('Share this review');
    await user.click(screen.getByRole('radio', { name: 'Edit (coaching)' }));

    // Honest copy: what an edit link allows + the 30-day expiry.
    expect(
      screen.getByText(
        "A coach with this link can add and manage their own timestamped notes on this review. They can't touch your notes, the match details, or the VOD. Edit links expire after 30 days.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create share link' }));

    await waitFor(() => expect(createVodShare).toHaveBeenCalledTimes(1));
    expect(createVodShare).toHaveBeenCalledWith({
      kind: 'review',
      matchId: 'match-1',
      permissions: 'edit',
      redaction: { includeNotes: true, includeTags: true, showDisplayName: false },
    });
  });

  it('re-opening after a share was created resets to the create step (fresh share, defaults restored)', async () => {
    // Regression: the reset used to live only in Radix's onOpenChange, which
    // never fires when the PARENT flips the controlled `open` prop — so
    // re-clicking Share showed the stale 'created' step of the previous link.
    const user = userEvent.setup();
    createVodShare.mockResolvedValue({
      shareId: 'share-1',
      token: 'tok',
      url: 'https://grandfinals.gg/s/tok',
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const dialogAt = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ShareDialog match={baseMatch()} open={open} onOpenChange={vi.fn()} />
        </AuthProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(dialogAt(true));

    await screen.findByText('Share this review');
    await user.click(screen.getByRole('radio', { name: 'Edit (coaching)' }));
    await user.click(screen.getByRole('button', { name: 'Create share link' }));
    expect(await screen.findByText('Share link ready')).toBeInTheDocument();

    // Parent closes (Done) and re-opens via the Share button — prop-driven,
    // no Radix interaction involved.
    rerender(dialogAt(false));
    rerender(dialogAt(true));

    expect(await screen.findByText('Share this review')).toBeInTheDocument();
    expect(screen.queryByText('Share link ready')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show your display name' })).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    // The tier resets to the View default too — a fresh share never
    // silently inherits the previous link's coaching permission.
    expect(screen.getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');
  });

  it('clicking Copy invokes the clipboard API and shows the copied affordance', async () => {
    // userEvent.setup() eagerly installs a Clipboard stub on `navigator.clipboard`
    // (jsdom has no real Clipboard API), so the spy must attach to that
    // stub's `writeText` rather than pre-defining `navigator.clipboard` —
    // setup() would otherwise clobber a pre-existing mock.
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    createVodShare.mockResolvedValue({
      shareId: 'share-1',
      token: 'tok',
      url: 'https://grandfinals.gg/s/tok',
    });
    renderDialog(baseMatch());

    await screen.findByText('Share this review');
    await user.click(screen.getByRole('button', { name: 'Create share link' }));
    await screen.findByText('Share link ready');

    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(writeTextSpy).toHaveBeenCalledWith('https://grandfinals.gg/s/tok'));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });
});

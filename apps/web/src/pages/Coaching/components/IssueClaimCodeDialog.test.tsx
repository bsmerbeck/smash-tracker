import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { IssueClaimCodeDialog } from './IssueClaimCodeDialog';

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

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const claimsStatus = vi.fn();
const claimsIssue = vi.fn();
const claimsRevoke = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      claims: {
        status: (...args: unknown[]) => claimsStatus(...args),
        issue: (...args: unknown[]) => claimsIssue(...args),
        revoke: (...args: unknown[]) => claimsRevoke(...args),
      },
    },
  };
});

const { toast } = await import('sonner');
const { ApiError } = await import('@/lib/api');

function renderDialog(open = true, onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <IssueClaimCodeDialog
          client={{ clientId: 'tetra', label: 'Tetra' }}
          open={open}
          onOpenChange={onOpenChange}
        />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange, queryClient };
}

describe('IssueClaimCodeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimsStatus.mockResolvedValue({ outstanding: false, expiresAt: null });
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    resetAuthMock();
  });

  it('shows the create step with the rotation warning and a Generate button when nothing is outstanding', async () => {
    renderDialog();

    expect(await screen.findByText('Generate a claim code')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Create a one-time code your client uses to claim this workspace as their own.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Generating a new code immediately invalidates the outstanding one — hand off only the code shown here.',
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText('No claim code is currently active for this client.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Generate claim code/ })).toBeInTheDocument();
  });

  it('clicking Generate calls api.claims.issue once and advances to the created step', async () => {
    const user = userEvent.setup();
    claimsIssue.mockResolvedValue({ code: '0123456789ABCDEFGHJKMNPQRS', expiresAt: 5_000 });
    renderDialog();

    await screen.findByText('Generate a claim code');
    await user.click(screen.getByRole('button', { name: /Generate claim code/ }));

    await waitFor(() => expect(claimsIssue).toHaveBeenCalledTimes(1));
    expect(claimsIssue).toHaveBeenCalledWith('tetra');
    expect(await screen.findByLabelText('Claim code')).toBeInTheDocument();
  });

  it('the created step shows the grouped code, expiry, and hand-off instructions naming grandfinals.gg/claim', async () => {
    const user = userEvent.setup();
    claimsIssue.mockResolvedValue({ code: '0123456789ABCDEFGHJKMNPQRS', expiresAt: 5_000 });
    renderDialog();

    await screen.findByText('Generate a claim code');
    await user.click(screen.getByRole('button', { name: /Generate claim code/ }));

    const field = await screen.findByLabelText('Claim code');
    expect(field).toHaveValue('01234-56789-ABCDE-FGHJK-MNPQR-S');
    expect(field).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: /^Copy/ })).toBeInTheDocument();
    expect(
      screen.getByText(/they'll enter it after signing in at grandfinals\.gg\/claim/),
    ).toBeInTheDocument();
  });

  it('Copy writes the displayed grouped code to the clipboard and shows the copied toast', async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    claimsIssue.mockResolvedValue({ code: '0123456789ABCDEFGHJKMNPQRS', expiresAt: 5_000 });
    renderDialog();

    await screen.findByText('Generate a claim code');
    await user.click(screen.getByRole('button', { name: /Generate claim code/ }));
    await screen.findByLabelText('Claim code');

    await user.click(screen.getByRole('button', { name: /^Copy/ }));

    await waitFor(() =>
      expect(writeTextSpy).toHaveBeenCalledWith('01234-56789-ABCDE-FGHJK-MNPQR-S'),
    );
    expect(toast.success).toHaveBeenCalledWith('Code copied to clipboard');
  });

  it('a clipboard rejection shows the copy-failed toast instead of throwing', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    claimsIssue.mockResolvedValue({ code: '0123456789ABCDEFGHJKMNPQRS', expiresAt: 5_000 });
    renderDialog();

    await screen.findByText('Generate a claim code');
    await user.click(screen.getByRole('button', { name: /Generate claim code/ }));
    await screen.findByLabelText('Claim code');

    await user.click(screen.getByRole('button', { name: /^Copy/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't copy — select the code and copy it manually.",
      ),
    );
  });

  it('closing from the created step warns first; cancelling keeps the code visible, confirming closes', async () => {
    const user = userEvent.setup();
    claimsIssue.mockResolvedValue({ code: '0123456789ABCDEFGHJKMNPQRS', expiresAt: 5_000 });
    const { onOpenChange } = renderDialog();

    await screen.findByText('Generate a claim code');
    await user.click(screen.getByRole('button', { name: /Generate claim code/ }));
    await screen.findByLabelText('Claim code');

    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(await screen.findByText('Close before copying the code?')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(await screen.findByLabelText('Claim code')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByText('Close before copying the code?');
    await user.click(screen.getByRole('button', { name: 'Close anyway' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('re-opening the dialog resets to the create step with no code retained', async () => {
    const user = userEvent.setup();
    claimsIssue.mockResolvedValue({ code: '0123456789ABCDEFGHJKMNPQRS', expiresAt: 5_000 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const dialogAt = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <IssueClaimCodeDialog
            client={{ clientId: 'tetra', label: 'Tetra' }}
            open={open}
            onOpenChange={vi.fn()}
          />
        </AuthProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(dialogAt(true));

    await screen.findByText('Generate a claim code');
    await user.click(screen.getByRole('button', { name: /Generate claim code/ }));
    await screen.findByLabelText('Claim code');

    rerender(dialogAt(false));
    rerender(dialogAt(true));

    await waitFor(() =>
      expect(
        screen.getByText('No claim code is currently active for this client.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Claim code')).not.toBeInTheDocument();
  });

  it('a 429 from issuance shows the distinct rate-limit message', async () => {
    const user = userEvent.setup();
    claimsIssue.mockRejectedValue(new ApiError(429, 'Too many requests'));
    renderDialog();

    await screen.findByText('Generate a claim code');
    await user.click(screen.getByRole('button', { name: /Generate claim code/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "You've hit today's claim code limit for this client. Try again tomorrow.",
      ),
    );
    expect(screen.queryByLabelText('Claim code')).not.toBeInTheDocument();
  });

  it('any other failure shows the generic failure message', async () => {
    const user = userEvent.setup();
    claimsIssue.mockRejectedValue(new Error('boom'));
    renderDialog();

    await screen.findByText('Generate a claim code');
    await user.click(screen.getByRole('button', { name: /Generate claim code/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Something went wrong generating the claim code. Try again.',
      ),
    );
  });

  it('shows the outstanding status and a confirmable Revoke control when a code is already active', async () => {
    const user = userEvent.setup();
    claimsStatus.mockResolvedValue({ outstanding: true, expiresAt: 9_999_999 });
    claimsRevoke.mockResolvedValue(undefined);
    renderDialog();

    await waitFor(() =>
      expect(
        screen.getByText('A claim code is already active for this client.'),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'Revoke code' }));
    expect(
      screen.getByText(
        "This immediately invalidates the outstanding claim code. Your client won't be able to use it anymore.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(claimsRevoke).toHaveBeenCalledWith('tetra'));
    expect(toast.success).toHaveBeenCalledWith('Claim code revoked');
  });
});

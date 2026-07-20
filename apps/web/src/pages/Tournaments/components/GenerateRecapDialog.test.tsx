import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { GenerateRecapDialog } from './GenerateRecapDialog';

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

const createVodShare = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      vodShares: {
        create: (...args: unknown[]) => createVodShare(...args),
      },
    },
  };
});

function renderDialog(entryKey = 'pgg-the-big-house-9', open = true, onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <GenerateRecapDialog entryKey={entryKey} open={open} onOpenChange={onOpenChange} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('GenerateRecapDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMockUser(makeMockUser({ displayName: 'TestPlayer' }));
  });

  afterEach(() => {
    resetAuthMock();
  });

  it('defaults the Show-display-name switch to ON (recap identity default, unlike VOD shares)', async () => {
    renderDialog();

    expect(await screen.findByText('Generate a recap card')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show your display name' })).toHaveAttribute(
      'data-state',
      'checked',
    );
  });

  it('disables the display-name switch when the account has no display name', async () => {
    setMockUser(makeMockUser());
    renderDialog();

    await screen.findByText('Generate a recap card');
    const nameSwitch = screen.getByRole('switch', { name: 'Show your display name' });
    expect(nameSwitch).toBeDisabled();
    expect(
      screen.getByText('Your account has no display name — set one in Profile to attach it'),
    ).toBeInTheDocument();
  });

  it('clicking Generate calls api.vodShares.create with kind recap + entryKey + detail full + ownerDisplayName, then shows a copyable link', async () => {
    const user = userEvent.setup();
    createVodShare.mockResolvedValue({
      shareId: 'share-1',
      token: 'tok',
      url: 'https://grandfinals.gg/s/tok',
    });
    renderDialog('pgg-the-big-house-9');

    await screen.findByText('Generate a recap card');
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createVodShare).toHaveBeenCalledTimes(1));
    expect(createVodShare).toHaveBeenCalledWith({
      kind: 'recap',
      entryKey: 'pgg-the-big-house-9',
      detail: 'full',
      permissions: 'view',
      ownerDisplayName: 'TestPlayer',
    });

    expect(await screen.findByText('Recap link ready')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://grandfinals.gg/s/tok')).toBeInTheDocument();
  });

  it('omits ownerDisplayName when the display-name switch is toggled off', async () => {
    const user = userEvent.setup();
    createVodShare.mockResolvedValue({
      shareId: 'share-1',
      token: 'tok',
      url: 'https://grandfinals.gg/s/tok',
    });
    renderDialog('pgg-the-big-house-9');

    await screen.findByText('Generate a recap card');
    await user.click(screen.getByRole('switch', { name: 'Show your display name' }));
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createVodShare).toHaveBeenCalledTimes(1));
    expect(createVodShare).toHaveBeenCalledWith({
      kind: 'recap',
      entryKey: 'pgg-the-big-house-9',
      detail: 'full',
      permissions: 'view',
    });
  });

  it('defaults the Full-recap switch to ON', async () => {
    renderDialog();

    await screen.findByText('Generate a recap card');
    expect(screen.getByRole('switch', { name: 'Full recap' })).toHaveAttribute(
      'data-state',
      'checked',
    );
  });

  it('sends detail: "summary" when the Full-recap switch is toggled off', async () => {
    const user = userEvent.setup();
    createVodShare.mockResolvedValue({
      shareId: 'share-1',
      token: 'tok',
      url: 'https://grandfinals.gg/s/tok',
    });
    renderDialog('pgg-the-big-house-9');

    await screen.findByText('Generate a recap card');
    await user.click(screen.getByRole('switch', { name: 'Full recap' }));
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createVodShare).toHaveBeenCalledTimes(1));
    expect(createVodShare).toHaveBeenCalledWith({
      kind: 'recap',
      entryKey: 'pgg-the-big-house-9',
      detail: 'summary',
      permissions: 'view',
      ownerDisplayName: 'TestPlayer',
    });
  });

  it('clicking Copy invokes the clipboard API and shows the copied affordance', async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    createVodShare.mockResolvedValue({
      shareId: 'share-1',
      token: 'tok',
      url: 'https://grandfinals.gg/s/tok',
    });
    renderDialog();

    await screen.findByText('Generate a recap card');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Recap link ready');

    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() => expect(writeTextSpy).toHaveBeenCalledWith('https://grandfinals.gg/s/tok'));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('resets to the create step when re-opened (prop-driven, fresh entry each time)', async () => {
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
          <GenerateRecapDialog entryKey="pgg-abc" open={open} onOpenChange={vi.fn()} />
        </AuthProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(dialogAt(true));

    await screen.findByText('Generate a recap card');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('Recap link ready')).toBeInTheDocument();

    rerender(dialogAt(false));
    rerender(dialogAt(true));

    expect(await screen.findByText('Generate a recap card')).toBeInTheDocument();
    expect(screen.queryByText('Recap link ready')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show your display name' })).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(screen.getByRole('switch', { name: 'Full recap' })).toHaveAttribute(
      'data-state',
      'checked',
    );
  });
});

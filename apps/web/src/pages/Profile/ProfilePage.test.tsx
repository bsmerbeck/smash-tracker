import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { ProfilePage } from './ProfilePage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    getRedirectResult: mock.getRedirectResult,
    signInWithCustomToken: mock.signInWithCustomToken,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
    EmailAuthProvider: mock.EmailAuthProvider,
    reauthenticateWithCredential: mock.reauthenticateWithCredential,
    updatePassword: mock.updatePassword,
    sendPasswordResetEmail: mock.sendPasswordResetEmail,
    updateProfile: mock.updateProfile,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getMe = vi.fn().mockResolvedValue({
  uid: 'test-uid',
  email: 'test@example.com',
  fighters: { primary: [], secondary: [] },
  coachingModeEnabled: false,
});
const startggStatus = vi.fn().mockResolvedValue({ linked: false });
const parryggStatus = vi.fn().mockResolvedValue({ linked: false });
const getFighters = vi.fn().mockResolvedValue({ primary: [], secondary: [] });
const matchesList = vi.fn().mockResolvedValue([]);
const groupsList = vi.fn().mockResolvedValue([]);
const reportsConfig = vi.fn().mockResolvedValue({ enabled: false });
const reportsList = vi.fn().mockResolvedValue([]);
const billingCredits = vi.fn().mockResolvedValue({ freeAccess: false, balance: 0, packs: [] });
const billingCheckout = vi.fn();
const stageFavoritesGet = vi.fn().mockResolvedValue({ stageIds: [], updatedAt: 0 });
const stageFavoritesUpdate = vi.fn();

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
      users: {
        upsertMe: (...args: unknown[]) => upsertMe(...args),
        getMe: (...args: unknown[]) => getMe(...args),
        getFighters: (...args: unknown[]) => getFighters(...args),
      },
      startgg: { status: (...args: unknown[]) => startggStatus(...args) },
      parrygg: { status: (...args: unknown[]) => parryggStatus(...args) },
      matches: { list: (...args: unknown[]) => matchesList(...args) },
      groups: { list: (...args: unknown[]) => groupsList(...args) },
      reports: {
        config: (...args: unknown[]) => reportsConfig(...args),
        list: (...args: unknown[]) => reportsList(...args),
      },
      billing: {
        credits: (...args: unknown[]) => billingCredits(...args),
        checkout: (...args: unknown[]) => billingCheckout(...args),
      },
      stageFavorites: {
        get: (...args: unknown[]) => stageFavoritesGet(...args),
        update: (...args: unknown[]) => stageFavoritesUpdate(...args),
      },
    },
    ApiError: MockApiError,
  };
});

function renderPage(initialEntry = '/profile') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <Routes>
            <Route path="/profile" element={<ProfilePage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProfilePage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
    });
    startggStatus.mockResolvedValue({ linked: false });
    parryggStatus.mockResolvedValue({ linked: false });
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    matchesList.mockResolvedValue([]);
    groupsList.mockResolvedValue([]);
    reportsConfig.mockResolvedValue({ enabled: false });
    reportsList.mockResolvedValue([]);
    billingCredits.mockResolvedValue({ freeAccess: false, balance: 0, packs: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('password-provider user', () => {
    beforeEach(() => {
      setMockUser(
        makeMockUser({
          email: 'pilot@example.com',
          providerData: [{ providerId: 'password' } as never],
          metadata: { creationTime: 'Mon, 05 Jan 2026 00:00:00 GMT' } as never,
        }),
      );
    });

    it('renders the Account card with email, member-since, and sign-in methods', async () => {
      renderPage();

      expect(await screen.findByText('pilot@example.com')).toBeInTheDocument();
      expect(screen.getByText(/Member since January 2026/)).toBeInTheDocument();
      expect(screen.getByText('Email & password')).toBeInTheDocument();
    });

    it('renders the change-password form in the Security card', async () => {
      renderPage();

      expect(await screen.findByRole('button', { name: 'Change password' })).toBeInTheDocument();
      expect(screen.getByLabelText('Current password')).toBeInTheDocument();
      expect(screen.getByLabelText('New password')).toBeInTheDocument();
      expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument();
    });

    it('changes the password on the happy path', async () => {
      const user = userEvent.setup();
      const { reauthenticateWithCredential, updatePassword } = await import('firebase/auth');
      vi.mocked(reauthenticateWithCredential).mockResolvedValue(undefined as never);
      vi.mocked(updatePassword).mockResolvedValue(undefined as never);

      renderPage();
      await screen.findByRole('button', { name: 'Change password' });

      await user.type(screen.getByLabelText('Current password'), 'oldpassword');
      await user.type(screen.getByLabelText('New password'), 'newpassword123');
      await user.type(screen.getByLabelText('Confirm new password'), 'newpassword123');
      await user.click(screen.getByRole('button', { name: 'Change password' }));

      await waitFor(() =>
        expect(updatePassword).toHaveBeenCalledWith(expect.anything(), 'newpassword123'),
      );
      expect(toastSuccess).toHaveBeenCalledWith('Password updated!');
    });

    it('shows a friendly message for wrong current password', async () => {
      const user = userEvent.setup();
      const { reauthenticateWithCredential } = await import('firebase/auth');
      const error = Object.assign(new Error('bad creds'), { code: 'auth/wrong-password' });
      vi.mocked(reauthenticateWithCredential).mockRejectedValue(error);

      renderPage();
      await screen.findByRole('button', { name: 'Change password' });

      await user.type(screen.getByLabelText('Current password'), 'wrongpassword');
      await user.type(screen.getByLabelText('New password'), 'newpassword123');
      await user.type(screen.getByLabelText('Confirm new password'), 'newpassword123');
      await user.click(screen.getByRole('button', { name: 'Change password' }));

      expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
    });

    it('shows a friendly message for a weak new password', async () => {
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('button', { name: 'Change password' });

      await user.type(screen.getByLabelText('Current password'), 'oldpassword');
      await user.type(screen.getByLabelText('New password'), 'abc');
      await user.type(screen.getByLabelText('Confirm new password'), 'abc');
      await user.click(screen.getByRole('button', { name: 'Change password' }));

      expect(
        await screen.findByText('Password should be at least 6 characters'),
      ).toBeInTheDocument();
    });
  });

  describe('display name', () => {
    it('prefills the input with the current display name and disables Save until edited', async () => {
      setMockUser(makeMockUser({ email: 'pilot@example.com', displayName: 'Pilot' }));
      renderPage();

      const input = await screen.findByLabelText('Display name');
      expect(input).toHaveValue('Pilot');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('lets an account without a display name set one (the share-dialog name toggle path)', async () => {
      setMockUser(makeMockUser({ email: 'pilot@example.com' }));
      const user = userEvent.setup();
      const { updateProfile } = await import('firebase/auth');
      vi.mocked(updateProfile).mockResolvedValue(undefined as never);

      renderPage();
      const input = await screen.findByLabelText('Display name');
      expect(input).toHaveValue('');

      await user.type(input, 'GrandFinalist');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(updateProfile).toHaveBeenCalledWith(expect.anything(), {
          displayName: 'GrandFinalist',
        }),
      );
      expect(toastSuccess).toHaveBeenCalledWith('Display name updated.');
    });

    it('clears the display name when saving an emptied field', async () => {
      setMockUser(makeMockUser({ email: 'pilot@example.com', displayName: 'Pilot' }));
      const user = userEvent.setup();
      const { updateProfile } = await import('firebase/auth');
      vi.mocked(updateProfile).mockResolvedValue(undefined as never);

      renderPage();
      const input = await screen.findByLabelText('Display name');
      await user.clear(input);
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(updateProfile).toHaveBeenCalledWith(expect.anything(), { displayName: null }),
      );
    });

    it('surfaces a friendly error when the update fails', async () => {
      setMockUser(makeMockUser({ email: 'pilot@example.com' }));
      const user = userEvent.setup();
      const { updateProfile } = await import('firebase/auth');
      vi.mocked(updateProfile).mockRejectedValue(new Error('network down'));

      renderPage();
      await user.type(await screen.findByLabelText('Display name'), 'GrandFinalist');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(toastError).toHaveBeenCalled());
    });
  });

  describe('coaching mode toggle (walkthrough fix FB-3)', () => {
    beforeEach(() => {
      setMockUser(makeMockUser({ email: 'pilot@example.com' }));
    });

    it('renders off by default and enables it on click, showing a success toast', async () => {
      const user = userEvent.setup();
      renderPage();

      const toggle = await screen.findByRole('switch', { name: 'Enable coaching mode' });
      expect(toggle).not.toBeChecked();

      getMe.mockResolvedValue({
        uid: 'test-uid',
        email: 'test@example.com',
        fighters: { primary: [], secondary: [] },
        coachingModeEnabled: true,
      });
      await user.click(toggle);

      await waitFor(() => expect(upsertMe).toHaveBeenCalledWith({ coachingModeEnabled: true }));
      await waitFor(() => expect(toggle).toBeChecked());
      expect(toastSuccess).toHaveBeenCalledWith('Coaching mode enabled.');
    });

    it('renders checked when already enabled and can be turned back off', async () => {
      getMe.mockResolvedValue({
        uid: 'test-uid',
        email: 'test@example.com',
        fighters: { primary: [], secondary: [] },
        coachingModeEnabled: true,
      });
      const user = userEvent.setup();
      renderPage();

      const toggle = await screen.findByRole('switch', { name: 'Enable coaching mode' });
      await waitFor(() => expect(toggle).toBeChecked());

      getMe.mockResolvedValue({
        uid: 'test-uid',
        email: 'test@example.com',
        fighters: { primary: [], secondary: [] },
        coachingModeEnabled: false,
      });
      await user.click(toggle);

      await waitFor(() => expect(upsertMe).toHaveBeenCalledWith({ coachingModeEnabled: false }));
      expect(toastSuccess).toHaveBeenCalledWith('Coaching mode disabled.');
    });

    it('shows an error toast when the update fails', async () => {
      upsertMe.mockRejectedValueOnce(new Error('network down'));
      const user = userEvent.setup();
      renderPage();

      const toggle = await screen.findByRole('switch', { name: 'Enable coaching mode' });
      await user.click(toggle);

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith('Something went wrong updating coaching mode.'),
      );
    });
  });

  describe('google (no-password) user', () => {
    beforeEach(() => {
      setMockUser(
        makeMockUser({
          email: 'google-user@example.com',
          providerData: [{ providerId: 'google.com' } as never],
        }),
      );
    });

    it('renders the Google sign-in method and the reset-email offer', async () => {
      renderPage();

      expect(await screen.findByText('Google')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send password reset email' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    });

    it('sends the reset email and shows success feedback', async () => {
      const user = userEvent.setup();
      const { sendPasswordResetEmail } = await import('firebase/auth');
      vi.mocked(sendPasswordResetEmail).mockResolvedValue(undefined as never);

      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Send password reset email' }));

      await waitFor(() =>
        expect(sendPasswordResetEmail).toHaveBeenCalledWith(
          expect.anything(),
          'google-user@example.com',
        ),
      );
      expect(await screen.findByText(/Reset email sent/)).toBeInTheDocument();
    });
  });

  describe('parry.gg (email-less) user', () => {
    beforeEach(() => {
      setMockUser(
        makeMockUser({
          uid: 'parrygg-abc123',
          email: null,
          providerData: [],
        }),
      );
      parryggStatus.mockResolvedValue({ linked: true, gamerTag: 'ParryPilot', verified: true });
    });

    it('shows the no-email identity and explains parry.gg-only sign-in', async () => {
      renderPage();

      expect(await screen.findByText(/linked to ParryPilot/)).toBeInTheDocument();
      expect(
        screen.getByText(/sign-in works through parry\.gg profile verification/),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Send password reset email' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('billing card', () => {
    beforeEach(() => {
      setMockUser(makeMockUser({ email: 'pilot@example.com' }));
    });

    it('is hidden entirely when reports are disabled', async () => {
      reportsConfig.mockResolvedValue({ enabled: false });
      renderPage();

      await screen.findByText('pilot@example.com');
      expect(screen.queryByText('Billing')).not.toBeInTheDocument();
    });

    it('shows the credit balance and buy-credits button when enabled and not free', async () => {
      reportsConfig.mockResolvedValue({ enabled: true, freeAccess: false });
      billingCredits.mockResolvedValue({
        freeAccess: false,
        balance: 3,
        packs: [{ id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' }],
      });

      renderPage();

      expect(await screen.findByText('3 credits')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Buy credits' })).toBeInTheDocument();
    });

    it('shows a free-access badge for allowlisted users', async () => {
      reportsConfig.mockResolvedValue({ enabled: true, freeAccess: true });
      billingCredits.mockResolvedValue({ freeAccess: true, balance: 0, packs: [] });

      renderPage();

      expect(await screen.findByText('Free access')).toBeInTheDocument();
    });
  });

  describe('your data card', () => {
    beforeEach(() => {
      setMockUser(makeMockUser({ email: 'pilot@example.com' }));
    });

    it('splits match counts by source', async () => {
      matchesList.mockResolvedValue([
        { id: '1', fighter_id: 1, opponent_id: 2, time: 1, win: true, source: 'startgg' },
        { id: '2', fighter_id: 1, opponent_id: 2, time: 2, win: true, source: 'parrygg' },
        { id: '3', fighter_id: 1, opponent_id: 2, time: 3, win: false },
      ]);
      groupsList.mockResolvedValue([{ id: 'g1' }, { id: 'g2' }]);

      renderPage();

      function statValue(label: string): string | null | undefined {
        return screen.getByText(label).previousElementSibling?.textContent;
      }

      await waitFor(() => expect(statValue('Total matches')).toBe('3'));
      expect(statValue('From start.gg')).toBe('1');
      expect(statValue('From parry.gg')).toBe('1');
      expect(statValue('Manually entered')).toBe('1');
      expect(statValue('Groups joined')).toBe('2');
    });
  });

  describe('connected accounts card', () => {
    beforeEach(() => {
      setMockUser(makeMockUser({ email: 'pilot@example.com' }));
    });

    it('links to Integrations and shows not-linked when nothing is connected', async () => {
      renderPage();

      expect(await screen.findAllByText('Not linked')).toHaveLength(2);
      expect(screen.getByRole('link', { name: 'Manage on Integrations' })).toHaveAttribute(
        'href',
        '/settings/integrations',
      );
    });

    it('shows linked gamer tags and verified badge', async () => {
      startggStatus.mockResolvedValue({ linked: true, gamerTag: 'Pandem1c' });
      parryggStatus.mockResolvedValue({ linked: true, gamerTag: 'ParryPilot', verified: true });

      renderPage();

      expect(await screen.findByText('Pandem1c')).toBeInTheDocument();
      expect(screen.getByText('ParryPilot')).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });
  });

  describe('fighters card', () => {
    beforeEach(() => {
      setMockUser(makeMockUser({ email: 'pilot@example.com' }));
    });

    it('shows "None selected" with no fighters chosen', async () => {
      renderPage();

      expect(await screen.findAllByText('None selected')).toHaveLength(2);
      expect(screen.getByRole('link', { name: 'Edit fighters' })).toHaveAttribute(
        'href',
        '/choose-primary',
      );
    });

    it('renders sprite tiles for selected fighters', async () => {
      getFighters.mockResolvedValue({ primary: [1], secondary: [2] });

      renderPage();

      await waitFor(() => expect(screen.queryAllByText('None selected')).toHaveLength(0));
    });
  });
});

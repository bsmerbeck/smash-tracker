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
    signInWithCustomToken: mock.signInWithCustomToken,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
    EmailAuthProvider: mock.EmailAuthProvider,
    reauthenticateWithCredential: mock.reauthenticateWithCredential,
    updatePassword: mock.updatePassword,
    sendPasswordResetEmail: mock.sendPasswordResetEmail,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const startggStatus = vi.fn().mockResolvedValue({ linked: false });
const parryggStatus = vi.fn().mockResolvedValue({ linked: false });
const getFighters = vi.fn().mockResolvedValue({ primary: [], secondary: [] });
const matchesList = vi.fn().mockResolvedValue([]);
const groupsList = vi.fn().mockResolvedValue([]);
const reportsConfig = vi.fn().mockResolvedValue({ enabled: false });
const reportsList = vi.fn().mockResolvedValue([]);
const billingCredits = vi.fn().mockResolvedValue({ freeAccess: false, balance: 0, packs: [] });
const billingCheckout = vi.fn();

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

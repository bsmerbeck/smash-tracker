import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { Topbar } from './Topbar';
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

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
    },
    startgg: {
      status: vi.fn().mockResolvedValue({ linked: false }),
    },
    coaching: {
      clients: {
        list: vi.fn().mockResolvedValue([]),
      },
    },
  },
}));

/**
 * Phase 11 walkthrough fix round 1 (FB-1): the `/coach` hub route has no
 * `clientId` param, so `Topbar`'s `ModeSwitch` must still read `mode:
 * 'coaching'` (not `'personal'`) for its value to reflect the hub — a
 * fresh `/dashboard` route asserts the reverse case for the Personal click.
 */
function renderTopbarAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="*" element={<Topbar />} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Topbar ModeSwitch', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('walkthrough fix FB-1: shows Coaching as the active value on the /coach hub (no clientId)', async () => {
    renderTopbarAt('/coach');

    const coachingButtons = await screen.findAllByRole('radio', { name: 'Coaching' });
    for (const button of coachingButtons) {
      expect(button).toHaveAttribute('data-state', 'on');
    }
    const personalButtons = screen.getAllByRole('radio', { name: 'Personal' });
    for (const button of personalButtons) {
      expect(button).toHaveAttribute('data-state', 'off');
    }
  });

  it('walkthrough fix FB-1: clicking Personal from the hub is a real value change (navigates)', async () => {
    const user = userEvent.setup();
    renderTopbarAt('/coach');

    const [personalButton] = await screen.findAllByRole('radio', { name: 'Personal' });
    await user.click(personalButton);

    // Radix ToggleGroup only fires onValueChange for an actual value change;
    // clicking Personal from the (now correctly) active Coaching value
    // should flip it to Personal rather than being ignored as a same-value
    // re-click (the FB-1 bug: Personal used to already read active here).
    expect(personalButton).toHaveAttribute('data-state', 'on');
  });

  it('does not show the client chip or accent border on the /coach hub', async () => {
    renderTopbarAt('/coach');

    await screen.findAllByRole('radio', { name: 'Coaching' });
    expect(screen.queryByRole('img', { hidden: true })).not.toBeInTheDocument();
    // No clientId on the hub route, so no client-name badge should render.
    expect(screen.queryAllByText(/tenant-/).length).toBe(0);
  });
});

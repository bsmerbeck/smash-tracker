import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { CoachingModeGate } from './CoachingModeGate';
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

const getMe = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      getMe: (...args: unknown[]) => getMe(...args),
    },
  },
}));

/** Phase 11 walkthrough fix round 1 (FB-3): the /coach* gate. */
function renderGate(initialEntry = '/coach') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <Routes>
            <Route
              path="/coach"
              element={
                <CoachingModeGate>
                  <div>Client Hub content</div>
                </CoachingModeGate>
              }
            />
          </Routes>
          <Routes>
            <Route path="/profile" element={<div>Profile page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CoachingModeGate', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('renders the disabled state (with a link to Profile) when coachingModeEnabled is false', async () => {
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
    });

    renderGate();

    expect(await screen.findByText('Coaching mode is off')).toBeInTheDocument();
    expect(screen.queryByText('Client Hub content')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Profile' })).toHaveAttribute('href', '/profile');
  });

  it('renders the disabled state when coachingModeEnabled is absent entirely', async () => {
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
    });

    renderGate();

    expect(await screen.findByText('Coaching mode is off')).toBeInTheDocument();
  });

  it('renders the wrapped children when coachingModeEnabled is true', async () => {
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'test@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: true,
    });

    renderGate();

    expect(await screen.findByText('Client Hub content')).toBeInTheDocument();
    expect(screen.queryByText('Coaching mode is off')).not.toBeInTheDocument();
  });
});

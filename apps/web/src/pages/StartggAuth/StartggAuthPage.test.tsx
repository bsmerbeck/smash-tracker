import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { StartggAuthPage } from './StartggAuthPage';
import { resetAuthMock, signInWithCustomToken } from '@/test/mockAuth';

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
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
vi.mock('@/lib/api', () => ({
  api: { users: { upsertMe: (...args: unknown[]) => upsertMe(...args) } },
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/auth/startgg']}>
        <AuthProvider>
          <Routes>
            <Route path="/auth/startgg" element={<StartggAuthPage />} />
            <Route path="/dashboard" element={<div>Dashboard destination</div>} />
            <Route path="/" element={<div>Home page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StartggAuthPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('signs in with the fragment token and navigates to the dashboard', async () => {
    window.location.hash = '#token=custom-token-abc';
    signInWithCustomToken.mockResolvedValue({ user: { uid: 'u' } });

    renderPage();

    await waitFor(() => expect(screen.getByText('Dashboard destination')).toBeInTheDocument());
    expect(signInWithCustomToken).toHaveBeenCalledWith(expect.anything(), 'custom-token-abc');
    expect(upsertMe).toHaveBeenCalled();
  });

  it('shows a failure state when the token is missing', async () => {
    renderPage();
    expect(await screen.findByText('start.gg sign-in failed')).toBeInTheDocument();
    expect(signInWithCustomToken).not.toHaveBeenCalled();
  });

  it('shows a failure state when sign-in is rejected', async () => {
    window.location.hash = '#token=expired-token';
    signInWithCustomToken.mockRejectedValue(new Error('auth/invalid-custom-token'));

    renderPage();

    expect(await screen.findByText('start.gg sign-in failed')).toBeInTheDocument();
  });
});

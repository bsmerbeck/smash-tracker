import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as firebaseAuth from 'firebase/auth';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { ProtectedRoute } from './ProtectedRoute';
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

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
    },
    // MainLayout mounts useStartggAutoSync; unlinked = the no-op path.
    startgg: {
      status: vi.fn().mockResolvedValue({ linked: false }),
    },
  },
}));

function renderProtected() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/" element={<div>Home page</div>} />
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <div>Secret dashboard content</div>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
  });

  it('redirects unauthenticated users to /', async () => {
    setMockUser(null);
    renderProtected();

    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Secret dashboard content')).not.toBeInTheDocument();
  });

  it('renders the protected content for authenticated users', async () => {
    setMockUser(makeMockUser());
    renderProtected();

    expect(await screen.findByText('Secret dashboard content')).toBeInTheDocument();
    expect(firebaseAuth.onAuthStateChanged).toHaveBeenCalled();
  });
});

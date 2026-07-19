import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { AppRouter } from './AppRouter';
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

const getMe = vi.fn();
const getFighters = vi.fn();
const matchesList = vi.fn();
const clientsList = vi.fn();
const startggStatus = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      getMe: (...args: unknown[]) => getMe(...args),
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: { list: (...args: unknown[]) => matchesList(...args) },
    coaching: {
      clients: { list: (...args: unknown[]) => clientsList(...args) },
    },
    startgg: { status: (...args: unknown[]) => startggStatus(...args) },
  },
}));

/**
 * Phase 11 fix round 2 (D-02/D2, D-05/D5): `AppRouter` bakes in its own
 * `BrowserRouter` (never swapped for `MemoryRouter` in tests, since it's
 * the exact component under test), so navigation is driven by pushing to
 * real `window.history` before each render — the same mechanism a real
 * browser deep-link or reload uses.
 */
function renderAt(path: string) {
  window.history.pushState({}, '', path);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AnalyticsFilterProvider>
          <AppRouter />
        </AnalyticsFilterProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('AppRouter — coaching workspace routes (fix round 2)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'coach@example.com' }));
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'coach@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: true,
    });
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    matchesList.mockResolvedValue([]);
    clientsList.mockResolvedValue([{ clientId: 'tetra', label: 'TETRA', draftCount: 0 }]);
    startggStatus.mockResolvedValue({ linked: false });
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('index route /coach/tetra redirects (replace) to the Overview surface', async () => {
    renderAt('/coach/tetra');

    expect(await screen.findByText('TETRA — Overview')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/coach/tetra/overview');
  });

  it('renders the Fighters page at /coach/tetra/fighters', async () => {
    renderAt('/coach/tetra/fighters');

    expect(await screen.findByText('TETRA — Fighters')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Secondary' })).toBeInTheDocument();
  });

  it.each([
    ['gsp', '/coach/tetra/gsp'],
    ['integrations', '/coach/tetra/integrations'],
    ['reports', '/coach/tetra/reports'],
  ])('deep-link to the removed %s route redirects cleanly to Overview', async (_name, path) => {
    renderAt(path);

    expect(await screen.findByText('TETRA — Overview')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/coach/tetra/overview');
    // No stale "unavailable" panel ever renders — the redirect is the only surface.
    expect(screen.queryByText(/not available/i)).not.toBeInTheDocument();
  });
});

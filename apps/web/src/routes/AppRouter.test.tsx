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
const getFighters = vi.fn();
const matchesList = vi.fn();
const clientsList = vi.fn();
const startggStatus = vi.fn();
const clientWorkspacesList = vi.fn();
const claimsRedeem = vi.fn();
// Phase 29 (Research Tenancy, Isolation & Governance Gate): backs
// `useResearchSubject`'s query, which `ClientWorkspaceLayout` now gates its
// outlet on. Defaults to the ordinary resolution so every pre-existing test
// below (all pre-dating Phase 29) keeps rendering its workspace content
// exactly as before.
const clientsKind = vi.fn();

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return { MockApiError };
});

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      getMe: (...args: unknown[]) => getMe(...args),
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: { list: (...args: unknown[]) => matchesList(...args) },
    coaching: {
      clients: {
        list: (...args: unknown[]) => clientsList(...args),
        kind: (...args: unknown[]) => clientsKind(...args),
      },
    },
    clientWorkspaces: {
      list: (...args: unknown[]) => clientWorkspacesList(...args),
      revokeDelegation: vi.fn(),
    },
    claims: {
      redeem: (...args: unknown[]) => claimsRedeem(...args),
    },
    startgg: { status: (...args: unknown[]) => startggStatus(...args) },
  },
  ApiError: MockApiError,
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
    clientsKind.mockResolvedValue({ kind: 'ordinary' });
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

describe('AppRouter — client-owned workspace routes (Phase 24)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'client@example.com' }));
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'client@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
    });
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    matchesList.mockResolvedValue([]);
    clientsList.mockResolvedValue([]);
    clientWorkspacesList.mockResolvedValue([
      { tenantId: 't1', label: 'My Workspace', claimedAt: 1, delegateCoachUid: null },
    ]);
    startggStatus.mockResolvedValue({ linked: false });
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('/workspace/t1/overview reaches the gate and renders the owned Overview', async () => {
    renderAt('/workspace/t1/overview');

    // 24-06's owner chrome (Topbar chip + Sidebar rail) also renders the
    // workspace label, so the single-match query became ambiguous — assert
    // presence, not uniqueness.
    expect((await screen.findAllByText(/My Workspace/)).length).toBeGreaterThan(0);
  });

  it('/workspace/t1/reviews redirects to /workspace/t1/overview', async () => {
    renderAt('/workspace/t1/reviews');

    expect((await screen.findAllByText(/My Workspace/)).length).toBeGreaterThan(0);
    expect(window.location.pathname).toBe('/workspace/t1/overview');
  });
});

describe('AppRouter — /claim route (Phase 24, ENTRY-01)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'client@example.com' }));
    getMe.mockResolvedValue({
      uid: 'test-uid',
      email: 'client@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
    });
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    matchesList.mockResolvedValue([]);
    clientsList.mockResolvedValue([]);
    clientWorkspacesList.mockResolvedValue([]);
    startggStatus.mockResolvedValue({ linked: false });
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('an authenticated visit renders the claim redemption page', async () => {
    renderAt('/claim');

    expect(await screen.findByLabelText('Claim code')).toBeInTheDocument();
  });
});

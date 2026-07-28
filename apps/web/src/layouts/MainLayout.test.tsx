import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import i18n from '@/i18n';
import { useFighters } from '@/hooks/useFighters';
import { coachingClientsQueryKey } from '@/hooks/useCoachingClients';
import { MainLayout } from './MainLayout';
import { navItems } from './nav';
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

const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    info: (...args: unknown[]) => toastInfo(...args),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

/**
 * Quick 260726-r5 (Phase 24 gap 2): a mock `ApiError` sharing the mocked
 * `@/lib/api` module's export, so `useCoachAccessEjection`'s own
 * `error instanceof ApiError` check resolves against the SAME class an
 * ejection test throws (mirrors `CoachAccessCard.test.tsx`'s `MockApiError`
 * pattern — `vi.hoisted` because `vi.mock` factories run before normal
 * module-scope code).
 */
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

const getFighters = vi.fn().mockResolvedValue({ primary: [], secondary: [] });
const listClients = vi.fn().mockResolvedValue([]);
const listWorkspaces = vi.fn().mockResolvedValue([]);
const startggStatus = vi.fn().mockResolvedValue({ linked: false });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    // MainLayout mounts useStartggAutoSync; unlinked = the no-op path.
    startgg: {
      status: (...args: unknown[]) => startggStatus(...args),
    },
    coaching: {
      clients: {
        list: (...args: unknown[]) => listClients(...args),
      },
    },
    clientWorkspaces: {
      list: (...args: unknown[]) => listWorkspaces(...args),
    },
  },
  ApiError: MockApiError,
}));

function renderLayout() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <MainLayout>
              <div>Page content</div>
            </MainLayout>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Quick 260726-r5 (Phase 24 gap 2): a route-aware render helper mirroring
 * `Topbar.test.tsx`'s `renderTopbarAt` — needed so `useActiveSubject()`
 * (which `useCoachAccessEjection` reads) resolves a real `clientId` under
 * `/coach/:clientId/*`, and so navigating to `/coach` after an eject is
 * observable via a distinct rendered marker. Accepts an optional externally
 * created `queryClient` so a test can force a deliberate refetch afterward
 * (e.g. `invalidateQueries`) against the SAME cache the rendered tree reads.
 */
function renderLayoutAt(path: string, page: ReactElement, queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route
                path="/coach"
                element={
                  <MainLayout>
                    <div>Coach hub landing</div>
                  </MainLayout>
                }
              />
              <Route path="/coach/:clientId/*" element={<MainLayout>{page}</MainLayout>} />
              <Route path="*" element={<MainLayout>{page}</MainLayout>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Mounts `useFighters()` — a real subject-scoped hook — so the ejection hook has a `['client', clientId, 'fighters']` query to observe. */
function FightersProbe() {
  const query = useFighters();
  return <div data-testid="fighters-probe">{query.status}</div>;
}

describe('MainLayout', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('renders the layout with all nav links and the signed-in user email', async () => {
    renderLayout();

    expect(await screen.findByText('Page content')).toBeInTheDocument();

    for (const item of navItems) {
      expect(screen.getAllByRole('link', { name: i18n.t(item.titleKey) }).length).toBeGreaterThan(
        0,
      );
    }

    expect(screen.getAllByText('pilot@example.com').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('renders the Donorbox donate link below Training Grounds in the sidebar', async () => {
    renderLayout();

    await screen.findByText('Page content');

    const donateLinks = screen.getAllByRole('link', { name: /donate/i });
    expect(donateLinks.length).toBeGreaterThan(0);
    for (const link of donateLinks) {
      expect(link).toHaveAttribute('href', 'https://donorbox.org/support-smash-tracker');
      expect(link).toHaveAttribute('target', '_blank');
    }
  });
});

/**
 * Quick 260726-r5 (Phase 24 gap 2): a revoked coach was previously left
 * sitting inside `/coach/:clientId/*` rendering stale UI — server-side
 * enforcement already 403s the next request (Phase 23), but nothing ejected
 * the client. `useCoachAccessEjection` (mounted from `MainLayout`) fixes
 * that: it watches for a 403 on a query scoped to the ACTIVE client and, on
 * detecting one, navigates to `/coach`, shows a non-alarming toast, and
 * drops the client from the cached coaching-clients list.
 */
describe('MainLayout coach access ejection (Quick 260726-r5, gap 2)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listClients.mockResolvedValue([{ clientId: 'c1', label: 'Client One', draftCount: 0 }]);
    listWorkspaces.mockResolvedValue([]);
    startggStatus.mockResolvedValue({ linked: false });
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('ejects to /coach with the notice when a query scoped to the active client 403s', async () => {
    getFighters.mockRejectedValue(new MockApiError(403, 'Forbidden'));

    renderLayoutAt('/coach/c1/overview', <FightersProbe />);

    expect(await screen.findByText('Coach hub landing')).toBeInTheDocument();
    expect(toastInfo).toHaveBeenCalledWith('Your access to this workspace has ended');
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('does not eject on an unrelated 403 (a different cache namespace, not the active client)', async () => {
    // `useStartggAutoSync` (mounted unconditionally by MainLayout) reads
    // `['startgg', 'status']` — a personal-scope query, never `['client',
    // clientId, ...]` — so a 403 there must never be mistaken for the
    // active client's own access being revoked.
    startggStatus.mockRejectedValue(new MockApiError(403, 'Forbidden'));

    renderLayoutAt('/coach/c1/overview', <FightersProbe />);

    await screen.findByTestId('fighters-probe');
    // Give the rejected startgg query a tick to settle into its error state.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText('Coach hub landing')).not.toBeInTheDocument();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('does not eject or fire a second time if the coach hub itself later errors', async () => {
    getFighters.mockRejectedValue(new MockApiError(403, 'Forbidden'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderLayoutAt('/coach/c1/overview', <FightersProbe />, queryClient);

    await screen.findByText('Coach hub landing');
    expect(toastInfo).toHaveBeenCalledTimes(1);

    // The hub's own client-list query lives in the `['coaching-clients']`
    // namespace, outside the `['client', 'c1', ...]` filter — erroring here
    // (post-eject, forced via an explicit refetch) must never re-trigger the
    // ejection notice/navigation.
    listClients.mockRejectedValue(new MockApiError(403, 'Forbidden'));
    await queryClient.invalidateQueries({ queryKey: coachingClientsQueryKey });

    expect(toastInfo).toHaveBeenCalledTimes(1);
  });
});

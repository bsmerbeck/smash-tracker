import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { AppRouter } from './AppRouter';
import { ResearchTelemetrySuppression } from './ResearchTelemetrySuppression';
import { RouteAnalytics } from './RouteAnalytics';
import { ClientWorkspaceLayout } from '@/pages/Coaching/ClientWorkspaceLayout';
import { NoteComposer } from '@/pages/VodManager/components/NoteComposer';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

/**
 * Phase 29 Plan 12 — the browser half of the composite session proof
 * (review finding 29-11 HIGH: an API-only suite cannot establish either
 * the zero-GA4 property or banner coverage). Mocks `firebase/analytics`
 * itself (not merely `@/lib/firebase`'s logger wrappers), so the
 * assertions below are at the SDK-module and data-layer level — the same
 * depth plan 29-09's own session test established, extended here to cover
 * the WHOLE router-mounted composition (banner + suppression + page-view
 * reporter together), which is what this suite proves that an API-only
 * suite structurally cannot.
 *
 * This is an SDK- and data-layer-level assertion, not a network-level one
 * — a true "zero bytes left the browser" proof needs a real browser
 * harness this repo does not have. That residual is recorded in plan
 * 29-02's assumption register, matching plan 29-09's own honest scoping;
 * it is not overclaimed here either.
 */

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

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn().mockReturnValue({}),
}));

// Deliberately NO `vi.mock('@/lib/firebase', ...)` anywhere in this file —
// the REAL module (with its `collectionEnabled` flag and
// `setAnalyticsCollectionEnabled`) must run for these assertions to mean
// anything.
const logEventMock = vi.fn();
const isSupportedMock = vi.fn().mockResolvedValue(true);
const initializeAnalyticsMock = vi.fn().mockReturnValue({});
const setAnalyticsCollectionEnabledSdkMock = vi.fn();

vi.mock('firebase/analytics', () => ({
  isSupported: () => isSupportedMock(),
  initializeAnalytics: (...args: unknown[]) => initializeAnalyticsMock(...args),
  logEvent: (...args: unknown[]) => logEventMock(...args),
  setAnalyticsCollectionEnabled: (...args: unknown[]) =>
    setAnalyticsCollectionEnabledSdkMock(...args),
}));

const getMe = vi.fn();
const getFighters = vi.fn();
const matchesList = vi.fn();
const clientsList = vi.fn();
const startggStatus = vi.fn();
const clientWorkspacesList = vi.fn();
const claimsRedeem = vi.fn();
const clientsKind = vi.fn();
/**
 * Plan 30-06: `ClientWorkspaceLayout` now also mounts `DataCoveragePanel`,
 * which calls `useDataCoverage` -> `api.research.coverage` whenever the
 * resolved workspace is research. Never resolved (stays pending forever) —
 * this suite's own assertions are about the banner/suppression/analytics
 * composition, not the coverage panel's content, so a hung query is the
 * correct inert stand-in rather than a resolved fixture this file has no
 * use for.
 */
const researchCoverage = vi.fn((...args: unknown[]) => {
  void args;
  return new Promise(() => {});
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ApiError: actual.ApiError,
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
      research: {
        coverage: (...args: unknown[]) => researchCoverage(...args),
      },
    },
  };
});

/** Mirrors `AppRouter.test.tsx`'s own real-`BrowserRouter` navigation discipline. */
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

/**
 * A minimal composition of the SAME real components `AppRouter` mounts, at
 * a `/coach/:clientId` route with a single `vods` child rendering
 * `NoteComposer` directly — used only for the note-creation assertion,
 * which does not need the full `VodManagerPage` (player/match-list
 * machinery out of scope for this suite) to prove the RTEN-04 gate holds
 * end to end through the real `ClientWorkspaceLayout`/`ResearchSnapshotBanner`/
 * `ResearchTelemetrySuppression`/`RouteAnalytics` composition.
 */
function renderNoteComposerHarness(path: string, onCreateNote: (input: unknown) => void) {
  window.history.pushState({}, '', path);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const getCurrentTimeRef = { current: null as (() => number) | null };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AnalyticsFilterProvider>
          <BrowserRouter>
            <ResearchTelemetrySuppression />
            <RouteAnalytics />
            <Routes>
              <Route path="/coach/:clientId" element={<ClientWorkspaceLayout />}>
                <Route
                  path="vods"
                  element={
                    <NoteComposer
                      timestamps={[]}
                      getCurrentTimeRef={getCurrentTimeRef}
                      onCreateNote={onCreateNote as never}
                    />
                  }
                />
              </Route>
            </Routes>
          </BrowserRouter>
        </AnalyticsFilterProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('research session integration (Phase 29 Plan 12, browser half of RTEN-02/RTEN-04)', () => {
  const originalWebdriver = Object.getOwnPropertyDescriptor(window.navigator, 'webdriver');

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
    isSupportedMock.mockClear().mockResolvedValue(true);
    initializeAnalyticsMock.mockClear().mockReturnValue({});
    logEventMock.mockClear();
    setAnalyticsCollectionEnabledSdkMock.mockClear();

    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-api-key');
    vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'test.web.app');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'test-project');
    vi.stubEnv('VITE_FIREBASE_APP_ID', 'test-app-id');
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
    Object.defineProperty(window.navigator, 'webdriver', { value: false, configurable: true });
    delete (window as unknown as { dataLayer?: unknown[] }).dataLayer;
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
    vi.unstubAllEnvs();
    if (originalWebdriver) {
      Object.defineProperty(window.navigator, 'webdriver', originalWebdriver);
    }
  });

  it('renders no page content while the kind is pending, and the banner exactly once once it resolves to research', async () => {
    let resolveKind: ((value: { kind: string }) => void) | undefined;
    clientsKind.mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          resolveKind = resolvePromise;
        }),
    );

    renderAt('/coach/tetra/overview');

    expect(screen.queryByText('TETRA — Overview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('research-snapshot-banner')).not.toBeInTheDocument();

    resolveKind?.({ kind: 'research' });

    expect(await screen.findByTestId('research-snapshot-banner')).toBeInTheDocument();
    expect(await screen.findByText('TETRA — Overview')).toBeInTheDocument();
    expect(screen.getAllByTestId('research-snapshot-banner')).toHaveLength(1);
  });

  it('fires zero analytics-module calls across the whole mount-and-resolve sequence', async () => {
    clientsKind.mockResolvedValue({ kind: 'research' });
    renderAt('/coach/tetra/overview');

    expect(await screen.findByTestId('research-snapshot-banner')).toBeInTheDocument();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(isSupportedMock).not.toHaveBeenCalled();
    expect(initializeAnalyticsMock).not.toHaveBeenCalled();
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('navigating between two research workspace routes fires no page view or product event, and the banner remains present', async () => {
    clientsKind.mockResolvedValue({ kind: 'research' });
    const user = userEvent.setup();
    renderAt('/coach/tetra/overview');
    expect(await screen.findByTestId('research-snapshot-banner')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Fighters' }));
    expect(await screen.findByText('TETRA — Fighters')).toBeInTheDocument();
    expect(screen.getByTestId('research-snapshot-banner')).toBeInTheDocument();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('performing a note creation inside the research workspace still creates the note and fires no product event', async () => {
    clientsKind.mockResolvedValue({ kind: 'research' });
    const onCreateNote = vi.fn();
    const user = userEvent.setup();

    renderNoteComposerHarness('/coach/tetra/vods', onCreateNote);

    expect(await screen.findByTestId('research-snapshot-banner')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Timestamp time'), '1:23');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

    expect(onCreateNote).toHaveBeenCalledExactlyOnceWith({ seconds: 83, note: '' });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('nothing is posted to the public ingestion route during the research session', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    clientsKind.mockResolvedValue({ kind: 'research' });
    renderAt('/coach/tetra/overview');
    expect(await screen.findByTestId('research-snapshot-banner')).toBeInTheDocument();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('navigating research -> personal re-enables collection and fires exactly one page view for the personal path', async () => {
    clientsKind.mockResolvedValue({ kind: 'research' });
    renderAt('/coach/tetra/overview');
    expect(await screen.findByTestId('research-snapshot-banner')).toBeInTheDocument();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(logEventMock).not.toHaveBeenCalled();

    // Leave the workspace for a public, personal-context route.
    window.history.pushState({}, '', '/faq');
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect(window.location.pathname).toBe('/faq'));
    await waitFor(() => expect(logEventMock).toHaveBeenCalledTimes(1));
    expect(logEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'page_view',
      expect.objectContaining({ page_path: '/faq' }),
    );
  });

  it('positive control: an ordinary coaching workspace DOES fire analytics calls and renders no banner', async () => {
    clientsKind.mockResolvedValue({ kind: 'ordinary' });
    renderAt('/coach/tetra/overview');

    expect(await screen.findByText('TETRA — Overview')).toBeInTheDocument();
    expect(screen.queryByTestId('research-snapshot-banner')).not.toBeInTheDocument();

    await waitFor(() => expect(logEventMock).toHaveBeenCalledTimes(1));
    expect(logEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'page_view',
      expect.objectContaining({ page_path: '/coach/tetra/overview' }),
    );
  });

  it('a kind lookup failure renders the error affordance rather than page content, and collection stays disabled', async () => {
    clientsKind.mockRejectedValue(new Error('kind lookup failed'));
    renderAt('/coach/tetra/overview');

    expect(await screen.findByTestId('research-kind-load-error')).toBeInTheDocument();
    expect(screen.queryByText('TETRA — Overview')).not.toBeInTheDocument();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('anti-vacuous-pass guard: the router genuinely mounted the workspace route (not a stub), and the positive control observed non-zero analytics calls', async () => {
    clientsKind.mockResolvedValue({ kind: 'research' });
    renderAt('/coach/tetra');

    // The index route redirect proves real routing occurred, not a stub.
    await waitFor(() => expect(window.location.pathname).toBe('/coach/tetra/overview'));
    expect(await screen.findByTestId('research-snapshot-banner')).toBeInTheDocument();

    // The positive control (asserted in its own test above) must observe a
    // non-zero analytics call count — restated here as an explicit guard so
    // this file fails loudly if that assertion is ever weakened away.
    clientsKind.mockResolvedValue({ kind: 'ordinary' });
    renderAt('/coach/tetra/fighters');
    await waitFor(() => expect(logEventMock.mock.calls.length).toBeGreaterThan(0));
  });
});

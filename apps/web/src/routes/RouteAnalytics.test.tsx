import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { logAnalyticsPageView } from '@/lib/firebase';
import { RouteAnalytics } from './RouteAnalytics';

const useResearchSubject = vi.fn();

vi.mock('@/lib/firebase', () => ({
  logAnalyticsPageView: vi.fn(),
}));

vi.mock('@/hooks/useResearchSubject', () => ({
  useResearchSubject: () => useResearchSubject(),
}));

// ---------------------------------------------------------------------------
// Phase 29 (RTEN-04, D-06, review finding 29-08 MEDIUM): dependencies for the
// session-level SDK/data-layer test at the bottom of this file. These are
// registered up front (harmless for every OTHER test above, which never
// loads the REAL `@/lib/firebase` — it stays mocked as the plain object
// above) because `vi.mock` factories are hoisted to the top of the module.
// ---------------------------------------------------------------------------
const logEventMock = vi.fn();
const isSupportedMock = vi.fn().mockResolvedValue(true);
const initializeAnalyticsMock = vi.fn().mockReturnValue({});
const setAnalyticsCollectionEnabledMock = vi.fn();

vi.mock('firebase/analytics', () => ({
  isSupported: () => isSupportedMock(),
  initializeAnalytics: (...args: unknown[]) => initializeAnalyticsMock(...args),
  logEvent: (...args: unknown[]) => logEventMock(...args),
  setAnalyticsCollectionEnabled: (...args: unknown[]) => setAnalyticsCollectionEnabledMock(...args),
}));

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn().mockReturnValue({}),
}));

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(),
  GoogleAuthProvider: class GoogleAuthProvider {},
}));

function ordinaryStatus(
  overrides: Partial<{ isResearch: boolean; isPending: boolean; isError: boolean }> = {},
) {
  return { isResearch: false, isPending: false, isError: false, retry: vi.fn(), ...overrides };
}

function renderWithRouter(initialPath = '/faq') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <RouteAnalytics />
      <Routes>
        <Route path="/faq" element={<Link to="/gsp-calculator">go</Link>} />
        <Route path="/gsp-calculator" element={<div>calculator</div>} />
        <Route path="/coach/tetra/overview" element={<div>coach overview</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RouteAnalytics', () => {
  beforeEach(() => {
    vi.mocked(logAnalyticsPageView).mockClear();
    useResearchSubject.mockReset();
    useResearchSubject.mockReturnValue(ordinaryStatus());
  });

  it('logs a page_view for the initial route, including public ones', () => {
    renderWithRouter();
    expect(logAnalyticsPageView).toHaveBeenCalledExactlyOnceWith('/faq');
  });

  it('logs a page_view on every navigation', async () => {
    renderWithRouter();
    await userEvent.click(screen.getByRole('link', { name: 'go' }));

    expect(await screen.findByText('calculator')).toBeInTheDocument();
    expect(logAnalyticsPageView).toHaveBeenCalledTimes(2);
    expect(logAnalyticsPageView).toHaveBeenLastCalledWith('/gsp-calculator');
  });

  // ---------------------------------------------------------------------
  // Phase 29 (RTEN-04, D-06, review finding 29-08 HIGH): research-subject
  // gate + kind-aware effect dependencies.
  // ---------------------------------------------------------------------

  it('fires no page view for a research workspace', () => {
    useResearchSubject.mockReturnValue(ordinaryStatus({ isResearch: true }));
    renderWithRouter('/coach/tetra/overview');
    expect(logAnalyticsPageView).not.toHaveBeenCalled();
  });

  it('fires no page view while the kind lookup is pending (fail-closed)', () => {
    useResearchSubject.mockReturnValue(ordinaryStatus({ isPending: true }));
    renderWithRouter('/coach/tetra/overview');
    expect(logAnalyticsPageView).not.toHaveBeenCalled();
  });

  it('fires no page view when the kind lookup errored (fail-closed)', () => {
    useResearchSubject.mockReturnValue(ordinaryStatus({ isError: true }));
    renderWithRouter('/coach/tetra/overview');
    expect(logAnalyticsPageView).not.toHaveBeenCalled();
  });

  it('a pending->coaching resolution at an UNCHANGED path fires exactly one page view once the kind resolves — the effect re-evaluates on the kind, not only the path', () => {
    useResearchSubject.mockReturnValue(ordinaryStatus({ isPending: true }));
    const { rerender } = renderWithRouter('/coach/tetra/overview');
    expect(logAnalyticsPageView).not.toHaveBeenCalled();

    useResearchSubject.mockReturnValue(ordinaryStatus());
    rerender(
      <MemoryRouter initialEntries={['/coach/tetra/overview']}>
        <RouteAnalytics />
        <Routes>
          <Route path="/coach/tetra/overview" element={<div>coach overview</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(logAnalyticsPageView).toHaveBeenCalledExactlyOnceWith('/coach/tetra/overview');
  });

  it('a research->personal navigation fires exactly one page view, for the personal path only', async () => {
    useResearchSubject
      .mockReturnValueOnce(ordinaryStatus({ isResearch: true }))
      .mockReturnValue(ordinaryStatus());

    render(
      <MemoryRouter initialEntries={['/coach/tetra/overview']}>
        <RouteAnalytics />
        <Routes>
          <Route
            path="/coach/tetra/overview"
            element={<Link to="/gsp-calculator">leave workspace</Link>}
          />
          <Route path="/gsp-calculator" element={<div>calculator</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(logAnalyticsPageView).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('link', { name: 'leave workspace' }));
    expect(await screen.findByText('calculator')).toBeInTheDocument();

    expect(logAnalyticsPageView).toHaveBeenCalledExactlyOnceWith('/gsp-calculator');
  });
});

/**
 * Phase 29 (RTEN-04, D-06, review finding 29-08 MEDIUM): a mocked-setter
 * assertion does not prove zero GA4 traffic — this block goes one level
 * deeper than every test above by loading the REAL `@/lib/firebase` (not
 * the plain mocked object used everywhere else in this file) and mocking
 * `firebase/analytics` itself, so the assertion is at the SDK-module and
 * data-layer level. A genuine network-level assertion would require a
 * browser harness this repo does not have — that residual is recorded in
 * plan 29-02's assumption register, NOT claimed here.
 *
 * `vi.doUnmock` + `vi.resetModules()` (mirroring `lib/firebase.test.ts`'s
 * own fresh-import-per-test discipline) makes the NEXT dynamic `import(...)`
 * of `@/lib/firebase` and its consumers resolve to the real modules, while
 * `@/hooks/useResearchSubject` stays mocked (never `doUnmock`ed) — this test
 * is about the analytics wiring, not about re-testing the hook itself.
 */
describe('RouteAnalytics + NoteComposer session (Phase 29, RTEN-04, review finding 29-08 MEDIUM): SDK- and data-layer-level zero-hit assertion', () => {
  const originalWebdriver = Object.getOwnPropertyDescriptor(window.navigator, 'webdriver');

  beforeEach(() => {
    vi.doUnmock('@/lib/firebase');
    vi.resetModules();
    logEventMock.mockClear();
    isSupportedMock.mockClear();
    isSupportedMock.mockResolvedValue(true);
    initializeAnalyticsMock.mockClear();
    setAnalyticsCollectionEnabledMock.mockClear();
    useResearchSubject.mockReset();
    useResearchSubject.mockReturnValue(ordinaryStatus({ isResearch: true }));
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-api-key');
    vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'test.web.app');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'test-project');
    vi.stubEnv('VITE_FIREBASE_APP_ID', 'test-app-id');
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', 'G-TEST123');
    Object.defineProperty(window.navigator, 'webdriver', { value: false, configurable: true });
    delete (window as unknown as { dataLayer?: unknown[] }).dataLayer;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalWebdriver) {
      Object.defineProperty(window.navigator, 'webdriver', originalWebdriver);
    }
    // Re-mock '@/lib/firebase' for any test file evaluated after this one in
    // the same worker (Vitest test files each get their own module registry,
    // but restoring here keeps this block's setup/teardown symmetric and
    // self-contained rather than relying on that isolation alone).
    vi.doMock('@/lib/firebase', () => ({ logAnalyticsPageView: vi.fn() }));
  });

  it('across a simulated research session — router root mounted at a research workspace route, navigating between two workspace routes, and a note creation — the analytics module initializer and event logger both receive zero calls, and the global data-layer array is untouched', async () => {
    const { RouteAnalytics: FreshRouteAnalytics } = await import('./RouteAnalytics');
    const { NoteComposer: FreshNoteComposer } =
      await import('@/pages/VodManager/components/NoteComposer');

    const onCreateNote = vi.fn();
    // No function assigned (matches NoteComposer.test.tsx's `createRef`
    // pattern) — the composer's onFocus prefill only fires when a getter is
    // actually wired up, and we don't want it clobbering the typed value.
    const getCurrentTimeRef = { current: null as (() => number) | null };
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/coach/tetra/vods']}>
        <FreshRouteAnalytics />
        <Routes>
          <Route
            path="/coach/:clientId/vods"
            element={
              <>
                <Link to="/coach/tetra/reviews">go to reviews</Link>
                <FreshNoteComposer
                  timestamps={[]}
                  getCurrentTimeRef={getCurrentTimeRef}
                  onCreateNote={onCreateNote}
                />
              </>
            }
          />
          <Route path="/coach/:clientId/reviews" element={<div>reviews</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // A genuine note creation.
    await user.type(screen.getByLabelText('Timestamp time'), '1:23');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));
    expect(onCreateNote).toHaveBeenCalledExactlyOnceWith({ seconds: 83, note: '' });

    // Navigating between the two workspace routes.
    await user.click(screen.getByRole('link', { name: 'go to reviews' }));
    expect(await screen.findByText('reviews')).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 0));

    // isSupportedMock is only reached AFTER initAnalytics' dynamic import
    // step — asserting it was never called proves initAnalytics' body never
    // ran at all across the whole session, not merely that some individual
    // call bailed out partway through.
    expect(isSupportedMock).not.toHaveBeenCalled();
    expect(initializeAnalyticsMock).not.toHaveBeenCalled();
    expect(logEventMock).not.toHaveBeenCalled();
    expect((window as unknown as { dataLayer?: unknown[] }).dataLayer).toBeUndefined();
  });
});

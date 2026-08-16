import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Children } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { ProtectedRoute } from './ProtectedRoute';
import { AppRouter } from './AppRouter';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

/**
 * Phase 30.3 (Gate 6 corrective, defect A2): proves the demo-account label
 * reaches EVERY authenticated surface, derived from the route table itself.
 *
 * The defect this replaces: `DemoAccountBanner` was mounted by hand in seven
 * page components and verified by seven hand-written per-page tests. That
 * model can only ever prove the pages someone remembered — it silently
 * missed Tournament Detail, the blocked Prep brief, Scout, Reports, Profile,
 * and every `/coach/:clientId/*` coaching subroute, all reachable by a
 * login-bearing demo account, and it would miss every route added later.
 *
 * The replacement is a three-part structural proof, none of which can pass
 * vacuously:
 *
 *   1. ENUMERATION — the authenticated route set is read out of the real
 *      `AppRouter` element tree (not a regex over its source, and not a
 *      hand-maintained list), and every route that is not on the explicit
 *      public allowlist must be gated by `ProtectedRoute`.
 *   2. CHAIN — `ProtectedRoute` is rendered for a demo account and must
 *      produce the banner, which is what makes step 1's gating equivalent to
 *      banner coverage: `ProtectedRoute` renders `MainLayout`, and
 *      `MainLayout` is the single mount site.
 *   3. SINGLE MOUNT — a whole-tree source scan asserts exactly one render
 *      site exists, in `MainLayout`, so no page can re-introduce a duplicate
 *      (which would double-render the label) or a competing copy.
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

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const getMe = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      users: {
        ...original.api.users,
        getMe: () => getMe(),
        upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
      },
      // MainLayout mounts useStartggAutoSync; unlinked = the no-op path.
      startgg: { ...original.api.startgg, status: vi.fn().mockResolvedValue({ linked: false }) },
    },
  };
});

function demoProfile(isDemoAccount: boolean) {
  return {
    uid: 'test-uid',
    email: 'demo@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: null,
    isDemoAccount,
  };
}

// ---------------------------------------------------------------------------
// 1. ENUMERATION — read the authenticated route set out of the real element
//    tree returned by `AppRouter`, and require every non-public route to be
//    `ProtectedRoute`-gated.
// ---------------------------------------------------------------------------

interface EnumeratedRoute {
  /** The full path, with nested segments joined onto their parent. */
  path: string;
  /** True when this route, or any ancestor, renders `ProtectedRoute` in its element. */
  authenticated: boolean;
}

/** True when `node`'s element tree contains a `ProtectedRoute` element anywhere. */
function containsProtectedRoute(node: ReactNode): boolean {
  let found = false;
  Children.forEach(node as ReactNode, (child) => {
    if (found || !isValidElement(child)) return;
    if (child.type === ProtectedRoute) {
      found = true;
      return;
    }
    const props = child.props as { children?: ReactNode; element?: ReactNode };
    if (containsProtectedRoute(props.children) || containsProtectedRoute(props.element)) {
      found = true;
    }
  });
  return found;
}

function joinPath(parent: string, segment: string | undefined): string {
  if (segment === undefined) return parent;
  if (segment.startsWith('/')) return segment;
  return `${parent === '/' ? '' : parent}/${segment}`;
}

/** Walks the element tree collecting every `<Route>`, resolving nested paths and inherited gating. */
function collectRoutes(node: ReactNode, parentPath: string, parentGated: boolean): void {
  Children.forEach(node as ReactNode, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as {
      path?: string;
      index?: boolean;
      element?: ReactNode;
      children?: ReactNode;
    };
    if (child.type === Route) {
      const gated = parentGated || containsProtectedRoute(props.element);
      const fullPath = joinPath(parentPath, props.path);
      // A pathless layout route contributes gating to its children but is not
      // itself a navigable surface; an index route resolves to its parent path.
      if (props.path !== undefined || props.index === true) {
        ENUMERATED.push({ path: fullPath, authenticated: gated });
      }
      collectRoutes(props.children, fullPath, gated);
      return;
    }
    collectRoutes(props.children, parentPath, parentGated);
    collectRoutes(props.element, parentPath, parentGated);
  });
}

const ENUMERATED: EnumeratedRoute[] = [];
collectRoutes((AppRouter() as ReactElement).props.children, '/', false);

const AUTHENTICATED_PATHS = [
  ...new Set(ENUMERATED.filter((r) => r.authenticated).map((r) => r.path)),
].sort();
const UNAUTHENTICATED_PATHS = [
  ...new Set(ENUMERATED.filter((r) => !r.authenticated).map((r) => r.path)),
].sort();

/**
 * The routes that are deliberately reachable WITHOUT signing in — the landing
 * page, the prerendered/crawlable marketing pages, the two anonymous
 * no-account token surfaces, the start.gg custom-token handoff, and the
 * not-found pair. A demo account has no signed-in identity on these, so no
 * account-level label applies. Adding a route here is a deliberate decision
 * to leave it unauthenticated; adding one anywhere else fails the lock below.
 */
const PUBLIC_PATHS = [
  // The `*` catch-all, joined onto the root by `joinPath`.
  '/*',
  '/',
  '/auth/startgg',
  '/faq',
  '/gsp-calculator',
  '/not-found',
  '/r/:token',
  '/s/:token',
].sort();

describe('demo banner coverage: authenticated route enumeration (AppRouter element tree)', () => {
  it('anti-vacuous guard: the walk discovered a substantial route table', () => {
    expect(ENUMERATED.length).toBeGreaterThan(30);
    expect(AUTHENTICATED_PATHS.length).toBeGreaterThan(20);
  });

  it('every route outside the explicit public allowlist is ProtectedRoute-gated', () => {
    expect(UNAUTHENTICATED_PATHS).toEqual(PUBLIC_PATHS);
  });

  it.each([
    // The six surfaces the previous seven-page mounting model missed.
    '/tournaments/:eventId',
    '/tournaments/:entryKey/prep',
    '/scout',
    '/reports',
    '/profile',
    '/coach/:clientId/overview',
    // …plus every other coaching subroute, which the old model missed wholesale.
    '/coach/:clientId/fighters',
    '/coach/:clientId/vods',
    '/coach/:clientId/match-data',
    '/coach/:clientId/dashboard',
    '/coach/:clientId/fighter-analysis',
    '/coach/:clientId/matchups',
    '/coach/:clientId/reviews',
    '/coach/:clientId/reviews/:reviewId',
    '/coach/:clientId/sessions',
    '/coach/:clientId/sessions/:sessionId',
    // …and the client-owned workspace family.
    '/workspace/:tenantId/overview',
    '/workspace/:tenantId/vods',
    // …and the seven surfaces that used to mount the banner by hand, which
    // must keep their coverage through the layout mount.
    '/dashboard',
    '/matchups',
    '/opponents',
    '/match-data',
    '/vod',
    '/tournaments',
    '/coach',
  ])('authenticated route %s is covered', (path) => {
    expect(AUTHENTICATED_PATHS).toContain(path);
  });
});

// ---------------------------------------------------------------------------
// 2. CHAIN — ProtectedRoute (what step 1 proves every authenticated route is
//    wrapped in) actually renders the banner for a demo account.
// ---------------------------------------------------------------------------

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
                    <div>Page content</div>
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

describe('demo banner coverage: the ProtectedRoute -> MainLayout -> banner chain', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  it('renders the banner exactly once for a demo account, around arbitrary page content', async () => {
    getMe.mockResolvedValue(demoProfile(true));

    renderProtected();

    expect(await screen.findByText('Page content')).toBeInTheDocument();
    const banners = await screen.findAllByTestId('demo-account-banner');
    expect(banners).toHaveLength(1);
  });

  it('positive control: renders no banner for an ordinary account', async () => {
    getMe.mockResolvedValue(demoProfile(false));

    renderProtected();

    expect(await screen.findByText('Page content')).toBeInTheDocument();
    expect(screen.queryByTestId('demo-account-banner')).not.toBeInTheDocument();
  });

  it('renders no banner when the profile read fails (fail-quiet, never a false positive)', async () => {
    getMe.mockRejectedValue(new Error('profile unavailable'));

    renderProtected();

    expect(await screen.findByText('Page content')).toBeInTheDocument();
    expect(screen.queryByTestId('demo-account-banner')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. SINGLE MOUNT — exactly one render site, in MainLayout.
// ---------------------------------------------------------------------------

const SRC_ROOT = resolve('src');
const SELF_PATH = resolve('src/routes/demoBannerCoverage.test.tsx');

/** Recursively collects every non-test `.ts`/`.tsx` source file under `dir`. */
function collectNonTestSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectNonTestSourceFiles(fullPath));
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

const ALL_NON_TEST_SOURCE_FILES = collectNonTestSourceFiles(SRC_ROOT).filter(
  (file) => file !== SELF_PATH,
);

function relPath(absPath: string): string {
  return absPath.slice(resolve('.').length + 1);
}

/** Strips `//` and `/* *\/` comments so a comment-only mention never counts as a mount. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function discoverMountSites(): string[] {
  return ALL_NON_TEST_SOURCE_FILES.filter((file) => {
    if (file === resolve('src/components/DemoAccountBanner.tsx')) return false;
    return /<DemoAccountBanner\s*\/?>/.test(stripComments(readFileSync(file, 'utf-8')));
  }).map(relPath);
}

describe('demo banner coverage: exactly one mount site', () => {
  it('anti-vacuous guard: the whole-tree scan discovers the app sources', () => {
    expect(ALL_NON_TEST_SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it('MainLayout is the ONLY component that renders DemoAccountBanner', () => {
    // A new entry here is a regression, not something to allowlist: a second
    // mount double-renders the label on whichever route reaches it, and
    // re-establishes the per-page coverage model this file exists to replace.
    expect(discoverMountSites()).toEqual(['src/layouts/MainLayout.tsx']);
  });

  it('no page component imports DemoAccountBanner any more', () => {
    const pageImporters = ALL_NON_TEST_SOURCE_FILES.filter(
      (file) =>
        file.startsWith(resolve('src/pages')) &&
        stripComments(readFileSync(file, 'utf-8')).includes('DemoAccountBanner'),
    ).map(relPath);

    expect(pageImporters).toEqual([]);
  });
});

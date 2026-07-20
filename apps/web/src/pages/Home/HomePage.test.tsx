import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useLocation, MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { OnboardingIntent } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { faqEntries } from '@/data/faqData';
import * as onboardingOrigin from '@/lib/onboardingOrigin';
import { HomePage } from './HomePage';
import { featureEntries } from './featureData';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

/** Matches `LANDING_FAQ_PREVIEW_COUNT` in LandingContent.tsx (V12 SEO: only a preview shows on the landing page). */
const LANDING_FAQ_PREVIEW_COUNT = 5;

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
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      getMe: (...args: unknown[]) => getMe(...args),
      upsertMe: (...args: unknown[]) => upsertMe(...args),
    },
    parrygg: {
      login: {
        search: vi.fn(),
        start: vi.fn(),
        complete: vi.fn(),
      },
    },
  },
  ApiError: class ApiError extends Error {},
  getStartggLoginUrl: () => 'https://start.gg/oauth',
}));

/** Same fixed value for creationTime/lastSignInTime — the app's "brand-new sign-in" heuristic. */
const NEW_ACCOUNT_TIMESTAMP = 'Sun, 19 Jul 2026 12:00:00 GMT';

function makeNewAccountUser() {
  return makeMockUser({
    metadata: { creationTime: NEW_ACCOUNT_TIMESTAMP, lastSignInTime: NEW_ACCOUNT_TIMESTAMP },
  });
}

function defaultProfile(overrides: { onboardingIntent?: OnboardingIntent | null } = {}) {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: overrides.onboardingIntent ?? null,
  };
}

/** Renders the preselect state (if any) passed to /welcome via router `state` (D-02 ambiguous-origin ask). */
function WelcomeProbe() {
  const location = useLocation();
  const preselect = (location.state as { preselect?: string } | null)?.preselect;
  return <div>Welcome page (preselect: {preselect ?? 'none'})</div>;
}

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/dashboard" element={<div>Dashboard content</div>} />
            <Route path="/welcome" element={<WelcomeProbe />} />
            <Route path="/vod" element={<div>VOD Manager page</div>} />
            <Route path="/tournaments" element={<div>Tournaments page</div>} />
            <Route path="/scout" element={<div>Scout page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('HomePage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getMe.mockResolvedValue(defaultProfile());
    // ONBD-01/D-03: onboardingOrigin writes to real jsdom localStorage (not
    // mocked, mirroring ShareViewPage.test.tsx) — reset between tests.
    window.localStorage.clear();
  });

  it('renders crawlable marketing copy for signed-out visitors', async () => {
    setMockUser(null);
    renderHome();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'grandfinals.gg' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Free analytics for competitive Super Smash Bros. Ultimate players.'),
    ).toBeInTheDocument();

    // Sign-in card is still present and prominent.
    expect(screen.getByText('Sign in to track your Smash matches.')).toBeInTheDocument();

    // Every feature block renders as a heading with its description.
    for (const feature of featureEntries) {
      expect(screen.getByRole('heading', { name: feature.title })).toBeInTheDocument();
      expect(screen.getByText(feature.description)).toBeInTheDocument();
    }

    // FAQ renders only the preview slice (V12 SEO: full list lives at /faq).
    for (const entry of faqEntries.slice(0, LANDING_FAQ_PREVIEW_COUNT)) {
      expect(screen.getByRole('heading', { name: entry.question })).toBeInTheDocument();
      expect(screen.getByText(entry.answer)).toBeInTheDocument();
    }
    for (const entry of faqEntries.slice(LANDING_FAQ_PREVIEW_COUNT)) {
      expect(screen.queryByRole('heading', { name: entry.question })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'See all FAQs →' })).toHaveAttribute('href', '/faq');

    // Reciprocal links to GitHub and the Discord community.
    expect(screen.getByRole('link', { name: /view the source on github/i })).toHaveAttribute(
      'href',
      'https://github.com/bsmerbeck/smash-tracker/',
    );
    expect(screen.getByRole('link', { name: /ssbu training grounds discord/i })).toHaveAttribute(
      'href',
      'https://discord.gg/9TN8RFZ',
    );
  });

  it('redirects a returning signed-in user (no saved intent, no origin) to /dashboard', async () => {
    setMockUser(makeMockUser());
    renderHome();

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'grandfinals.gg' }),
    ).not.toBeInTheDocument();
  });

  it('ONBD-01/D-01: routes a brand-new account with no saved intent and no origin to /welcome', async () => {
    setMockUser(makeNewAccountUser());
    renderHome();

    expect(await screen.findByText('Welcome page (preselect: none)')).toBeInTheDocument();
  });

  it('a saved onboardingIntent always wins, routing straight to its guided path regardless of account age', async () => {
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'scout' }));
    setMockUser(makeNewAccountUser());
    renderHome();

    expect(await screen.findByText('Scout page')).toBeInTheDocument();
  });

  it('ONBD-01/D-02: a new account with an unambiguous vodShare origin skips the question, auto-saves review_vod (asked: false), and lands on the VOD guided path', async () => {
    onboardingOrigin.stamp({ kind: 'vodShare', returnPath: '/s/abc123' });
    setMockUser(makeNewAccountUser());
    renderHome();

    expect(await screen.findByText('VOD Manager page')).toBeInTheDocument();
    expect(upsertMe).toHaveBeenCalledWith({
      onboardingIntent: 'review_vod',
      onboardingAsked: false,
    });
  });

  it('ONBD-01/D-02: a new account with an unambiguous recap origin skips the question, auto-saves prepare (asked: false), and lands on the tournaments guided path', async () => {
    onboardingOrigin.stamp({ kind: 'recap', returnPath: '/s/def456' });
    setMockUser(makeNewAccountUser());
    renderHome();

    expect(await screen.findByText('Tournaments page')).toBeInTheDocument();
    expect(upsertMe).toHaveBeenCalledWith({
      onboardingIntent: 'prepare',
      onboardingAsked: false,
    });
  });

  it('ONBD-01/D-02: a new account with an ambiguous coachReview origin is routed to /welcome with review_vod pre-selected — never auto-saved', async () => {
    onboardingOrigin.stamp({ kind: 'coachReview', returnPath: '/r/token1' });
    setMockUser(makeNewAccountUser());
    renderHome();

    expect(await screen.findByText('Welcome page (preselect: review_vod)')).toBeInTheDocument();
    expect(upsertMe).not.toHaveBeenCalledWith(
      expect.objectContaining({ onboardingIntent: expect.anything() }),
    );
  });

  it('a RETURNING account with no saved intent lands on /dashboard even with an unambiguous origin stamp present (the new-account gate applies broadly)', async () => {
    onboardingOrigin.stamp({ kind: 'vodShare', returnPath: '/s/abc123' });
    setMockUser(makeMockUser());
    renderHome();

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(upsertMe).not.toHaveBeenCalledWith(
      expect.objectContaining({ onboardingIntent: expect.anything() }),
    );
  });
});

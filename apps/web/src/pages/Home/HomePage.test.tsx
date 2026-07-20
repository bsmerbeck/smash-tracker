import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { faqEntries } from '@/data/faqData';
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

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
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

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/dashboard" element={<div>Dashboard content</div>} />
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

  it('redirects signed-in users to /dashboard instead of showing the landing page', async () => {
    setMockUser(makeMockUser());
    renderHome();

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'grandfinals.gg' }),
    ).not.toBeInTheDocument();
  });
});

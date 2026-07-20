import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { SidebarContent } from './SidebarContent';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

/**
 * Phase 11 fix round 2 (D-01/D1): routes include `/coach/:clientId/*` so
 * `useActiveSubject()` resolves a real `clientId` for the workspace-rail
 * cases, mirroring `useMatches.test.tsx`'s two-route `Wrapper` pattern.
 */
function renderWithProviders(ui: ReactElement, path = '/dashboard') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/coach/:clientId/*" element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

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

const listClients = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' }),
    },
    coaching: {
      clients: {
        list: (...args: unknown[]) => listClients(...args),
      },
    },
  },
}));

describe('SidebarContent', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('makes the avatar + email block a link to /profile', () => {
    renderWithProviders(<SidebarContent />);

    const profileLink = screen.getByRole('link', { name: 'Your profile' });
    expect(profileLink).toHaveAttribute('href', '/profile');
    expect(profileLink).toHaveTextContent('pilot@example.com');
  });

  it('makes the nav region the scrollable area so the footer stays pinned below the fold', () => {
    renderWithProviders(<SidebarContent />);

    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(nav.className).toEqual(expect.stringContaining('min-h-0'));
    expect(nav.className).toEqual(expect.stringContaining('flex-1'));
    expect(nav.className).toEqual(expect.stringContaining('overflow-y-auto'));
  });

  it('renders the Training Grounds and Donate footer links outside the scrollable nav', () => {
    renderWithProviders(<SidebarContent />);

    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const trainingGroundsLink = screen.getByRole('link', { name: /Training Grounds/ });
    const donateLink = screen.getByRole('link', { name: /Donate/ });

    expect(nav).not.toContainElement(trainingGroundsLink);
    expect(nav).not.toContainElement(donateLink);
  });
});

/**
 * Phase 11 fix round 2 (D-01/D1): the coaching-hub rail at /coach — no
 * clientId — replaces the personal nav entirely with a minimal "Coaching" /
 * "You" pair (PAR-04/TEN-05: zero personal navItems anywhere under /coach).
 */
describe('SidebarContent coaching-hub rail (walkthrough fix round 2, D-01/D1)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('renders no personal navItems at /coach', () => {
    renderWithProviders(<SidebarContent />, '/coach');

    expect(screen.queryByRole('link', { name: /Fighter Analysis/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Choose Primary/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Match Data/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /GSP/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Tournaments/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Groups/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /AI Reports/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Scouting/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Integrations/ })).not.toBeInTheDocument();
  });

  it('renders a Coaching section with an active All Clients item and a You section with Back to Personal', () => {
    renderWithProviders(<SidebarContent />, '/coach');

    expect(screen.getByText('Coaching')).toBeInTheDocument();
    const allClients = screen.getByRole('link', { name: 'All Clients' });
    expect(allClients).toHaveAttribute('href', '/coach');
    expect(allClients.className).toEqual(expect.stringContaining('coaching-accent'));

    expect(screen.getByText('You')).toBeInTheDocument();
    const backToPersonal = screen.getByRole('link', { name: /Back to Personal/ });
    expect(backToPersonal).toHaveAttribute('href', '/dashboard');
  });
});

/**
 * Phase 11 fix round 2 (D-01/D1, D-03/D3), fix round 3 (FB-5), Phase 12
 * (Reviews nav item): the client-workspace rail at /coach/:clientId/* —
 * back link, accent-tinted client header card, then six items (Overview/
 * Fighters/Matches/VODs/Analytics/Reviews).
 */
describe('SidebarContent client-workspace rail (walkthrough fix round 2, D-01/D1)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    listClients.mockResolvedValue([{ clientId: 'tetra', label: 'Tetra', draftCount: 0 }]);
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('renders no personal navItems at /coach/:clientId/overview', () => {
    renderWithProviders(<SidebarContent />, '/coach/tetra/overview');

    expect(screen.queryByRole('link', { name: /Fighter Analysis/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Choose Primary/ })).not.toBeInTheDocument();
  });

  it('renders the All Clients back link, the accent client header card, and the six workspace items', async () => {
    renderWithProviders(<SidebarContent />, '/coach/tetra/overview');

    const backLink = screen.getByRole('link', { name: /All Clients/ });
    expect(backLink).toHaveAttribute('href', '/coach');

    expect(await screen.findByText('Tetra')).toBeInTheDocument();
    expect(screen.getByText('Managed client')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      '/coach/tetra/overview',
    );
    expect(screen.getByRole('link', { name: 'Fighters' })).toHaveAttribute(
      'href',
      '/coach/tetra/fighters',
    );
    expect(screen.getByRole('link', { name: 'Matches' })).toHaveAttribute(
      'href',
      '/coach/tetra/match-data',
    );
    expect(screen.getByRole('link', { name: 'VODs' })).toHaveAttribute('href', '/coach/tetra/vods');
    expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute(
      'href',
      '/coach/tetra/dashboard',
    );
    expect(screen.getByRole('link', { name: 'Reviews' })).toHaveAttribute(
      'href',
      '/coach/tetra/reviews',
    );
  });

  it('highlights Reviews as active on the nested composer sub-route', () => {
    renderWithProviders(<SidebarContent />, '/coach/tetra/reviews/r1');

    const reviews = screen.getByRole('link', { name: 'Reviews' });
    expect(reviews.className).toEqual(expect.stringContaining('coaching-accent'));
  });

  it('highlights Analytics as active on the client-scoped fighter-analysis sub-route', () => {
    renderWithProviders(<SidebarContent />, '/coach/tetra/fighter-analysis');

    const analytics = screen.getByRole('link', { name: 'Analytics' });
    expect(analytics.className).toEqual(expect.stringContaining('coaching-accent'));
  });
});

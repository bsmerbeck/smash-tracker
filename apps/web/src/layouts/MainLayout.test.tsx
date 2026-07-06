import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
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
  },
}));

describe('MainLayout', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('renders the layout with all nav links and the signed-in user email', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <MainLayout>
              <div>Page content</div>
            </MainLayout>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Page content')).toBeInTheDocument();

    for (const item of navItems) {
      expect(screen.getAllByRole('link', { name: item.title }).length).toBeGreaterThan(0);
    }

    expect(screen.getAllByText('pilot@example.com').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('renders the Donorbox donate link below Training Grounds in the sidebar', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <MainLayout>
              <div>Page content</div>
            </MainLayout>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByText('Page content');

    const donateLinks = screen.getAllByRole('link', { name: /donate/i });
    expect(donateLinks.length).toBeGreaterThan(0);
    for (const link of donateLinks) {
      expect(link).toHaveAttribute('href', 'https://donorbox.org/support-smash-tracker');
      expect(link).toHaveAttribute('target', '_blank');
    }
  });
});

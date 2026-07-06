import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '@/context/AuthContext';
import { SidebarContent } from './SidebarContent';
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

describe('SidebarContent', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser({ email: 'pilot@example.com' }));
  });

  it('makes the avatar + email block a link to /profile', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <SidebarContent />
        </AuthProvider>
      </MemoryRouter>,
    );

    const profileLink = screen.getByRole('link', { name: 'Your profile' });
    expect(profileLink).toHaveAttribute('href', '/profile');
    expect(profileLink).toHaveTextContent('pilot@example.com');
  });

  it('makes the nav region the scrollable area so the footer stays pinned below the fold', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <SidebarContent />
        </AuthProvider>
      </MemoryRouter>,
    );

    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(nav.className).toEqual(expect.stringContaining('min-h-0'));
    expect(nav.className).toEqual(expect.stringContaining('flex-1'));
    expect(nav.className).toEqual(expect.stringContaining('overflow-y-auto'));
  });

  it('renders the Training Grounds and Donate footer links outside the scrollable nav', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <SidebarContent />
        </AuthProvider>
      </MemoryRouter>,
    );

    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const trainingGroundsLink = screen.getByRole('link', { name: /Training Grounds/ });
    const donateLink = screen.getByRole('link', { name: /Donate/ });

    expect(nav).not.toContainElement(trainingGroundsLink);
    expect(nav).not.toContainElement(donateLink);
  });
});

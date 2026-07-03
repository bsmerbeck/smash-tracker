import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { DashboardPage } from './DashboardPage';
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

const getFighters = vi.fn();
const listMatches = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
    },
  },
}));

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/choose-primary" element={<div>Choose primary page</div>} />
              <Route path="/choose-secondary" element={<div>Choose secondary page</div>} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
  });

  it('shows an empty state with links to choose fighters when the user has none selected', async () => {
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderDashboard();

    expect(await screen.findByText("You haven't picked any fighters yet!")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose Primary Fighters' })).toHaveAttribute(
      'href',
      '/choose-primary',
    );
    expect(screen.getByRole('link', { name: 'Choose Secondary Fighters' })).toHaveAttribute(
      'href',
      '/choose-secondary',
    );
  });

  it('renders the dashboard widgets once the user has selected fighters', async () => {
    getFighters.mockResolvedValue({ primary: [1], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderDashboard();

    expect(await screen.findAllByText('Overall Record')).not.toHaveLength(0);
    expect(screen.getByText('Form')).toBeInTheDocument();
    expect(screen.getByText('Casual vs Competitive')).toBeInTheDocument();
    expect(screen.getByText('Online vs Offline')).toBeInTheDocument();
    expect(screen.getByText('Previous Matches')).toBeInTheDocument();
    expect(screen.getByText('Form Curve')).toBeInTheDocument();
    expect(screen.getByText('Most-Played Stages')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Match' })).toBeEnabled();
  });

  it('shows a no-matches empty state for a new user with fighters but no matches yet', async () => {
    getFighters.mockResolvedValue({ primary: [1], secondary: [] });
    listMatches.mockResolvedValue([]);

    renderDashboard();

    await waitFor(() => expect(screen.getAllByText('Overall Record')).not.toHaveLength(0));
    expect(screen.getAllByText('No match data to report yet.').length).toBeGreaterThan(0);
    expect(screen.getByText('No matches recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('No stage data to report yet.')).toBeInTheDocument();
    expect(screen.getByText('No matches reported')).toBeInTheDocument();
  });
});

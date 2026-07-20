import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OnboardingIntent } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { ClientHubPage } from './ClientHubPage';
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

const clientsList = vi.fn();
const getMe = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      getMe: (...args: unknown[]) => getMe(...args),
    },
    coaching: {
      clients: {
        list: (...args: unknown[]) => clientsList(...args),
        export: vi.fn(),
      },
    },
  },
}));

function defaultProfile(overrides: { onboardingIntent?: OnboardingIntent | null } = {}) {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: true,
    onboardingIntent: overrides.onboardingIntent ?? null,
  };
}

function renderHub() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/coach']}>
        <AuthProvider>
          <Routes>
            <Route path="/coach" element={<ClientHubPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClientHubPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  // Phase 13 (ONBD-05/D-07): a coach who arrived via onboarding
  // (`onboardingIntent === 'coach_clients'`) and has no clients yet gets the
  // zero-client empty state's create trigger spotlighted.
  it('D-07: spotlights the existing create-client trigger when onboardingIntent is coach_clients and there are no clients', async () => {
    clientsList.mockResolvedValue([]);
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'coach_clients' }));

    renderHub();

    expect(await screen.findByTestId('onboarding-spotlight')).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(screen.getByTestId('onboarding-spotlight-hint')).toBeInTheDocument();
    // Still the SAME single trigger — never a second create form.
    expect(screen.getAllByRole('button', { name: 'Create your first client' })).toHaveLength(1);
  });

  it('does not spotlight when there is no saved coach onboarding intent', async () => {
    clientsList.mockResolvedValue([]);
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: null }));

    renderHub();

    await screen.findByRole('button', { name: 'Create your first client' });
    expect(screen.queryByTestId('onboarding-spotlight-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-spotlight')).toHaveAttribute('data-active', 'false');
  });

  it('does not spotlight once the coach already has a client, even with the coach onboarding intent saved', async () => {
    clientsList.mockResolvedValue([
      { clientId: 'tetra', label: 'TETRA', draftCount: 0, lastActivityAt: null },
    ]);
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'coach_clients' }));

    renderHub();

    await screen.findByText('TETRA');
    expect(screen.queryByTestId('onboarding-spotlight')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-spotlight-hint')).not.toBeInTheDocument();
  });

  it('never auto-opens the dialog — the spotlighted trigger still requires a click to open it', async () => {
    clientsList.mockResolvedValue([]);
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'coach_clients' }));

    renderHub();

    await screen.findByTestId('onboarding-spotlight');
    // The dialog content (the label input) is not rendered until the
    // trigger is clicked — no controlled `open` prop was ever forced true.
    expect(screen.queryByLabelText('Client label')).not.toBeInTheDocument();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OnboardingIntent } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { ONBOARDING_ORIGIN_STORAGE_KEY } from '@/lib/onboardingOrigin';
import { GuidedPathCard } from './GuidedPathCard';

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
const getOnboardingProgress = vi.fn();
const listCoachingClients = vi.fn();
const manualEntry = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: { getMe: (...args: unknown[]) => getMe(...args) },
    onboarding: { getProgress: (...args: unknown[]) => getOnboardingProgress(...args) },
    coaching: { clients: { list: (...args: unknown[]) => listCoachingClients(...args) } },
    tournaments: { manualEntry: (...args: unknown[]) => manualEntry(...args) },
  },
  ApiError: class ApiError extends Error {},
}));

function defaultProfile(
  overrides: {
    onboardingIntent?: OnboardingIntent | null;
    coachingModeEnabled?: boolean;
  } = {},
) {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: overrides.coachingModeEnabled ?? false,
    onboardingIntent: overrides.onboardingIntent ?? null,
  };
}

function renderCard(initialEntry = '/vod') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <Routes>
            <Route path="/vod" element={<GuidedPathCard />} />
            <Route path="/dashboard" element={<GuidedPathCard />} />
            <Route path="/tournaments" element={<GuidedPathCard />} />
            <Route path="/coach" element={<GuidedPathCard />} />
            <Route path="/welcome" element={<div>Welcome page</div>} />
            <Route path="/s/abc123" element={<div>Shared VOD page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GuidedPathCard', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    getOnboardingProgress.mockResolvedValue({
      analytics: false,
      vod: false,
      tournamentPrep: false,
      scout: false,
    });
    listCoachingClients.mockResolvedValue([]);
    setMockUser(makeMockUser());
  });

  it('renders nothing when no intent is saved', async () => {
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: null }));
    renderCard();

    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(screen.queryByTestId('guided-path-card')).not.toBeInTheDocument();
  });

  it('renders nothing on /dashboard even with a saved, incomplete intent (D-01 density rule)', async () => {
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'review_vod' }));
    renderCard('/dashboard');

    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(screen.queryByTestId('guided-path-card')).not.toBeInTheDocument();
  });

  it('shows the first step with server-derived progress and an accent link for review_vod', async () => {
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'review_vod' }));

    renderCard('/vod');

    expect(await screen.findByText('Attach a VOD')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a VOD' })).toHaveAttribute('href', '/vod');
    // Not-yet-current steps render no action button (D-04: "one action").
    expect(screen.queryByRole('link', { name: 'Add notes' })).not.toBeInTheDocument();
  });

  it('collapses (renders nothing) once the server marks the intent done', async () => {
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'scout' }));
    getOnboardingProgress.mockResolvedValue({
      analytics: false,
      vod: false,
      tournamentPrep: false,
      scout: true,
    });

    renderCard('/vod');

    await waitFor(() => expect(getOnboardingProgress).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('guided-path-card')).not.toBeInTheDocument());
  });

  it('switch-intent link routes to /welcome', async () => {
    const user = userEvent.setup();
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'scout' }));

    renderCard('/vod');

    await user.click(await screen.findByRole('link', { name: 'Switch intent' }));
    expect(await screen.findByText('Welcome page')).toBeInTheDocument();
  });

  it('shows the origin chip and links back to a safe, stamped return path', async () => {
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'review_vod' }));
    window.localStorage.setItem(
      ONBOARDING_ORIGIN_STORAGE_KEY,
      JSON.stringify({ kind: 'vodShare', returnPath: '/s/abc123', timestamp: Date.now() }),
    );

    renderCard('/vod');

    const chip = await screen.findByTestId('guided-origin-chip');
    expect(chip).toHaveTextContent('You came from a shared VOD');
    expect(chip).toHaveAttribute('href', '/s/abc123');
  });

  it('does not render an origin chip when no origin stamp is present', async () => {
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'review_vod' }));

    renderCard('/vod');

    await screen.findByText('Attach a VOD');
    expect(screen.queryByTestId('guided-origin-chip')).not.toBeInTheDocument();
  });

  it('prepare path: reveals the manual event-association fallback and never dead-ends (D-05)', async () => {
    const user = userEvent.setup();
    getMe.mockResolvedValue(defaultProfile({ onboardingIntent: 'prepare' }));

    renderCard('/tournaments');

    await user.click(await screen.findByRole('button', { name: 'Associate manually' }));
    expect(await screen.findByTestId('manual-event-association-form')).toBeInTheDocument();
  });

  it('coach_clients: enableCoaching is done via profile.coachingModeEnabled, createClient via client existence', async () => {
    getMe.mockResolvedValue(
      defaultProfile({ onboardingIntent: 'coach_clients', coachingModeEnabled: true }),
    );
    listCoachingClients.mockResolvedValue([]);

    renderCard('/coach');

    expect(await screen.findByText('Step 2 of 2')).toBeInTheDocument();
    expect(screen.getByTestId('guided-step-enableCoaching')).toHaveAttribute('data-done', 'true');
    expect(screen.getByTestId('guided-step-createClient')).toHaveAttribute('data-done', 'false');
    expect(screen.getByRole('link', { name: 'Create client' })).toHaveAttribute('href', '/coach');
  });

  it('coach_clients: collapses once a client exists', async () => {
    getMe.mockResolvedValue(
      defaultProfile({ onboardingIntent: 'coach_clients', coachingModeEnabled: true }),
    );
    listCoachingClients.mockResolvedValue([{ clientId: 'c1', label: 'Client One' }]);

    renderCard('/coach');

    await waitFor(() => expect(listCoachingClients).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('guided-path-card')).not.toBeInTheDocument());
  });
});

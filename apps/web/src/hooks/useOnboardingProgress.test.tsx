import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { OnboardingIntent } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { useOnboardingProgress } from './useOnboardingProgress';

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

vi.mock('@/lib/api', () => ({
  api: {
    users: { getMe: (...args: unknown[]) => getMe(...args) },
    onboarding: { getProgress: (...args: unknown[]) => getOnboardingProgress(...args) },
  },
}));

function defaultProfile(onboardingIntent: OnboardingIntent | null) {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const [queryClient] = [new QueryClient({ defaultOptions: { queries: { retry: false } } })];
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function ProgressProbe() {
  const { data, isSuccess, fetchStatus } = useOnboardingProgress();
  if (!isSuccess) {
    return <div>fetchStatus: {fetchStatus}</div>;
  }
  return <div>vod: {String(data.vod)}</div>;
}

describe('useOnboardingProgress', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    getOnboardingProgress.mockResolvedValue({
      analytics: false,
      vod: true,
      tournamentPrep: false,
      scout: false,
    });
  });

  it('D-04: stays idle (never fetches) when the signed-in user has no saved onboarding intent', async () => {
    getMe.mockResolvedValue(defaultProfile(null));
    setMockUser(makeMockUser());

    render(
      <Wrapper>
        <ProgressProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(getOnboardingProgress).not.toHaveBeenCalled();
    expect(await screen.findByText('fetchStatus: idle')).toBeInTheDocument();
  });

  it('fetches GET /api/onboarding/progress once a saved intent exists, returning the server booleans as-is', async () => {
    getMe.mockResolvedValue(defaultProfile('review_vod'));
    setMockUser(makeMockUser());

    render(
      <Wrapper>
        <ProgressProbe />
      </Wrapper>,
    );

    expect(await screen.findByText('vod: true')).toBeInTheDocument();
    expect(getOnboardingProgress).toHaveBeenCalledTimes(1);
  });
});

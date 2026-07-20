import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import { useProfile, useUpdateCoachingModeEnabled } from './useProfile';
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

import { AuthProvider } from '@/context/AuthContext';

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function ProfileProbe() {
  const { data, isSuccess } = useProfile();
  const update = useUpdateCoachingModeEnabled();
  if (!isSuccess) {
    return <div>loading</div>;
  }
  return (
    <div>
      <div>coachingModeEnabled: {String(data.coachingModeEnabled)}</div>
      <button onClick={() => update.mutate(true)}>Enable coaching</button>
    </div>
  );
}

/** Phase 11 walkthrough fix round 1 (FB-3). */
describe('useProfile / useUpdateCoachingModeEnabled', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads coachingModeEnabled from GET /api/users/me', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            uid: 'uid-1',
            email: 'pilot@example.com',
            fighters: { primary: [], secondary: [] },
            coachingModeEnabled: false,
            onboardingIntent: null,
          }),
      }),
    );

    render(
      <Wrapper>
        <ProfileProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('coachingModeEnabled: false')).toBeInTheDocument());
  });

  it('PUTs coachingModeEnabled and refetches the profile', async () => {
    let enabled = false;
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as { coachingModeEnabled?: boolean };
        enabled = body.coachingModeEnabled ?? enabled;
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ uid: 'uid-1', email: 'pilot@example.com' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({
            uid: 'uid-1',
            email: 'pilot@example.com',
            fighters: { primary: [], secondary: [] },
            coachingModeEnabled: enabled,
            onboardingIntent: null,
          }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Wrapper>
        <ProfileProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('coachingModeEnabled: false')).toBeInTheDocument());

    screen.getByRole('button', { name: 'Enable coaching' }).click();

    await waitFor(() => expect(screen.getByText('coachingModeEnabled: true')).toBeInTheDocument());

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      coachingModeEnabled: true,
    });
  });
});

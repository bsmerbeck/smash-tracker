import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import { useIsDemoAccount } from './useIsDemoAccount';
import { useProfile } from './useProfile';
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

function DemoProbe() {
  const isDemoAccount = useIsDemoAccount();
  return <div>isDemoAccount: {String(isDemoAccount)}</div>;
}

/**
 * Also surfaces the underlying query STATUS, so a rejection test can prove
 * the read genuinely failed rather than succeeded-with-a-defaulted-flag —
 * the two are indistinguishable from the hook's boolean alone.
 */
function ProfileStateProbe() {
  const { status } = useProfile();
  const isDemoAccount = useIsDemoAccount();
  return (
    <div>
      <div>status: {status}</div>
      <div>isDemoAccount: {String(isDemoAccount)}</div>
    </div>
  );
}

function stubProfileFetch(profile: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(profile),
    }),
  );
}

/**
 * Phase 30.3 (Gate 6, web demo-isolation worker): proves `useIsDemoAccount`
 * end-to-end through the real `GET /api/users/me` -> `apiRequestParsed` ->
 * shared `userProfileSchema` -> `useProfile()` chain (a stubbed `fetch`, not
 * a mocked hook), so the wiring in `@/lib/api.ts` is actually exercised —
 * not just the schema in isolation (`@/lib/demoAccount.test.ts`).
 */
describe('useIsDemoAccount', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves true when GET /api/users/me carries isDemoAccount: true', async () => {
    stubProfileFetch({
      uid: 'uid-1',
      email: 'demo@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
      isDemoAccount: true,
    });

    render(
      <Wrapper>
        <DemoProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('isDemoAccount: true')).toBeInTheDocument());
  });

  it("positive control: resolves false for an ordinary account's response (isDemoAccount: false)", async () => {
    stubProfileFetch({
      uid: 'uid-2',
      email: 'ordinary@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
      isDemoAccount: false,
    });

    render(
      <Wrapper>
        <DemoProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('isDemoAccount: false')).toBeInTheDocument());
  });

  it('REJECTS a response missing isDemoAccount — the profile query errors instead of substituting false', async () => {
    stubProfileFetch({
      uid: 'uid-3',
      email: 'ordinary@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
    });

    render(
      <Wrapper>
        <ProfileStateProbe />
      </Wrapper>,
    );

    // The parse failure surfaces as an ERRORED profile read, never as a
    // successfully-parsed profile carrying a defaulted flag (Phase 30.3 Gate
    // 6 corrective, defect A1). The hook still reports false — an
    // unresolved profile renders no label — but the read is provably not a
    // success, so no demo protection can be silently switched off by a
    // response that merely omitted the field.
    await waitFor(() => expect(screen.getByText('status: error')).toBeInTheDocument());
    expect(screen.getByText('isDemoAccount: false')).toBeInTheDocument();
  });

  it('REJECTS an explicit null isDemoAccount — the exact shape the removed .nullish() override accepted', async () => {
    stubProfileFetch({
      uid: 'uid-4',
      email: 'ordinary@example.com',
      fighters: { primary: [], secondary: [] },
      coachingModeEnabled: false,
      onboardingIntent: null,
      isDemoAccount: null,
    });

    render(
      <Wrapper>
        <ProfileStateProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('status: error')).toBeInTheDocument());
    expect(screen.getByText('isDemoAccount: false')).toBeInTheDocument();
  });

  it('defaults to false while no user is signed in (query disabled, no false positive)', () => {
    resetAuthMock();
    render(
      <Wrapper>
        <DemoProbe />
      </Wrapper>,
    );

    expect(screen.getByText('isDemoAccount: false')).toBeInTheDocument();
  });
});

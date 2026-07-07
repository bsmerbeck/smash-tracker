import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useGspSettings, useUpdateGspSettings } from './useGspSettings';
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
  const [queryClient] = [new QueryClient({ defaultOptions: { queries: { retry: false } } })];
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function SettingsProbe() {
  const { data, isSuccess } = useGspSettings();
  const update = useUpdateGspSettings();
  if (!isSuccess) {
    return <div>loading</div>;
  }
  return (
    <div>
      <div>eliteThreshold: {data.eliteThreshold}</div>
      <button onClick={() => update.mutate({ eliteThreshold: 12_000_000 })}>Update</button>
    </div>
  );
}

describe('useGspSettings', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches settings with a Bearer auth header and validates against the shared schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ eliteThreshold: 10_300_000, updatedAt: 0 }),
      }),
    );

    render(
      <Wrapper>
        <SettingsProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('eliteThreshold: 10300000')).toBeInTheDocument());

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    if (!call) {
      throw new Error('expected fetch to have been called');
    }
    const [url, init] = call;
    expect(String(url)).toContain('/api/gsp-settings');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer mock-id-token');
  });

  it('PUTs the update and invalidates the settings query', async () => {
    let stored = { eliteThreshold: 10_300_000, updatedAt: 0 };
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        stored = { eliteThreshold: 12_000_000, updatedAt: 999 };
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(stored),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Wrapper>
        <SettingsProbe />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByText('eliteThreshold: 10300000')).toBeInTheDocument());

    screen.getByRole('button', { name: 'Update' }).click();

    await waitFor(() => expect(screen.getByText('eliteThreshold: 12000000')).toBeInTheDocument());

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      eliteThreshold: 12_000_000,
    });
  });
});

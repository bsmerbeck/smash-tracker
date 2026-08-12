import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  ENRICHMENT_ATTRIBUTION_MAX_KEYS_PER_REQUEST,
  useEnrichmentAttribution,
} from './useEnrichmentAttribution';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

const enrichmentAttribution = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      enrichmentAttribution: (...args: unknown[]) => enrichmentAttribution(...args),
    },
  },
}));

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

function Wrapper({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useEnrichmentAttribution', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests only the given match keys and returns a map keyed by matchKey', async () => {
    enrichmentAttribution.mockResolvedValue({
      attributions: [
        { matchKey: 'match-1', stage: { sourcePageUrl: 'https://liquipedia.net/smash/Page_One' } },
        { matchKey: 'match-2', vod: { sourcePageUrl: 'https://liquipedia.net/smash/Page_Two' } },
      ],
    });

    const { result } = renderHook(() => useEnrichmentAttribution(['match-2', 'match-1']), {
      wrapper: ({ children }) => <Wrapper queryClient={newQueryClient()}>{children}</Wrapper>,
    });

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2));

    expect(enrichmentAttribution).toHaveBeenCalledTimes(1);
    expect(enrichmentAttribution).toHaveBeenCalledWith(['match-1', 'match-2']);
    expect(result.current['match-1']?.stage?.sourcePageUrl).toBe(
      'https://liquipedia.net/smash/Page_One',
    );
    expect(result.current['match-2']?.vod?.sourcePageUrl).toBe(
      'https://liquipedia.net/smash/Page_Two',
    );
  });

  // 30.2 gap-closure BLOCKER 2: the hook hands back the two halves UNMERGED,
  // so a consumer cannot accidentally read a stage claim as a VOD one.
  it('keeps the stage and vod halves independent, including when only one is present', async () => {
    enrichmentAttribution.mockResolvedValue({
      attributions: [
        {
          matchKey: 'match-1',
          stage: { sourcePageUrl: 'https://liquipedia.net/smash/Bracket_Page' },
        },
        {
          matchKey: 'match-2',
          stage: { sourcePageUrl: 'https://liquipedia.net/smash/Bracket_Page' },
          vod: { sourcePageUrl: 'https://liquipedia.net/smash/Vod_Page' },
        },
      ],
    });

    const { result } = renderHook(() => useEnrichmentAttribution(['match-1', 'match-2']), {
      wrapper: ({ children }) => <Wrapper queryClient={newQueryClient()}>{children}</Wrapper>,
    });

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2));

    expect(result.current['match-1']?.vod).toBeUndefined();
    expect(result.current['match-2']?.vod?.sourcePageUrl).toBe(
      'https://liquipedia.net/smash/Vod_Page',
    );
    expect(result.current['match-2']?.stage?.sourcePageUrl).toBe(
      'https://liquipedia.net/smash/Bracket_Page',
    );
  });

  it('deduplicates repeated keys before requesting', async () => {
    enrichmentAttribution.mockResolvedValue({ attributions: [] });

    renderHook(() => useEnrichmentAttribution(['match-1', 'match-1', 'match-1']), {
      wrapper: ({ children }) => <Wrapper queryClient={newQueryClient()}>{children}</Wrapper>,
    });

    await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
    expect(enrichmentAttribution).toHaveBeenCalledWith(['match-1']);
  });

  it('batches requests under the route cap', async () => {
    enrichmentAttribution.mockResolvedValue({ attributions: [] });
    const manyKeys = Array.from(
      { length: ENRICHMENT_ATTRIBUTION_MAX_KEYS_PER_REQUEST + 5 },
      (_, i) => `match-${String(i).padStart(4, '0')}`,
    );

    renderHook(() => useEnrichmentAttribution(manyKeys), {
      wrapper: ({ children }) => <Wrapper queryClient={newQueryClient()}>{children}</Wrapper>,
    });

    await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalledTimes(2));
    const firstCallSize = (enrichmentAttribution.mock.calls[0]?.[0] as string[]).length;
    const secondCallSize = (enrichmentAttribution.mock.calls[1]?.[0] as string[]).length;
    expect(firstCallSize).toBe(ENRICHMENT_ATTRIBUTION_MAX_KEYS_PER_REQUEST);
    expect(secondCallSize).toBe(5);
  });

  it('returns an empty map rather than throwing when the route is unavailable', async () => {
    enrichmentAttribution.mockRejectedValue(new Error('route unavailable'));

    const { result } = renderHook(() => useEnrichmentAttribution(['match-1']), {
      wrapper: ({ children }) => <Wrapper queryClient={newQueryClient()}>{children}</Wrapper>,
    });

    await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
    expect(result.current).toEqual({});
  });

  it('issues no request for an empty key list', () => {
    renderHook(() => useEnrichmentAttribution([]), {
      wrapper: ({ children }) => <Wrapper queryClient={newQueryClient()}>{children}</Wrapper>,
    });

    expect(enrichmentAttribution).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useResearchSubject } from './useResearchSubject';

const kind = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    coaching: {
      clients: {
        kind: (...args: unknown[]) => kind(...args),
      },
    },
  },
}));

/**
 * Builds a `renderHook` wrapper that composes a caller-supplied `QueryClient`
 * (so tests can assert call counts against the mocked `api.coaching.clients.
 * kind`) with a `MemoryRouter` positioned at `path` — `useResearchSubject`
 * derives its tenant id from the route via `useEffectiveSubject`, so every
 * behavior here must be exercised through an actual matched route, not a
 * mocked hook return.
 */
function makeWrapper(queryClient: QueryClient, path: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/coach/:clientId/*" element={<>{children}</>} />
            <Route path="/workspace/:tenantId/*" element={<>{children}</>} />
            <Route path="*" element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useResearchSubject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('outside a client workspace route: reports not-research/not-pending/not-error and issues no request', () => {
    const { result } = renderHook(() => useResearchSubject(), {
      wrapper: makeWrapper(newQueryClient(), '/dashboard'),
    });

    expect(result.current).toMatchObject({ isResearch: false, isPending: false, isError: false });
    expect(kind).not.toHaveBeenCalled();
  });

  it('inside /coach/:clientId, issues exactly one request for that tenant kind', async () => {
    kind.mockResolvedValue({ kind: 'ordinary' });
    const { result } = renderHook(() => useResearchSubject(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(kind).toHaveBeenCalledTimes(1);
    expect(kind).toHaveBeenCalledWith('tetra');
  });

  it('reports pending while the request is in flight', async () => {
    let resolveRequest: (value: { kind: string }) => void = () => {};
    kind.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const { result } = renderHook(() => useResearchSubject(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    expect(result.current).toMatchObject({ isPending: true, isResearch: false, isError: false });

    resolveRequest({ kind: 'ordinary' });
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it('reports research for the research resolution', async () => {
    kind.mockResolvedValue({ kind: 'research' });
    const { result } = renderHook(() => useResearchSubject(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isResearch).toBe(true));
    expect(result.current).toMatchObject({ isPending: false, isError: false });
  });

  it('reports not-research for the ordinary resolution', async () => {
    kind.mockResolvedValue({ kind: 'ordinary' });
    const { result } = renderHook(() => useResearchSubject(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current).toMatchObject({ isResearch: false, isError: false });
  });

  it('answers correctly for an ARCHIVED research tenant — the per-tenant endpoint is authoritative regardless of archived status', async () => {
    // The hub listing (`useCoachingClients`) excludes archived tenants by
    // default and cannot answer here; this hook's source is the per-tenant
    // endpoint, which does answer for an archived tenant. The mock's return
    // value stands in for that endpoint answering `'research'` for an
    // archived research tenant — this hook has no branch that could ever
    // special-case "archived" differently from any other research tenant,
    // which is exactly the point: it never reads archival state at all.
    kind.mockResolvedValue({ kind: 'research' });
    const { result } = renderHook(() => useResearchSubject(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/archived-tenant/overview'),
    });

    await waitFor(() => expect(result.current.isResearch).toBe(true));
  });

  it('a failed request reports error — not pending, not not-research — and retry re-issues the request', async () => {
    kind.mockRejectedValueOnce(new Error('network error'));
    const { result } = renderHook(() => useResearchSubject(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current).toMatchObject({ isPending: false, isResearch: false });
    expect(kind).toHaveBeenCalledTimes(1);

    kind.mockResolvedValueOnce({ kind: 'ordinary' });
    result.current.retry();

    await waitFor(() => expect(kind).toHaveBeenCalledTimes(2));
  });

  it('resolves on the /workspace/:tenantId family as well as /coach/:clientId', async () => {
    kind.mockResolvedValue({ kind: 'ordinary' });
    const { result } = renderHook(() => useResearchSubject(), {
      wrapper: makeWrapper(newQueryClient(), '/workspace/owned-tenant/overview'),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(kind).toHaveBeenCalledWith('owned-tenant');
  });

  it('returns a value whose identity is stable across renders when state has not changed', async () => {
    kind.mockResolvedValue({ kind: 'ordinary' });
    const { result, rerender } = renderHook(() => useResearchSubject(), {
      wrapper: makeWrapper(newQueryClient(), '/coach/tetra/overview'),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTierOverride } from './useTierOverride';
import { tournamentEntriesQueryKey } from './useTournamentEntries';

const setTierOverride = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    tournaments: {
      setTierOverride: (...args: unknown[]) => setTierOverride(...args),
      list: vi.fn(),
    },
  },
}));

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  const hook = renderHook(() => useTierOverride('entry-1'), { wrapper: Wrapper });
  return { ...hook, invalidateSpy };
}

describe('useTierOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the touched member for the entry it was created for', async () => {
    setTierOverride.mockResolvedValue({ entryKey: 'entry-1', tierOverride: null });
    const { result } = setup();

    await act(async () => {
      await result.current.mutateAsync({ tier: 'major' });
    });

    expect(setTierOverride).toHaveBeenCalledTimes(1);
    expect(setTierOverride).toHaveBeenCalledWith('entry-1', { tier: 'major' });
  });

  it('a clear passes null through', async () => {
    setTierOverride.mockResolvedValue({ entryKey: 'entry-1', tierOverride: null });
    const { result } = setup();

    await act(async () => {
      await result.current.mutateAsync(null);
    });

    expect(setTierOverride).toHaveBeenCalledWith('entry-1', null);
  });

  it('production-gap #9: the success path invalidates exactly the bare tournament-entries KEY, not merely "something"', async () => {
    setTierOverride.mockResolvedValue({ entryKey: 'entry-1', tierOverride: null });
    const { result, invalidateSpy } = setup();

    await act(async () => {
      await result.current.mutateAsync({ tier: 'minor' });
    });

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tournaments'] });
    // The key `useTournamentEntries` reads, not a subject-wrapped variant (D-17).
    expect(invalidateSpy.mock.calls[0]?.[0]).toEqual({ queryKey: tournamentEntriesQueryKey });
    expect([...tournamentEntriesQueryKey]).toEqual(['tournaments']);
  });

  it('a failed save invalidates nothing', async () => {
    setTierOverride.mockRejectedValue(new Error('boom'));
    const { result, invalidateSpy } = setup();

    await act(async () => {
      await expect(result.current.mutateAsync({ tier: 'local' })).rejects.toThrow('boom');
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

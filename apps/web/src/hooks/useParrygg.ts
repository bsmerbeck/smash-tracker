import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ParryggLinkRequest } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';

/** Link status for the signed-in user; refetches after link/unlink/verify/sync. */
export function useParryggStatus() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['parrygg', 'status'],
    queryFn: () => api.parrygg.status(),
    enabled: user != null,
  });
}

const SEARCH_DEBOUNCE_MS = 350;

/**
 * Debounces a fast-changing value (gamer-tag search input) so the search
 * query only fires `SEARCH_DEBOUNCE_MS` after the user stops typing.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Debounced parry.gg gamer-tag search — up to 10 candidates, empty when `tag` is blank. */
export function useParryggSearch(tag: string) {
  const { user } = useAuth();
  const debouncedTag = useDebouncedValue(tag.trim(), SEARCH_DEBOUNCE_MS);
  return useQuery({
    queryKey: ['parrygg', 'search', debouncedTag],
    queryFn: () => api.parrygg.search(debouncedTag),
    enabled: user != null && debouncedTag.length > 0,
  });
}

/** Links a chosen parry.gg candidate to the signed-in account. */
export function useParryggLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ParryggLinkRequest) => api.parrygg.link(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['parrygg', 'status'] });
    },
  });
}

export function useParryggUnlink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.parrygg.unlink(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['parrygg', 'status'] });
    },
  });
}

/** Starts (or resumes, if unexpired) bio-text verification — returns the `ST-XXXXXX` code to paste into the bio. */
export function useParryggVerifyStart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.parrygg.verifyStart(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['parrygg', 'status'] });
    },
  });
}

/** Checks the linked parry.gg bio for the pending verification code. */
export function useParryggVerifyComplete() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.parrygg.verifyComplete(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['parrygg', 'status'] });
    },
  });
}

/** Runs a match sync; imported matches/opponents invalidate immediately. */
export function useParryggSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.parrygg.sync(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['matches'] }),
        queryClient.invalidateQueries({ queryKey: ['opponents'] }),
        queryClient.invalidateQueries({ queryKey: ['parrygg', 'status'] }),
      ]);
    },
  });
}

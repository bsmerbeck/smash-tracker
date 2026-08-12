import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { ResearchEnrichmentAttributionEntry } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

/**
 * Phase 30.2 Plan 11 (ENR-09): mirrors `USERS_ENRICHMENT_ATTRIBUTION_MAX_KEYS`
 * (`apps/api/src/routes/users.ts`) — duplicated locally because the web
 * package cannot import an API-only constant across the package boundary.
 */
export const ENRICHMENT_ATTRIBUTION_MAX_KEYS_PER_REQUEST = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function enrichmentAttributionQueryKey(keys: string[]) {
  return ['enrichment-attribution', ...keys] as const;
}

/**
 * The ONE browser-side source of truth for per-match Liquipedia attribution,
 * consumed by every surface `30.2-PATTERNS.md` section 4 names (the match
 * table, the attach-VOD dialog, the edit form, the VOD manager). Deliberately
 * does NOT read provenance off the match row — the witness lives OFF the
 * match record (`researchEnrichmentProjection/{tenantId}/{matchKey}`), so
 * this hook is the only way a component can learn whether a value came from
 * Liquipedia.
 *
 * Requests only the match keys it is given (deduplicated, sorted for a
 * stable query key), batched under `ENRICHMENT_ATTRIBUTION_MAX_KEYS_PER_REQUEST`
 * per request via `GET /api/users/me/enrichment/attribution`. A request
 * failure (the route unavailable, a network error) leaves the corresponding
 * keys simply absent from the returned map — this hook never throws into a
 * render, mirroring `useSelfDataCoverage`'s degrade posture: reading
 * `query.data` (never `query.error`) means a failed chunk contributes
 * nothing rather than surfacing an error state to the caller.
 *
 * Folds the per-chunk results via `useQueries`' own `combine` option rather
 * than a hand-rolled `useMemo` over `queries.map(q => q.data)`: the number
 * of chunks (and therefore the length of that mapped array) varies with
 * `matchKeys.length` across renders — zero chunks while `matchKeys` is
 * empty, growing as it fills in — and React's `useMemo` dependency-array
 * comparison assumes a STABLE deps length across renders (its documented
 * contract). A deps array whose length changes silently breaks the
 * comparison and can freeze the memo at a stale value forever. `combine` is
 * `useQueries`' own built-in fold step, invoked by the library itself on
 * every relevant data change regardless of how many queries are in flight,
 * so it has no such length-stability assumption to violate.
 */
export function useEnrichmentAttribution(
  matchKeys: string[],
): Record<string, ResearchEnrichmentAttributionEntry> {
  const { user } = useAuth();
  const enabled = user != null;

  const sortedKeys = useMemo(() => [...new Set(matchKeys)].sort(), [matchKeys]);
  const chunks = useMemo(
    () => chunk(sortedKeys, ENRICHMENT_ATTRIBUTION_MAX_KEYS_PER_REQUEST),
    [sortedKeys],
  );

  return useQueries({
    queries: chunks.map((chunkKeys) => ({
      queryKey: enrichmentAttributionQueryKey(chunkKeys),
      queryFn: () => api.users.enrichmentAttribution(chunkKeys),
      enabled: enabled && chunkKeys.length > 0,
      retry: false,
    })),
    combine: (results) => {
      const map: Record<string, ResearchEnrichmentAttributionEntry> = {};
      for (const result of results) {
        for (const entry of result.data?.attributions ?? []) {
          map[entry.matchKey] = entry;
        }
      }
      return map;
    },
  });
}

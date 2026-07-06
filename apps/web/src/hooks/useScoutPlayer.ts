import { useMutation } from '@tanstack/react-query';
import type { ScoutSource } from '@smash-tracker/shared';
import { api } from '@/lib/api';

export interface ScoutPlayerInput {
  query: string;
  /** V9-B Feature 4: which site to resolve a bare tag/slug/id against; a pasted parry.gg profile URL auto-detects server-side regardless of this. */
  source?: ScoutSource;
}

/**
 * POST /api/scout — runs on submit (not auto-fetched like the rest of the
 * app's queries), since it's a user-initiated lookup of a third-party
 * player's public tournament-site history rather than data tied to the
 * signed-in account. A `useMutation` gives the Scout page
 * `isPending`/`error`/`data` without needing a query key (there's no cache
 * to invalidate elsewhere — the server already caches per player id/source,
 * see startgg/scout.ts and parrygg/scout.ts).
 */
export function useScoutPlayer() {
  return useMutation({
    mutationFn: (input: ScoutPlayerInput) => api.scout.lookup(input),
  });
}

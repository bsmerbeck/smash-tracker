import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * POST /api/scout — runs on submit (not auto-fetched like the rest of the
 * app's queries), since it's a user-initiated lookup of a third-party
 * player's public start.gg history rather than data tied to the signed-in
 * account. A `useMutation` gives the Scout page `isPending`/`error`/`data`
 * without needing a query key (there's no cache to invalidate elsewhere —
 * the server already caches per player id, see startgg/scout.ts).
 */
export function useScoutPlayer() {
  return useMutation({
    mutationFn: (query: string) => api.scout.lookup({ query }),
  });
}

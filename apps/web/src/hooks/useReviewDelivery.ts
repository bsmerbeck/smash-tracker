import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Phase 12 Plan 08 (DLV-02/DLV-04): query/mutation hooks for the anonymous
 * `/r/:token` recipient page — a SIBLING to `useVodShares.ts`'s
 * `usePublicVodShare` (same unauthenticated-read shape, different route
 * family: `/api/review-deliveries/:token`). Deliberately NOT added to
 * `useCoachingReviews.ts`: that file's hooks are all scoped to the
 * SIGNED-IN coach's own reviews (`Boolean(user)` gates throughout); this
 * page has no account at all.
 */
export function reviewDeliveryQueryKey(token: string) {
  return ['review-delivery', token] as const;
}

/**
 * GET /api/review-deliveries/:token — the pinned published-version
 * snapshot. No `enabled: Boolean(user)` gate (mirrors `usePublicVodShare`):
 * a public read for a no-account visitor. Deliberately NO `retry: false`
 * override either, for the identical reason `usePublicVodShare` documents —
 * the app-wide default predicate already never retries a 4xx (a revoked/
 * unknown/expired token's identical no-oracle 404 fails immediately), while
 * a network blip on a healthy token keeps the normal retry budget instead of
 * telling a real recipient the review is gone.
 */
export function useReviewDeliveryPublic(token: string) {
  return useQuery({
    queryKey: reviewDeliveryQueryKey(token),
    queryFn: () => api.reviewDeliveries.get(token),
  });
}

/**
 * POST /api/review-deliveries/:token/ack — idempotent link acknowledgement
 * (D-09). The server response carries no `ackAt`/timestamp (`{ acknowledged:
 * true }` only) and the anonymous GET snapshot never echoes delivery status
 * back either (T-12-25: the page consumes ONLY the plan-05 published-version
 * snapshot, which has no delivery-state fields to leak) — the caller
 * (`ReviewDeliveryPage`) is responsible for persisting the "acknowledged"
 * confirmation across a reload itself (see that component's doc comment).
 */
export function useAcknowledgeReviewDelivery(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.reviewDeliveries.ack(token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: reviewDeliveryQueryKey(token) });
    },
  });
}

/**
 * POST /api/review-deliveries/:token/viewed — the crawler-safe Delivered ->
 * Viewed transition (D-09/D-11, plan 08's own Rule 2 gap-fill route). A
 * plain fire-and-forget mutation, exactly like `postCanonicalEvent`'s own
 * swallow-everything contract: `ReviewDeliveryPage` calls `.mutate()` with
 * no success/error handling — a failed call here must never surface to the
 * recipient or block rendering, mirroring `share_view_loaded`'s posture.
 */
export function useMarkReviewDeliveryViewed(token: string) {
  return useMutation({
    mutationFn: () => api.reviewDeliveries.markViewed(token),
  });
}

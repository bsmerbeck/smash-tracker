import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreditPackId } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const creditsQueryKey = ['billing', 'credits'] as const;

/**
 * GET /api/billing/credits — V7-C: the signed-in user's billing status
 * (whether they're on the free allowlist, their credit balance, and the
 * purchasable packs). Short `staleTime` (unlike `useReportsConfig`) because
 * the balance changes with usage and purchases within a session — the Scout
 * page also polls this after a Stripe Checkout redirect back (webhook
 * delivery can lag the redirect).
 */
export function useCredits() {
  const { user } = useAuth();
  return useQuery({
    queryKey: creditsQueryKey,
    queryFn: () => api.billing.credits(),
    enabled: Boolean(user),
    staleTime: 30 * 1000,
  });
}

/**
 * POST /api/billing/checkout — creates a Stripe Checkout Session for a pack
 * and redirects the browser to Stripe's hosted page on success. This is a
 * full-page navigation (not an XHR-driven UI update), matching the
 * start.gg OAuth connect flow elsewhere in the app.
 */
export function useCheckout() {
  return useMutation({
    mutationFn: (packId: CreditPackId) => api.billing.checkout(packId),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
}

/** Invalidates the credits query — call after a purchase return-trip to refetch the balance. */
export function useInvalidateCredits() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: creditsQueryKey });
}

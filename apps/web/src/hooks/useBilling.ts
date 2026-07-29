import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CheckoutReturnTo, CreditPackId } from '@smash-tracker/shared';
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
 *
 * `returnTo` (Phase 27, EVT-05) is an OPTIONAL argument specifically so the
 * existing `useCheckout()` (no-argument) Scout call site needs ZERO
 * changes — omitting it sends today's exact request body. The destination
 * is validated and resolved SERVER-side (`apps/api/src/routes/billing.ts`,
 * 27-05); this value is a hint, never a redirect target the client
 * constructs itself.
 */
export function useCheckout(options?: { returnTo: CheckoutReturnTo; entryKey?: string }) {
  return useMutation({
    // Deliberately a conditional call (not `api.billing.checkout(packId,
    // options)` with `options` always passed, even as `undefined`) so the
    // no-argument call site invokes `api.billing.checkout` with exactly ONE
    // argument, byte-identical to today's call — an explicit `undefined`
    // second argument is still an observably different call shape.
    mutationFn: (packId: CreditPackId) =>
      options ? api.billing.checkout(packId, options) : api.billing.checkout(packId),
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

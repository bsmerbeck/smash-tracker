import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useCredits } from '@/hooks/useBilling';

/**
 * How many times to re-poll `useCredits` after a successful checkout return
 * (webhook delivery can lag the redirect) — the same attempt count and
 * interval `usePrepPaidCheckoutReturn.ts` uses (duplicated rather than
 * imported since that module does not export them, mirroring its own
 * precedent for `ScoutPage.tsx`'s constants).
 */
const POST_EVENT_PAID_CREDITS_POLL_ATTEMPTS = 5;
const POST_EVENT_PAID_CREDITS_POLL_INTERVAL_MS = 2000;

/**
 * Reads the Stripe Checkout `?billing=success|cancelled` return outcome and
 * announces it (toast + a short credits re-poll on success), then strips the
 * query parameter — the exact `usePrepPaidCheckoutReturn.ts` pattern,
 * applied to the `postEventPaid.*` namespace.
 *
 * Placement decision (deliberate — read this before moving this hook, same
 * reasoning `usePrepPaidCheckoutReturn.ts` documents): 28-UI-SPEC.md
 * describes this handling as living wherever the `billing` query param
 * lands for a review-origin purchase (`PrepBriefPage.tsx`, since the SAME
 * URL hosts both prep and review mode, 28-CONTEXT.md). But `PrepBriefPage.tsx`
 * is inside `prepStructuralIntegrity.test.ts`'s scanned surface, and the
 * cancelled-outcome copy key (`postEventPaid.billing.checkoutCancelled`)
 * resolves to a string containing "Checkout" — monetization vocabulary the
 * structural gate forbids on the always-rendered free surface. Hosting the
 * handler here instead — inside the gated `postEventPaid/` directory,
 * called from the one card that only mounts when the server reports
 * `paidReportsAvailable === true` — keeps `PrepBriefPage.tsx` byte-clean AND
 * satisfies the Structural Absence Contract more strictly than a
 * route-level handler would: with the gate off, no return-handling code
 * runs at ALL (not even a silent early-return). The `billing` query
 * parameter itself is exposed to any descendant via the router regardless
 * of which component reads it, so this component reads the exact same
 * value `PrepBriefPage.tsx` would have.
 */
export function usePostEventCheckoutReturn(): void {
  const { t } = useTranslation();
  const credits = useCredits();
  const [searchParams, setSearchParams] = useSearchParams();
  const announcedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // IN-02 (Phase 28 review): unmount-only cleanup for the credits re-poll.
  // Deliberately a SEPARATE empty-deps effect — the announce effect below
  // re-runs when the params change (its own strip triggers exactly that),
  // so a cleanup returned from it would kill the poll after zero ticks.
  useEffect(() => {
    return () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const outcome = searchParams.get('billing');
    if (!outcome || announcedRef.current) {
      return;
    }
    announcedRef.current = true;
    if (outcome === 'success') {
      toast.success(t('postEventPaid.billing.paymentReceived'));
      let attempts = 0;
      pollRef.current = setInterval(() => {
        attempts += 1;
        void credits.refetch();
        if (attempts >= POST_EVENT_PAID_CREDITS_POLL_ATTEMPTS && pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, POST_EVENT_PAID_CREDITS_POLL_INTERVAL_MS);
    } else if (outcome === 'cancelled') {
      toast(t('postEventPaid.billing.checkoutCancelled'));
    }
    // IN-02: delete ONLY the `billing` key — `setSearchParams({})` wiped
    // every other query parameter on the URL.
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('billing');
    setSearchParams(nextParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- credits.refetch is stable per render but not a dep we want to re-trigger this effect on
  }, [searchParams, setSearchParams]);
}

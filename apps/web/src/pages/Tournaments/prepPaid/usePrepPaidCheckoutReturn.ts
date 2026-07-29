import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useCredits } from '@/hooks/useBilling';

/**
 * How many times to re-poll `useCredits` after a successful checkout return
 * (webhook delivery can lag the redirect) — the same attempt count and
 * interval `ScoutPage.tsx` uses (`CREDITS_POLL_ATTEMPTS`/
 * `CREDITS_POLL_INTERVAL_MS`), duplicated here rather than imported since
 * `ScoutPage.tsx` does not export them.
 */
const PREP_PAID_CREDITS_POLL_ATTEMPTS = 5;
const PREP_PAID_CREDITS_POLL_INTERVAL_MS = 2000;

/**
 * Reads the Stripe Checkout `?billing=success|cancelled` return outcome and
 * announces it (toast + a short credits re-poll on success), then strips the
 * query parameter — the exact pattern `ScoutPage.tsx` already uses for its
 * own `/scout` return trip (ScoutPage.tsx:141-162).
 *
 * Placement decision (deliberate — read this before moving this hook):
 * 27-UI-SPEC.md describes this handling as living at the ROUTE level
 * (`PrepBriefPage.tsx`, since that is where the `billing` query param lands
 * for a prep-origin purchase). But `PrepBriefPage.tsx` is inside
 * `prepStructuralIntegrity.test.ts`'s scanned surface (RPT-04), and the
 * cancelled-outcome copy key (`prepPaid.billing.checkoutCancelled`) resolves
 * to a string containing "checkout" — a word `MONETIZATION_VOCABULARY`
 * treats as monetization vocabulary. Hosting the handler here instead —
 * inside the gated `prepPaid/` directory, called from the one card that
 * only mounts when the server reports `paidReportsAvailable === true` —
 * keeps `PrepBriefPage.tsx` byte-clean under the existing gate AND satisfies
 * the structural-absence contract more strictly than a route-level handler
 * would: with the gate off, no return-handling code runs at ALL (not even a
 * silent early-return), rather than a handler that exists on the page but
 * happens not to do anything paid-specific. The `billing` query parameter
 * itself is exposed to any descendant via the router regardless of which
 * component reads it, so this component reads the exact same value
 * `PrepBriefPage.tsx` would have.
 */
export function usePrepPaidCheckoutReturn(): void {
  const { t } = useTranslation();
  const credits = useCredits();
  const [searchParams, setSearchParams] = useSearchParams();
  const announcedRef = useRef(false);

  useEffect(() => {
    const outcome = searchParams.get('billing');
    if (!outcome || announcedRef.current) {
      return;
    }
    announcedRef.current = true;
    if (outcome === 'success') {
      toast.success(t('prepPaid.billing.paymentReceived'));
      let attempts = 0;
      const poll = setInterval(() => {
        attempts += 1;
        void credits.refetch();
        if (attempts >= PREP_PAID_CREDITS_POLL_ATTEMPTS) {
          clearInterval(poll);
        }
      }, PREP_PAID_CREDITS_POLL_INTERVAL_MS);
    } else if (outcome === 'cancelled') {
      toast(t('prepPaid.billing.checkoutCancelled'));
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- credits.refetch is stable per render but not a dep we want to re-trigger this effect on
  }, [searchParams, setSearchParams]);
}

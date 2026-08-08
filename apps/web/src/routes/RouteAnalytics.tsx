import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useResearchSubject } from '@/hooks/useResearchSubject';
import { logAnalyticsPageView } from '@/lib/firebase';

/**
 * App-wide GA4 page_view reporter, mounted once inside the router.
 *
 * GA4 auto-collection is disabled (`send_page_view: false` in lib/firebase.ts)
 * and SPA navigations never auto-report, so this effect is the single source
 * of page_view events: initial mount + every route change, for EVERY route.
 * It used to live in MainLayout, which meant only authenticated pages were
 * counted — anonymous visitors on `/`, `/faq`, and `/gsp-calculator` (the
 * V12 SEO surface, i.e. all acquisition traffic) were invisible and GA
 * Realtime showed 0 despite real visits.
 *
 * Phase 29 (RTEN-04, D-06, review finding 29-08 HIGH): the page-view call is
 * skipped for a research workspace, and fail-closed while the kind lookup
 * is pending or errored — mirrors `ResearchTelemetrySuppression`'s own
 * fail-closed disposition. This gate is deliberately REDUNDANT with
 * `lib/firebase.ts`'s global collection flag (which
 * `ResearchTelemetrySuppression` drives from the SAME `useResearchSubject`
 * signal): the flag handles SDK auto-collection and the already-initialized
 * case; this call-site gate makes the suppression legible right at the
 * page-view call and additionally protects a window where the flag hasn't
 * yet been flipped this render. Do not remove either as "dead code" — they
 * cover different failure modes.
 */
export function RouteAnalytics() {
  const location = useLocation();
  const { isResearch, isPending, isError } = useResearchSubject();
  useEffect(() => {
    // The kind state joins `location.pathname` in this dependency list
    // deliberately (review finding 29-08 HIGH): with a pathname-only
    // dependency list, landing on a coaching workspace while the kind is
    // still pending would skip its page view here and never re-run once
    // the kind resolves (the effect only re-fires on a pathname change) —
    // silently losing a legitimate report. Keying on the kind state too
    // lets a pending->coaching resolution at an UNCHANGED path re-evaluate
    // and fire exactly once, the moment it resolves.
    if (isResearch || isPending || isError) return;
    logAnalyticsPageView(location.pathname);
  }, [location.pathname, isResearch, isPending, isError]);
  return null;
}

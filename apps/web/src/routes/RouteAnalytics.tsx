import { useEffect } from 'react';
import { useLocation } from 'react-router';
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
 */
export function RouteAnalytics() {
  const location = useLocation();
  useEffect(() => {
    logAnalyticsPageView(location.pathname);
  }, [location.pathname]);
  return null;
}

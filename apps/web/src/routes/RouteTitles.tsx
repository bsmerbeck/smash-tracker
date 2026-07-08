import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { navItems } from '@/layouts/nav';

/**
 * Per-route document titles for the authenticated app, mounted once inside
 * the router. Before this, every authed page shared index.html's static
 * marketing title, so GA4's "Views by Page title" collapsed the whole app
 * into one row. Titles derive from the same `navItems` the sidebar renders
 * (they can't drift), plus explicit entries for routes that aren't in the
 * nav. RouteAnalytics reads `document.title` after effects flush, so the
 * page_view hit carries the per-route title.
 *
 * Public/SEO routes (`/`, `/faq`, `/gsp-calculator`, `/not-found`) are
 * deliberately NOT mapped here: they own richer titles via `useSeo`, and
 * this component leaves any path it doesn't recognize untouched. Plain
 * `document.title` assignment (not `useSeo`) so the static OG/twitter tags —
 * which only matter for the crawlable public pages — aren't rewritten with
 * app-chrome titles.
 */
const ROUTE_TITLES: ReadonlyArray<{ prefix: string; title: string }> = [
  ...navItems.map(({ href, title }) => ({ prefix: href, title })),
  { prefix: '/profile', title: 'Profile' },
  { prefix: '/tournaments/', title: 'Tournament' },
  { prefix: '/auth/startgg', title: 'Signing in with start.gg' },
];

export function titleForPath(pathname: string): string | null {
  const match = ROUTE_TITLES.find(
    ({ prefix }) =>
      pathname === prefix ||
      pathname.startsWith(`${prefix}/`) ||
      (prefix.endsWith('/') && pathname.startsWith(prefix)),
  );
  return match ? `${match.title} | Smash Tracker` : null;
}

export function RouteTitles() {
  const { pathname } = useLocation();
  useEffect(() => {
    const title = titleForPath(pathname);
    if (title !== null) {
      document.title = title;
    }
  }, [pathname]);
  return null;
}

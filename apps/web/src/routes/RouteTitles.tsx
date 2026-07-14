import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
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
 * V15: titles are i18n keys, translated at set-time (and re-set on language
 * change — `t` is in the effect deps).
 *
 * Public/SEO routes (`/`, `/faq`, `/gsp-calculator`, `/not-found`) are
 * deliberately NOT mapped here: they own richer titles via `useSeo`, and
 * this component leaves any path it doesn't recognize untouched. Plain
 * `document.title` assignment (not `useSeo`) so the static OG/twitter tags —
 * which only matter for the crawlable public pages — aren't rewritten with
 * app-chrome titles.
 */
const ROUTE_TITLE_KEYS: ReadonlyArray<{ prefix: string; titleKey: string }> = [
  ...navItems.map(({ href, titleKey }) => ({ prefix: href, titleKey })),
  { prefix: '/profile', titleKey: 'nav.profile' },
  { prefix: '/tournaments/', titleKey: 'nav.tournament' },
  { prefix: '/auth/startgg', titleKey: 'nav.signingInWithStartgg' },
];

/** The `nav.*` i18n key for a pathname, or null for unmapped (public/SEO) routes. */
export function titleKeyForPath(pathname: string): string | null {
  const match = ROUTE_TITLE_KEYS.find(
    ({ prefix }) =>
      pathname === prefix ||
      pathname.startsWith(`${prefix}/`) ||
      (prefix.endsWith('/') && pathname.startsWith(prefix)),
  );
  return match?.titleKey ?? null;
}

export function RouteTitles() {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  useEffect(() => {
    const titleKey = titleKeyForPath(pathname);
    if (titleKey !== null) {
      document.title = `${t(titleKey)} | grandfinals.gg`;
    }
  }, [pathname, t]);
  return null;
}

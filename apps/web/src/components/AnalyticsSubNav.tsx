import { NavLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * Plan 38-02 (D-03/Q11.7): the analytics sub-nav both `ClientAnalyticsLayout`
 * (coach family) and `OwnerAnalyticsLayout` (owned-workspace family) used to
 * hand-duplicate as two byte-similar nav arrays. Two forks that must stay in
 * sync can drift — adding a route to the shared `subjectAnalyticsRoutes`
 * list without adding it here would leave the destination reachable only by
 * a direct link, never by in-app navigation, in whichever family's fork got
 * missed. The item list lives here, once, so a route added to the shared
 * list needs one edit, not two.
 *
 * The accent class is the ONLY intentional visual difference between the two
 * families — the coach brand accent in one, the neutral primary accent in
 * the other — supplied by each host layout via `activeClassName`.
 */
interface AnalyticsSubNavItem {
  key: string;
  /** Leaf path segment appended to `base` — matches `subjectAnalyticsRoutes.tsx`. */
  segment: string;
  labelKey: string;
}

const ANALYTICS_SUB_NAV_ITEMS: AnalyticsSubNavItem[] = [
  { key: 'dashboard', segment: 'dashboard', labelKey: 'coaching.analyticsNav.dashboard' },
  {
    key: 'fighter-analysis',
    segment: 'fighter-analysis',
    labelKey: 'coaching.analyticsNav.fighterAnalysis',
  },
  { key: 'matchups', segment: 'matchups', labelKey: 'coaching.analyticsNav.matchups' },
  { key: 'opponents', segment: 'opponents', labelKey: 'coaching.analyticsNav.opponents' },
];

export interface AnalyticsSubNavProps {
  /** The family's base path, e.g. `/coach/tetra` or `/workspace/w1`. */
  base: string;
  /** The active-tab class pair the host family supplies (border + text color). */
  activeClassName: string;
}

export function AnalyticsSubNav({ base, activeClassName }: AnalyticsSubNavProps) {
  const { t } = useTranslation();

  return (
    <nav className="flex gap-1 border-b">
      {ANALYTICS_SUB_NAV_ITEMS.map((item) => (
        <NavLink
          key={item.key}
          to={`${base}/${item.segment}`}
          className={({ isActive }) =>
            cn(
              'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? activeClassName
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )
          }
        >
          {t(item.labelKey)}
        </NavLink>
      ))}
    </nav>
  );
}

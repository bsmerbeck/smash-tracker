import { NavLink, Outlet, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01): the owned
 * workspace's Analytics sub-nav — a small secondary nav (Dashboard / Fighter
 * Analysis / Matchups) above an `<Outlet />` for whichever of those EXACT
 * SAME shared leaf components matched. Fork of the coach-side analytics
 * layout: same three-item shape, base path swapped to `/workspace/:tenantId`,
 * and neutral active-tab styling (no coach-brand accent color) — this
 * surface belongs to the owner, not a coach.
 */
export function OwnerAnalyticsLayout() {
  const { t } = useTranslation();
  const { tenantId = '' } = useParams<{ tenantId: string }>();
  const base = `/workspace/${tenantId}`;
  const items = [
    { key: 'dashboard', href: `${base}/dashboard`, label: t('coaching.analyticsNav.dashboard') },
    {
      key: 'fighter-analysis',
      href: `${base}/fighter-analysis`,
      label: t('coaching.analyticsNav.fighterAnalysis'),
    },
    { key: 'matchups', href: `${base}/matchups`, label: t('coaching.analyticsNav.matchups') },
  ];

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b">
        {items.map((item) => (
          <NavLink
            key={item.key}
            to={item.href}
            className={({ isActive }) =>
              cn(
                'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

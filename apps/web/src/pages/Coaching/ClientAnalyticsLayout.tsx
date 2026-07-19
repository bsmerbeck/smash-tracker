import { NavLink, Outlet, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * Phase 11 fix round 2 (D-03/D3): the "one Analytics sidebar item, grouped
 * surface" — a small secondary sub-nav (Dashboard / Fighter Analysis /
 * Matchups) rendered above an `<Outlet />` for whichever of those three
 * EXACT SAME personal-route components (imported unchanged, PAR-01/02/03)
 * matched. `useParams` reads `clientId` directly (rather than
 * `useActiveSubject`) since this layout only ever renders inside
 * `/coach/:clientId/*`.
 */
export function ClientAnalyticsLayout() {
  const { t } = useTranslation();
  const { clientId = '' } = useParams<{ clientId: string }>();
  const base = `/coach/${clientId}`;
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
                  ? 'border-coaching-accent text-coaching-accent'
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

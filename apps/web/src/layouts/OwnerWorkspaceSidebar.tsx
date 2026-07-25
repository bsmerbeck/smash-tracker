import { NavLink, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useClientWorkspaces } from '@/hooks/useClientWorkspaces';

interface OwnerWorkspaceNavItem {
  key: 'overview' | 'fighters' | 'matches' | 'vods' | 'analytics';
  href: string;
  isActive: (pathname: string) => boolean;
}

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01): the five
 * owned-workspace nav items — items resolve to '/workspace/{tenantId}/...'
 * routes, a deliberately smaller set than this file's neighboring
 * client-workspace rail's own item list, matching this route family's
 * registered pages only (v2.4 scope).
 */
function buildOwnerWorkspaceItems(tenantId: string): OwnerWorkspaceNavItem[] {
  const base = `/workspace/${tenantId}`;
  return [
    { key: 'overview', href: `${base}/overview`, isActive: (p) => p === `${base}/overview` },
    { key: 'fighters', href: `${base}/fighters`, isActive: (p) => p === `${base}/fighters` },
    {
      key: 'matches',
      href: `${base}/match-data`,
      isActive: (p) => p === `${base}/match-data`,
    },
    { key: 'vods', href: `${base}/vods`, isActive: (p) => p === `${base}/vods` },
    {
      key: 'analytics',
      href: `${base}/dashboard`,
      isActive: (p) =>
        p === `${base}/dashboard` || p === `${base}/fighter-analysis` || p === `${base}/matchups`,
    },
  ];
}

/**
 * Owned-workspace rail (Phase 24, CTRL-01): rendered at
 * `/workspace/:tenantId/*` — a back link to `/dashboard`, a header card with
 * the workspace label, then the five nav items above. A deliberate visual
 * sibling of this file's neighboring client-workspace rail — forked for its
 * shape, never imported or extended — because the neighbor reads the
 * coach's own managed-client listing, which is legitimately empty for a
 * client who owns a workspace themselves. Backed instead by the signed-in
 * user's own owned-workspace listing. Neutral active-item styling, with no
 * accent-color coach-mode styling. This is a navigation affordance only:
 * every request against the destination route is re-authorized
 * server-side against the membership record, so the rail grants no access
 * by itself.
 */
export function OwnerWorkspaceSidebar({
  tenantId,
  onNavigate,
}: {
  tenantId: string;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const workspaces = useClientWorkspaces();
  const workspaceLabel =
    workspaces.data?.find((workspace) => workspace.tenantId === tenantId)?.label ?? tenantId;
  const items = buildOwnerWorkspaceItems(tenantId);

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <NavLink
        to="/dashboard"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4 shrink-0" />
        {t('ownerWorkspace.chrome.backToPersonal')}
      </NavLink>

      <div className="rounded-md border border-muted-foreground/30 bg-muted px-3 py-2">
        <p className="truncate text-sm font-semibold">{workspaceLabel}</p>
        <p className="text-xs text-muted-foreground">{t('ownerWorkspace.chrome.ownedCaption')}</p>
      </div>

      <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t('ownerWorkspace.chrome.sectionYourWorkspace')}
      </p>

      <nav className="flex flex-col gap-1 py-0.5" aria-label={t('chrome.mainNavigation')}>
        {items.map((item) => {
          const active = item.isActive(location.pathname);
          return (
            <NavLink
              key={item.key}
              to={item.href}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {t(`ownerWorkspace.chrome.${item.key}`)}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}

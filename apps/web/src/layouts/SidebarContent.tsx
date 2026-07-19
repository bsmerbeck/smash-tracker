import { NavLink, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useActiveSubject } from '@/hooks/useActiveSubject';
import { useCoachingClients } from '@/hooks/useCoachingClients';
import { navItems } from './nav';
import ssbuTrainingGroundsLogo from '@/assets/SSBU_TG-03.png';

function initialFromEmail(email: string | null | undefined): string {
  return email ? email.charAt(0).toUpperCase() : '?';
}

interface WorkspaceNavItem {
  key: 'overview' | 'fighters' | 'matchesAndVods' | 'analytics';
  href: string;
  isActive: (pathname: string) => boolean;
}

/**
 * Phase 11 fix round 2 (D-03/D3): the exactly-four client-workspace items.
 * Every item but Analytics matches its own path 1:1; Analytics also covers
 * the client-scoped fighter-analysis/matchups sub-routes, so its active
 * state is computed here rather than relying on `NavLink`'s own `to` match.
 */
function buildWorkspaceItems(clientId: string): WorkspaceNavItem[] {
  const base = `/coach/${clientId}`;
  return [
    { key: 'overview', href: `${base}/overview`, isActive: (p) => p === `${base}/overview` },
    { key: 'fighters', href: `${base}/fighters`, isActive: (p) => p === `${base}/fighters` },
    { key: 'matchesAndVods', href: `${base}/vods`, isActive: (p) => p === `${base}/vods` },
    {
      key: 'analytics',
      href: `${base}/dashboard`,
      isActive: (p) =>
        p === `${base}/dashboard` || p === `${base}/fighter-analysis` || p === `${base}/matchups`,
    },
  ];
}

/**
 * Coaching-hub rail (Phase 11 fix round 2, D-01/D1): rendered at `/coach`
 * itself (no client selected yet) — a minimal nav distinct from both the
 * personal rail and the client-workspace rail, matching the mockup's
 * `#side-hub` block. Zero personal `navItems` render here (PAR-04/TEN-05).
 */
function CoachingHubSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col gap-1 p-4">
      <p className="px-3 pt-1 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t('coaching.sidebar.sectionCoaching')}
      </p>
      <NavLink
        to="/coach"
        end
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
            isActive
              ? 'bg-coaching-accent/10 text-coaching-accent'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )
        }
      >
        {t('coaching.sidebar.allClients')}
      </NavLink>

      <p className="px-3 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t('coaching.sidebar.sectionYou')}
      </p>
      <NavLink
        to="/dashboard"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <ArrowLeft className="size-4 shrink-0" />
        {t('coaching.sidebar.backToPersonal')}
      </NavLink>
    </div>
  );
}

/**
 * Client-workspace rail (Phase 11 fix round 2, D-01/D1, D-03/D3): rendered
 * at `/coach/:clientId/*` — a back link to the hub, an accent-tinted client
 * header card, then exactly the four D-03 workspace items. Personal
 * `navItems` never render here either (PAR-04/TEN-05).
 */
function ClientWorkspaceSidebar({
  clientId,
  onNavigate,
}: {
  clientId: string;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const clients = useCoachingClients();
  const clientLabel =
    clients.data?.find((client) => client.clientId === clientId)?.label ?? clientId;
  const workspaceItems = buildWorkspaceItems(clientId);

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <NavLink
        to="/coach"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4 shrink-0" />
        {t('coaching.sidebar.allClientsBack')}
      </NavLink>

      <div className="rounded-md border border-coaching-accent bg-coaching-accent/10 px-3 py-2">
        <p className="truncate text-sm font-semibold">{clientLabel}</p>
        <p className="text-xs text-coaching-accent">{t('coaching.sidebar.managedClient')}</p>
      </div>

      <nav className="flex flex-col gap-1 py-0.5" aria-label={t('chrome.mainNavigation')}>
        {workspaceItems.map((item) => {
          const active = item.isActive(location.pathname);
          return (
            <NavLink
              key={item.key}
              to={item.href}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-coaching-accent/10 text-coaching-accent'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {t(`coaching.sidebar.${item.key}`)}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * Personal rail — mirrors legacy's Sidebar > Profile + SidebarNav structure.
 * UNCHANGED by Phase 11 fix round 2 (D-06/D6): personal mode must look
 * byte-for-byte identical to before the coaching IA rework.
 */
function PersonalSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <NavLink
        to="/profile"
        onClick={onNavigate}
        aria-label={t('chrome.yourProfile')}
        className={({ isActive }) =>
          cn(
            'flex flex-col items-center gap-2 rounded-md py-2 transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
            isActive && 'bg-accent text-accent-foreground',
          )
        }
      >
        <Avatar className="size-14">
          <AvatarFallback className="text-lg">{initialFromEmail(user?.email)}</AvatarFallback>
        </Avatar>
        <p className="max-w-full truncate text-sm font-medium" title={user?.email ?? ''}>
          {user?.email ?? t('chrome.signedOut')}
        </p>
      </NavLink>

      <Separator />

      <nav
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto py-0.5"
        aria-label={t('chrome.mainNavigation')}
      >
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            to={item.href}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
              )
            }
          >
            <item.icon className="size-4 shrink-0" />
            {t(item.titleKey)}
          </NavLink>
        ))}
      </nav>

      <Separator />

      <a
        href="https://discord.gg/9TN8RFZ"
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
      >
        <img
          src={ssbuTrainingGroundsLogo}
          alt="SSBU Training Grounds"
          className="size-8 shrink-0 rounded-full"
        />
        {t('chrome.trainingGrounds')}
      </a>

      {/* Donorbox blue (#41a2d8) kept from the legacy button so it reads as
          the familiar Donate control rather than another nav item. */}
      <a
        href="https://donorbox.org/support-smash-tracker"
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-center gap-3 rounded-md bg-[#41a2d8] px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        <img
          src="https://donorbox.org/images/white_logo.svg"
          alt=""
          role="presentation"
          className="h-4 shrink-0"
        />
        {t('chrome.donate')}
      </a>
    </div>
  );
}

/**
 * Sidebar contents shared by the persistent desktop sidebar and the mobile
 * Sheet drawer. Phase 11 fix round 2 (D-01/D1): route-aware three-way swap
 * driven by `useActiveSubject()` — the personal rail everywhere outside
 * `/coach`, a minimal hub rail at `/coach` itself, and the client-workspace
 * rail at `/coach/:clientId/*`. Because both the desktop `Sidebar` and the
 * Topbar's mobile `Sheet` render this single component, the swap applies
 * identically to both surfaces without touching either of them.
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { mode, clientId } = useActiveSubject();

  if (clientId != null) {
    return <ClientWorkspaceSidebar clientId={clientId} onNavigate={onNavigate} />;
  }
  if (mode === 'coaching') {
    return <CoachingHubSidebar onNavigate={onNavigate} />;
  }
  return <PersonalSidebar onNavigate={onNavigate} />;
}

import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { useClientWorkspaces } from '@/hooks/useClientWorkspaces';
import { useOwnedWorkspaceSubject } from '@/hooks/useOwnedWorkspaceSubject';
import { useMatches } from '@/hooks/useMatches';
import { CoachAccessCard } from './CoachAccessCard';
import { DangerZoneCard } from './DangerZoneCard';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01): the
 * `/workspace/:tenantId/overview` landing page. Deliberately small — this is
 * the settings/overview surface for the claimed workspace, not a rebuild of
 * the coach's own multi-step checklist page. Renders the coach-given
 * workspace label (fixed for v2.4 — editing it is deferred to backlog), a
 * compact match/VOD count line, quick links to the workspace's other
 * surfaces, the Coach access card, and (Quick 260726-r6) the destructive
 * "danger zone" hard-delete card below it.
 */
export function OwnerWorkspaceOverviewPage() {
  const { t } = useTranslation();
  const { tenantId } = useOwnedWorkspaceSubject();
  const workspaces = useClientWorkspaces();
  const workspace = workspaces.data?.find((entry) => entry.tenantId === tenantId);
  const workspaceLabel = workspace?.label ?? tenantId ?? '';

  const { data: matchesData } = useMatches();
  const matches = matchesData ?? [];
  const matchCount = matches.length;
  const vodCount = matches.filter((match) => match.vodUrl != null).length;

  if (!workspace) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {workspaceLabel} — {t('ownerWorkspace.overviewTitle')}
            </h1>
            <Badge variant="secondary">{t('ownerWorkspace.ownedBadge')}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{t('ownerWorkspace.overviewSubtitle')}</p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t('ownerWorkspace.stats.matches', { count: matchCount })} ·{' '}
        {t('ownerWorkspace.stats.vods', { count: vodCount })}
      </p>

      <div className="flex flex-wrap gap-2">
        <Link
          to={`/workspace/${tenantId}/match-data`}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          {t('ownerWorkspace.quickLinks.matches')}
        </Link>
        <Link
          to={`/workspace/${tenantId}/vods`}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          {t('ownerWorkspace.quickLinks.vods')}
        </Link>
        <Link
          to={`/workspace/${tenantId}/dashboard`}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          {t('ownerWorkspace.quickLinks.analytics')}
        </Link>
        <Link
          to={`/workspace/${tenantId}/fighters`}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          {t('ownerWorkspace.quickLinks.fighters')}
        </Link>
      </div>

      <CoachAccessCard workspace={workspace} />

      <DangerZoneCard workspace={workspace} />
    </div>
  );
}

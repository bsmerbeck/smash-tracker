import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Crosshair } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildAnalyzeOpponentPath, type AnalyzeOpponentIdentity } from '@/lib/analyzeOpponent';

/**
 * Phase 30.3 (Gate 4): the "Analyze opponent" affordance — a deep link into
 * the EXISTING `/opponents` scouting surface with this opponent preselected
 * (provider player ID preferred, alias-aware tag fallback — see
 * `buildAnalyzeOpponentPath`). Renders nothing only when nothing identifies
 * the opponent (no dead links for anonymous rows) — `buildAnalyzeOpponentPath`
 * returns `null`.
 *
 * Plan 38-02 (D-03/OPP-04): before this plan, the component ALSO rendered
 * nothing for a coach client or an owned workspace, because `/opponents` had
 * no workspace-equivalent route and the link would have jumped a coach or an
 * owner out of a client's/workspace's data into the VIEWER's own personal
 * scouting page — the exact cross-subject leak class walkthrough FB-6 fixed
 * for other CTAs. That is no longer true: `/opponents` is now mounted under
 * all three subject families from the shared `subjectAnalyticsRoutes` list
 * (plan 38-02, Task 1), so the destination is built through the
 * subject-aware `useSubjectPath` builder (fixed in this same plan) instead
 * of being suppressed. The ONLY remaining reason this component renders
 * nothing is an identity that yields no path.
 *
 * `variant='icon'` is the compact table-cell/row form; `variant='button'`
 * is the labeled form for detail cards.
 */
export function AnalyzeOpponentLink({
  identity,
  variant = 'icon',
}: {
  identity: AnalyzeOpponentIdentity;
  variant?: 'icon' | 'button';
}) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const personalPath = buildAnalyzeOpponentPath(identity);

  if (personalPath == null) {
    return null;
  }

  const path = subjectPath(personalPath);

  const label = identity.opponent
    ? t('shared.analyzeOpponent.aria', { name: identity.opponent })
    : t('shared.analyzeOpponent.label');

  if (variant === 'button') {
    return (
      <Button type="button" variant="outline" size="sm" asChild>
        <Link to={path} aria-label={label}>
          <Crosshair className="size-4" />
          {t('shared.analyzeOpponent.label')}
        </Link>
      </Button>
    );
  }

  return (
    <Link
      to={path}
      aria-label={label}
      title={t('shared.analyzeOpponent.label')}
      className="inline-flex text-muted-foreground hover:text-foreground"
    >
      <Crosshair className="size-3.5" />
    </Link>
  );
}

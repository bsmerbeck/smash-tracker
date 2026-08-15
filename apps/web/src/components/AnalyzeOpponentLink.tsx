import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Crosshair } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEffectiveSubject } from '@/hooks/useEffectiveSubject';
import { buildAnalyzeOpponentPath, type AnalyzeOpponentIdentity } from '@/lib/analyzeOpponent';

/**
 * Phase 30.3 (Gate 4): the "Analyze opponent" affordance — a deep link into
 * the EXISTING `/opponents` scouting surface with this opponent preselected
 * (provider player ID preferred, alias-aware tag fallback — see
 * `buildAnalyzeOpponentPath`). Renders nothing when:
 *
 * - nothing identifies the opponent (no dead links for anonymous rows), or
 * - the active subject is a coach client / owned workspace (`clientId`
 *   non-null): `/opponents` has NO workspace equivalent route, so the link
 *   would jump from a client's data into the VIEWER'S personal scouting page
 *   — the exact cross-subject leak class walkthrough FB-6 fixed for other
 *   CTAs. Personal surfaces only, until an opponents route exists there.
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
  const { clientId } = useEffectiveSubject();
  const path = buildAnalyzeOpponentPath(identity);

  if (path == null || clientId != null) {
    return null;
  }

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

import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useSubjectPath } from '@/hooks/useSubjectPath';

/**
 * Phase 30.3 (Gate 4, fighter-preference fallback): the NON-BLOCKING
 * "choose your favorites" prompt Match Data and Matchups render while they
 * run on fighters inferred from observed match history
 * (`inferFighterIdsFromMatches`) instead of saved preferences. Deliberately
 * a banner, never a gate — the page's real content renders below it. Links
 * route through `useSubjectPath` so the prompt lands on the right chooser in
 * client workspaces too (both chooser paths map to the workspace Fighters
 * page).
 */
export function ChooseFavoritesPrompt() {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4"
      data-testid="choose-favorites-prompt"
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{t('shared.inferredFighters.title')}</p>
        <p className="text-sm text-muted-foreground">{t('shared.inferredFighters.body')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to={subjectPath('/choose-primary')}>{t('shared.noFighters.choosePrimary')}</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={subjectPath('/choose-secondary')}>
            {t('shared.noFighters.chooseSecondary')}
          </Link>
        </Button>
      </div>
    </div>
  );
}

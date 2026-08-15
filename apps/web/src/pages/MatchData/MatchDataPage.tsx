import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useSortedFighters } from '@/hooks/useFighterName';
import { useStageFavorites, useToggleStageFavorite } from '@/hooks/useStageFavorites';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { ChooseFavoritesPrompt } from '@/components/ChooseFavoritesPrompt';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { inferFighterIdsFromMatches } from '@/lib/inferredFighters';
import { AddMatchForm } from '@/pages/Dashboard/components/AddMatchForm';
import { MatchTable } from './components/MatchTable';
import { RosterUsage } from './components/RosterUsage';
import { StageBreakdown } from './components/StageBreakdown';

/**
 * Ports legacy/src/screens/MatchData; the source/time filter is now global (see the topbar's AnalyticsFilterControls), not a per-page control.
 *
 * Phase 30.3 (Gate 4, fighter-preference fallback): when the subject has
 * matches but NO saved primary/secondary favorites (imported demo
 * histories), the page infers a read-only fighter list from the fighters
 * observed in those matches instead of dead-ending on the choose-fighters
 * gate — which now only renders when there is neither a saved selection nor
 * a match to infer from. "Choose favorites" stays available as a
 * non-blocking prompt banner above the real content.
 */
export function MatchDataPage() {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { matches, allMatches, isLoading: matchesLoading, filterActive } = useFilteredMatches();
  const { data: stageFavorites } = useStageFavorites();
  const toggleStageFavorite = useToggleStageFavorite();

  const savedFighterIds = useMemo(
    () => [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])],
    [fighterSelection],
  );
  const usingInferredFighters = savedFighterIds.length === 0 && allMatches.length > 0;
  const rawFighterSprites = useMemo<Fighter[]>(() => {
    const ids = usingInferredFighters ? inferFighterIdsFromMatches(allMatches) : savedFighterIds;
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [usingInferredFighters, allMatches, savedFighterIds]);
  // 260725-Q1: alphabetized by localized name — matches every other fighter
  // picker in the app.
  const fighterSprites = useSortedFighters(rawFighterSprites);

  if (fightersLoading || matchesLoading) {
    return <div className="text-muted-foreground">{t('matchData.loading')}</div>;
  }

  if (fighterSprites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('shared.noFighters.title')}</h1>
        <p className="max-w-md text-muted-foreground">{t('shared.noFighters.subtitle')}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to={subjectPath('/choose-primary')}>{t('shared.noFighters.choosePrimary')}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to={subjectPath('/choose-secondary')}>
              {t('shared.noFighters.chooseSecondary')}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">{t('matchData.noMatches')}</h2>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <AddMatchForm fighterSprites={fighterSprites} fighter={fighterSprites[0]} />
          <Button asChild variant="outline">
            <Link to={subjectPath('/dashboard')}>{t('common.goToDashboard')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {usingInferredFighters && <ChooseFavoritesPrompt />}
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('matchData.title')}</CardTitle>
          <AddMatchForm fighterSprites={fighterSprites} fighter={fighterSprites[0]} />
        </CardHeader>
        <CardContent>
          <MatchTable matches={matches} fighterSprites={fighterSprites} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RosterUsage matches={matches} fighterSprites={fighterSprites} />
        <StageBreakdown
          matches={matches}
          usageMatches={allMatches}
          favoriteStageIds={stageFavorites?.stageIds}
          onToggleFavorite={toggleStageFavorite}
        />
      </div>
    </div>
  );
}

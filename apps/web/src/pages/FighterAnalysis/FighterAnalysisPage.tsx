import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { SelectFighter } from './components/SelectFighter';
import { FighterHero } from './components/FighterHero';
import { StageMastery } from './components/StageMastery';
import { MatchupCoverage } from './components/MatchupCoverage';
import { PracticeRecommendations } from './components/PracticeRecommendations';
import { MatchupStageGuide } from './components/MatchupStageGuide';
import { OpponentTable } from './components/OpponentTable';

/**
 * Fighter Analysis command center: per-fighter hero, Stage Mastery grid,
 * matchup coverage of the meta + practice recommendations, the Matchup Stage
 * Guide, and the human-opponent table (docs/analytics-vision.md V4 Phase E).
 * Ports legacy/src/screens/FighterAnalysis.
 */
export function FighterAnalysisPage() {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { matches, allMatches, isLoading: matchesLoading, filterActive } = useFilteredMatches();

  const fighterSprites = useMemo<Fighter[]>(() => {
    const ids = [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])];
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [fighterSelection]);

  const [selectedFighterId, setSelectedFighterId] = useState<number | undefined>(undefined);
  const fighter =
    fighterSprites.find((s) => s.id === selectedFighterId) ?? fighterSprites[0] ?? undefined;

  if (fightersLoading || matchesLoading) {
    return <div className="text-muted-foreground">{t('fighterAnalysis.loading')}</div>;
  }

  if (fighterSprites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('shared.noFighters.title')}</h1>
        <p className="max-w-md text-muted-foreground">{t('fighterAnalysis.noFightersSubtitle')}</p>
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
        <h2 className="text-xl font-semibold tracking-tight">{t('shared.noMatches.title')}</h2>
        <p className="text-muted-foreground">{t('shared.noMatches.subtitle')}</p>
        <Button asChild className="mt-2">
          <Link to={subjectPath('/dashboard')}>{t('common.goToDashboard')}</Link>
        </Button>
      </div>
    );
  }

  const fighterMatches = fighter ? matches.filter((m) => m.fighter_id === fighter.id) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('fighterAnalysis.title')}</h1>
        <SelectFighter
          fighter={fighter}
          fighterSprites={fighterSprites}
          onChange={(next) => setSelectedFighterId(next.id)}
        />
      </div>

      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      {fighter && (
        <>
          <FighterHero fighter={fighter} fighterMatches={fighterMatches} allMatches={allMatches} />

          <StageMastery fighterMatches={fighterMatches} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <MatchupCoverage allFilteredMatches={matches} fighterMatches={fighterMatches} />
            </div>
            <PracticeRecommendations allFilteredMatches={matches} fighterMatches={fighterMatches} />
          </div>

          <MatchupStageGuide fighterMatches={fighterMatches} />

          <OpponentTable fighterMatches={fighterMatches} />
        </>
      )}
    </div>
  );
}

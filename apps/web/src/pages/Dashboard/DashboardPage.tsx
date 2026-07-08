import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { getFighterById } from '@/data/sprites';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { DashboardContext, type DashboardContextValue } from './DashboardContext';
import { DashboardToolbar } from './components/DashboardToolbar';
import { WinLossTracker } from './components/WinLossTracker';
import { MatchupSnapshot } from './components/MatchupSnapshot';
import { PreviousMatches } from './components/PreviousMatches';
import { LastMatchesChart } from './components/LastMatchesChart';
import { HeroStats } from './components/HeroStats';
import { StageTiles } from './components/StageTiles';

/** Ports legacy/src/screens/Dashboard. */
export function DashboardPage() {
  const { t } = useTranslation();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const {
    matches,
    allMatches,
    timeFilteredMatches,
    isLoading: matchesLoading,
    filterActive,
  } = useFilteredMatches();

  const fighterSprites = useMemo<Fighter[]>(() => {
    const ids = [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])];
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [fighterSelection]);

  // Tracks an explicit user selection only; when unset, the first available
  // fighter is used (derived below during render, mirroring legacy's
  // one-time "firstLoad" hydration of `fighter` from the first sprite,
  // without needing an effect to seed state from data that just loaded).
  const [selectedFighterId, setSelectedFighterId] = useState<number | undefined>(undefined);

  const fighter =
    fighterSprites.find((s) => s.id === selectedFighterId) ?? fighterSprites[0] ?? undefined;

  const contextValue: DashboardContextValue = {
    fighterSprites,
    fighter,
    setFighter: (next) => setSelectedFighterId(next.id),
  };

  if (fightersLoading || matchesLoading) {
    return <div className="text-muted-foreground">{t('dashboard.loading')}</div>;
  }

  if (fighterSprites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('shared.noFighters.title')}</h1>
        <p className="max-w-md text-muted-foreground">{t('shared.noFighters.subtitle')}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to="/choose-primary">{t('shared.noFighters.choosePrimary')}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/choose-secondary">{t('shared.noFighters.chooseSecondary')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <DashboardContext.Provider value={contextValue}>
      <div className="flex flex-col gap-6">
        <HeroStats matches={matches} timeFilteredMatches={timeFilteredMatches} />

        <DashboardToolbar />
        {filterActive && allMatches.length > 0 && matches.length === 0 && <FilteredEmptyNotice />}
        <WinLossTracker matches={matches} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <LastMatchesChart matches={matches} />
          <PreviousMatches matches={matches} />
        </div>

        <StageTiles matches={matches} />
        <MatchupSnapshot matches={matches} />
      </div>
    </DashboardContext.Provider>
  );
}

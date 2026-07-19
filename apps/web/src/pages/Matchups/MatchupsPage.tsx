import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { alphaSpriteList } from '@/components/match-form/MatchForm';
import { MatchupsContext, type MatchupsContextValue } from './MatchupsContext';
import { SelectFighter } from './components/SelectFighter';
import { SelectOpponent } from './components/SelectOpponent';
import { MatchWinLossCard } from './components/MatchWinLossCard';
import { MatchupChart } from './components/MatchupChart';
import { MatchupInsights } from './components/MatchupInsights';
import { MatchupStageTable } from './components/MatchupStageTable';
import { MatchupTable } from './components/MatchupTable';
import { MatchupMatrix, MATCHUP_DETAIL_ANCHOR_ID } from './components/MatchupMatrix';
import { CounterpickAdvisor } from './components/CounterpickAdvisor';
import { PairingOpponentSplit } from './components/PairingOpponentSplit';

/**
 * Ports legacy/src/screens/Matchups. Selecting "your fighter" (from the
 * user's primary+secondary selections) and an opponent fighter (any of the
 * 85) filters matches down to that exact fighter_id/opponent_id pairing —
 * see legacy Matchups.js `updateMatchups`, which does
 * `.filter(m => m.fighter_id === fighter.id).filter(m => m.opponent_id === opponent.id)`.
 */
export function MatchupsPage() {
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
  const [selectedOpponentId, setSelectedOpponentId] = useState<number | undefined>(undefined);

  const fighter =
    fighterSprites.find((s) => s.id === selectedFighterId) ?? fighterSprites[0] ?? undefined;
  const opponent =
    alphaSpriteList.find((s) => s.id === selectedOpponentId) ?? alphaSpriteList[0] ?? undefined;

  const contextValue: MatchupsContextValue = {
    fighterSprites,
    fighter,
    setFighter: (next) => setSelectedFighterId(next.id),
    opponent,
    setOpponent: (next) => setSelectedOpponentId(next.id),
  };

  if (fightersLoading || matchesLoading) {
    return <div className="text-muted-foreground">{t('matchups.loading')}</div>;
  }

  if (fighterSprites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('shared.noFighters.title')}</h1>
        <p className="max-w-md text-muted-foreground">{t('matchups.noFightersSubtitle')}</p>
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

  const matchupMatches =
    fighter && opponent
      ? matches.filter((m) => m.fighter_id === fighter.id && m.opponent_id === opponent.id)
      : [];

  return (
    <MatchupsContext.Provider value={contextValue}>
      <div className="flex flex-col gap-6">
        {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

        <Card>
          <CardContent className="flex flex-wrap items-center justify-center gap-6 pt-6">
            <div className="flex flex-col items-center gap-2">
              <h3 className="text-sm font-medium text-muted-foreground">{t('matchups.you')}</h3>
              <SelectFighter />
            </div>
            <span className="text-xl font-semibold">{t('matchups.vs')}</span>
            <div className="flex flex-col items-center gap-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                {t('matchups.opponent')}
              </h3>
              <SelectOpponent />
            </div>
          </CardContent>
        </Card>

        <MatchupMatrix matches={matches} />

        <div id={MATCHUP_DETAIL_ANCHOR_ID} className="flex flex-col gap-6 scroll-mt-16">
          {fighter && opponent && (
            <div className="flex items-center justify-center gap-4">
              {fighter.url && <img src={fighter.url} alt="" className="size-12 object-contain" />}
              <span className="text-lg font-semibold">{fighter.name}</span>
              <span className="text-muted-foreground">{t('matchups.vs')}</span>
              <span className="text-lg font-semibold">{opponent.name}</span>
              {opponent.url && <img src={opponent.url} alt="" className="size-12 object-contain" />}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MatchWinLossCard matchupMatches={matchupMatches} />
            <MatchupInsights matchupMatches={matchupMatches} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CounterpickAdvisor matchupMatches={matchupMatches} />
            <MatchupStageTable matchupMatches={matchupMatches} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t('matchups.winRateTrend')}</CardTitle>
              </CardHeader>
              <CardContent>
                <MatchupChart matchupMatches={matchupMatches} />
              </CardContent>
            </Card>
            <PairingOpponentSplit matchupMatches={matchupMatches} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t('matchups.results')}</CardTitle>
            </CardHeader>
            <CardContent>
              <MatchupTable matchupMatches={matchupMatches} />
            </CardContent>
          </Card>
        </div>
      </div>
    </MatchupsContext.Provider>
  );
}

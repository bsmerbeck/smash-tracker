import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartCard } from '@/components/charts/ChartCard';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { usePersistedSelection } from '@/hooks/usePersistedSelection';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { inferFighterIdsFromMatches } from '@/lib/inferredFighters';
import { ChooseFavoritesPrompt } from '@/components/ChooseFavoritesPrompt';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { MatchupsContext, type MatchupsContextValue } from './MatchupsContext';
import { SelectFighter } from './components/SelectFighter';
import { SelectOpponent } from './components/SelectOpponent';
import { MatchWinLossCard } from './components/MatchWinLossCard';
import { MatchupChart } from './components/MatchupChart';
import { MatchupInsights } from './components/MatchupInsights';
import { MatchupStageTable } from './components/MatchupStageTable';
import { MatchupTable, MATCHUP_TABLE_ANCHOR_ID } from './components/MatchupTable';
import { MatchupMatrix, MATCHUP_DETAIL_ANCHOR_ID } from './components/MatchupMatrix';
import { CounterpickAdvisor } from './components/CounterpickAdvisor';
import { PairingOpponentSplit } from './components/PairingOpponentSplit';

/**
 * Ports legacy/src/screens/Matchups. Selecting "your fighter" (from the
 * user's primary+secondary selections) and an opponent fighter (any of the
 * 85) filters matches down to that exact fighter_id/opponent_id pairing —
 * see legacy Matchups.js `updateMatchups`, which does
 * `.filter(m => m.fighter_id === fighter.id).filter(m => m.opponent_id === opponent.id)`.
 *
 * Phase 30.3 (Gate 4, fighter-preference fallback): with matches but no
 * saved favorites (imported demo histories), "your fighter" options are
 * inferred read-only from the fighters observed in the match history — the
 * choose-fighters gate only renders when there is neither a saved selection
 * nor a match to infer from, and a non-blocking prompt replaces it above the
 * real content.
 */
export function MatchupsPage() {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { matches, allMatches, isLoading: matchesLoading, filterActive } = useFilteredMatches();

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

  const {
    fighter,
    opponent,
    setFighter,
    setOpponent,
    orderedFighterSprites,
    fighterUsageById,
    opponentUsage,
  } = usePersistedSelection({ fighterSprites: rawFighterSprites });

  // The trend chart's in-page drill-down selection (D-07, CHRT-02). Cleared
  // at the single choke point below whenever the pairing changes — never
  // from a render-time effect keyed on the pairing (this repo's lint rules
  // forbid writing state during render, and a render-mirrored value would be
  // one flush behind these programmatic setters).
  const [selectedMatchIds, setSelectedMatchIds] = useState<ReadonlySet<string> | null>(null);

  function handleSetFighter(nextFighter: Fighter) {
    setFighter(nextFighter);
    setSelectedMatchIds(null);
  }

  function handleSetOpponent(nextOpponent: Fighter) {
    setOpponent(nextOpponent);
    setSelectedMatchIds(null);
  }

  const contextValue: MatchupsContextValue = {
    fighterSprites: orderedFighterSprites,
    fighter,
    setFighter: handleSetFighter,
    opponent,
    setOpponent: handleSetOpponent,
    fighterUsageById,
    opponentUsage,
    selectedMatchIds,
    setSelectedMatchIds,
  };

  if (fightersLoading || matchesLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="text-muted-foreground">{t('matchups.loading')}</div>
      </div>
    );
  }

  if (orderedFighterSprites.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t('shared.noFighters.title')}</h1>
          <p className="max-w-md text-muted-foreground">{t('matchups.noFightersSubtitle')}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link to={subjectPath('/choose-primary')}>
                {t('shared.noFighters.choosePrimary')}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={subjectPath('/choose-secondary')}>
                {t('shared.noFighters.chooseSecondary')}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <h2 className="text-xl font-semibold tracking-tight">{t('shared.noMatches.title')}</h2>
          <p className="text-muted-foreground">{t('shared.noMatches.subtitle')}</p>
          <Button asChild className="mt-2">
            <Link to={subjectPath('/dashboard')}>{t('common.goToDashboard')}</Link>
          </Button>
        </div>
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
        {usingInferredFighters && <ChooseFavoritesPrompt />}
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
              <span className="text-lg font-semibold">{localizedFighterName(fighter.id, t)}</span>
              <span className="text-muted-foreground">{t('matchups.vs')}</span>
              <span className="text-lg font-semibold">{localizedFighterName(opponent.id, t)}</span>
              {opponent.url && <img src={opponent.url} alt="" className="size-12 object-contain" />}
            </div>
          )}

          {/*
            items-start (plan 37-03, CHRT-01): CSS Grid's default alignment
            stretches every cell to its tallest sibling's row height — the
            load-bearing mechanism behind the "too much empty space"
            complaint, since a sparse stat tile was being force-stretched to
            match a taller neighbour. Top-aligning lets each card size to its
            own intrinsic content instead.
          */}
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <MatchWinLossCard matchupMatches={matchupMatches} />
            <MatchupInsights matchupMatches={matchupMatches} />
          </div>

          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <CounterpickAdvisor matchupMatches={matchupMatches} />
            <MatchupStageTable matchupMatches={matchupMatches} />
          </div>

          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <ChartCard
              title={t('matchups.winRateTrend')}
              caption={t('shared.evidence.type.fact')}
              abstained={
                matchupMatches.length < ABSTENTION_FLOOR_GAMES
                  ? { gamesNeeded: ABSTENTION_FLOOR_GAMES - matchupMatches.length }
                  : null
              }
            >
              <MatchupChart matchupMatches={matchupMatches} />
            </ChartCard>
            <PairingOpponentSplit matchupMatches={matchupMatches} />
          </div>

          <Card id={MATCHUP_TABLE_ANCHOR_ID} className="scroll-mt-16">
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

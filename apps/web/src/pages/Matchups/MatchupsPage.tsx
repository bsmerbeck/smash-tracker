import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartCard } from '@/components/charts/ChartCard';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { usePersistedSelection } from '@/hooks/usePersistedSelection';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { localizedFighterName } from '@/lib/fighterNames';
import { inferFighterIdsFromMatches } from '@/lib/inferredFighters';
import {
  DRILL_DOWN_EVENT_PARAM,
  DRILL_DOWN_FIGHTER_PARAM,
  DRILL_DOWN_FROM_PARAM,
  DRILL_DOWN_STAGE_PARAM,
  DRILL_DOWN_TO_PARAM,
  DRILL_DOWN_VS_PARAM,
  buildDrillDownSearch,
  readDrillDownParams,
  sortMatchesNewestFirst,
  type DrillDownAxes,
} from '@/lib/drillDownParams';
import { ChooseFavoritesPrompt } from '@/components/ChooseFavoritesPrompt';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { MatchupsContext, type MatchupsContextValue } from './MatchupsContext';
import { SelectFighter } from './components/SelectFighter';
import { SelectOpponent } from './components/SelectOpponent';
import { MatchWinLossCard } from './components/MatchWinLossCard';
import { MatchupChart } from './components/MatchupChart';
import { MatchupInsights } from './components/MatchupInsights';
import { MatchupStageTable } from './components/MatchupStageTable';
import { MATCHUP_TABLE_ANCHOR_ID } from './lib/matchupAnchors';
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
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { matches, allMatches, isLoading: matchesLoading, filterActive } = useFilteredMatches();

  const stageIds = useMemo(() => new Set(stagesById.keys()), []);
  // D-05: tolerant read of every drill-down axis currently in the URL. A URL
  // axis naming no known fighter/stage already resolves to `undefined` here
  // (readDrillDownParams's own membership check) — never a throw, never an
  // out-of-range lookup downstream.
  const axesFromUrl = useMemo(
    () => readDrillDownParams(searchParams, { stageIds }),
    [searchParams, stageIds],
  );

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

  /** Clears the three filter-axis params from `next` in place — every writer below shares this so "which three params" has one spelling. */
  function clearFilterAxes(next: URLSearchParams): void {
    next.delete(DRILL_DOWN_STAGE_PARAM);
    next.delete(DRILL_DOWN_EVENT_PARAM);
    next.delete(DRILL_DOWN_FROM_PARAM);
    next.delete(DRILL_DOWN_TO_PARAM);
  }

  /**
   * Phase 38-04 (D-05/D-15/Phase 35 D-06): writes the FILTER axes
   * (stage/event/window) to the URL, replacing whichever of those three
   * were previously active — an axis omitted from `axes` is CLEARED, not
   * left as-is, so switching pairing (via the picker handlers below, which
   * call this with `{}`) or picking a new stage/point always drops any
   * stale narrowing rather than composing with it. Never touches the
   * character axes (`fighter`/`vs`) or any param this contract doesn't own.
   */
  function setDrillDown(
    axes: Partial<Pick<DrillDownAxes, 'stageId' | 'eventKey' | 'from' | 'to'>>,
  ) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      clearFilterAxes(next);
      for (const [key, value] of buildDrillDownSearch(axes).entries()) {
        next.set(key, value);
      }
      return next;
    });
  }

  /**
   * Phase 38-04 (D-15/Phase 35 D-06): the two directions are DELIBERATELY
   * asymmetric. An EXPLICIT picker interaction still calls
   * `usePersistedSelection`'s persisting setter (shipped Phase 35 D-06
   * behaviour, unchanged) AND now also writes the corresponding character
   * axis to the URL, so the URL and the picker can never disagree after a
   * deliberate change. A URL-seeded axis (`axesFromUrl` below) NEVER calls a
   * persisting setter — it is render input to the effective-pairing
   * composition and stops there. Also clears the drill-down FILTER axes
   * (stage/event/window), mirroring the retired `setSelectedMatchIds(null)`
   * clear-on-pairing-change behaviour.
   */
  function handleSetFighter(nextFighter: Fighter) {
    setFighter(nextFighter);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      clearFilterAxes(next);
      next.set(DRILL_DOWN_FIGHTER_PARAM, String(nextFighter.id));
      return next;
    });
  }

  function handleSetOpponent(nextOpponent: Fighter) {
    setOpponent(nextOpponent);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      clearFilterAxes(next);
      next.set(DRILL_DOWN_VS_PARAM, String(nextOpponent.id));
      return next;
    });
  }

  /**
   * Phase 38-04 (D-05/DRL-02, review finding H-04): the EFFECTIVE pairing —
   * `URL axis ?? persisted selection` — resolved ONCE, here, before
   * `matchupMatches` is derived. Every downstream consumer (the pairing
   * header, the win-loss card, the insights, the counterpick advisor, the
   * stage table, the trend chart and the results list) renders from THIS
   * pairing, not from the raw persisted `fighter`/`opponent`. A URL axis
   * that resolves to no known fighter is already `undefined` coming out of
   * `readDrillDownParams`, so the persisted value wins rather than the
   * detail block going blank.
   */
  const effectiveFighter =
    (axesFromUrl.fighterId != null ? getFighterById(axesFromUrl.fighterId) : undefined) ?? fighter;
  const effectiveOpponent =
    (axesFromUrl.vsFighterId != null ? getFighterById(axesFromUrl.vsFighterId) : undefined) ??
    opponent;

  const contextValue: MatchupsContextValue = {
    fighterSprites: orderedFighterSprites,
    fighter: effectiveFighter,
    setFighter: handleSetFighter,
    opponent: effectiveOpponent,
    setOpponent: handleSetOpponent,
    fighterUsageById,
    opponentUsage,
    drillDownAxes: {
      stageId: axesFromUrl.stageId,
      eventKey: axesFromUrl.eventKey,
      from: axesFromUrl.from,
      to: axesFromUrl.to,
    },
    setDrillDown,
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
    effectiveFighter && effectiveOpponent
      ? matches.filter(
          (m) => m.fighter_id === effectiveFighter.id && m.opponent_id === effectiveOpponent.id,
        )
      : [];

  // The terminus's axes ALSO carry the effective character pair — not just
  // stage/window — so `FilteredMatchList` omits the already-pinned
  // character columns and includes the pairing in its filter summary, even
  // though `matchupMatches` above is already pairing-filtered (a harmless,
  // idempotent re-affirmation of membership, not a second narrowing
  // mechanism).
  const terminusAxes: DrillDownAxes = {
    fighterId: effectiveFighter?.id,
    vsFighterId: effectiveOpponent?.id,
    stageId: axesFromUrl.stageId,
    from: axesFromUrl.from,
    to: axesFromUrl.to,
  };
  const sortedMatchupMatches = sortMatchesNewestFirst(matchupMatches);

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
          {effectiveFighter && effectiveOpponent && (
            <div className="flex items-center justify-center gap-4">
              {effectiveFighter.url && (
                <img src={effectiveFighter.url} alt="" className="size-12 object-contain" />
              )}
              <span className="text-lg font-semibold">
                {localizedFighterName(effectiveFighter.id, t)}
              </span>
              <span className="text-muted-foreground">{t('matchups.vs')}</span>
              <span className="text-lg font-semibold">
                {localizedFighterName(effectiveOpponent.id, t)}
              </span>
              {effectiveOpponent.url && (
                <img src={effectiveOpponent.url} alt="" className="size-12 object-contain" />
              )}
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
              <FilteredMatchList
                matches={sortedMatchupMatches}
                axes={terminusAxes}
                onClearFilters={() => setDrillDown({})}
                showDelete
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </MatchupsContext.Provider>
  );
}

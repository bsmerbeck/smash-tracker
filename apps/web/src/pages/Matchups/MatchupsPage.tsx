import { useCallback, useEffect, useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter, Insight, Match } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartCard } from '@/components/charts/ChartCard';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { cn } from '@/lib/utils';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { buildInsightDoors, resolveInsightClaim } from '@/components/analytics/insightDoors';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useHorizon } from '@/hooks/useHorizon';
import { usePersistedSelection } from '@/hooks/usePersistedSelection';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { localizedFighterName } from '@/lib/fighterNames';
import { inferFighterIdsFromMatches } from '@/lib/inferredFighters';
import {
  DRILL_DOWN_CLAIM_PARAM,
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
import {
  MatchupChart,
  buildFormNowVerdict,
  formStripEventKeyForMatch,
  renderFormNowHead,
  useMatchupFormNow,
} from './components/MatchupChart';
import {
  MatchupOrPlayerCard,
  buildMatchupOrPlayerVerdict,
  useMatchupOrPlayerInsight,
} from './components/MatchupOrPlayerCard';
import { MatchupInsights } from './components/MatchupInsights';
import { MatchupStageTable } from './components/MatchupStageTable';
import { MATCHUP_TABLE_ANCHOR_ID } from './lib/matchupAnchors';
import { MatchupMatrix, MATCHUP_DETAIL_ANCHOR_ID } from './components/MatchupMatrix';
import { CounterpickAdvisor } from './components/CounterpickAdvisor';
import { PairingOpponents } from './components/PairingOpponents';

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
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const {
    matches,
    allMatches,
    isLoading: matchesLoading,
    isFetching: matchesFetching,
    filterActive,
  } = useFilteredMatches();
  const { horizon } = useHorizon();

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

  /**
   * Clears the filter-axis params from `next` in place — every writer below
   * shares this so "which params" has one spelling. Plan 39.1-26 (gap
   * closure): also clears the `claim` axis — "Clear filters" and every
   * chart-point/set drill must drop a stale claim, never leave the list
   * showing a silent intersection of an old claim with a new narrowing.
   */
  function clearFilterAxes(next: URLSearchParams): void {
    next.delete(DRILL_DOWN_STAGE_PARAM);
    next.delete(DRILL_DOWN_EVENT_PARAM);
    next.delete(DRILL_DOWN_FROM_PARAM);
    next.delete(DRILL_DOWN_TO_PARAM);
    next.delete(DRILL_DOWN_CLAIM_PARAM);
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

  // WR-C02 (39.1-REVIEW.md): this object literal was rebuilt fresh every
  // render (a NEW reference even when every field's VALUE was unchanged),
  // defeating `FilteredMatchList`'s D-16 reference-identity memo on every
  // parent re-render — same fix as `OpponentHubPage.tsx`/`StageDetailPage.tsx`'s
  // own "WR-03 (38-REVIEW-FIX)". Declared here, alongside `effectiveFighter`/
  // `effectiveOpponent`, BEFORE this component's loading/empty-state early
  // returns below — same Rules-of-Hooks reasoning the `matchupMatches`
  // comment just below already documents for `useMatchupFormNow`. The
  // terminus's axes ALSO carry the effective character pair — not just
  // stage/window — so `FilteredMatchList` omits the already-pinned
  // character columns and includes the pairing in its filter summary, even
  // though `matchupMatches` below is already pairing-filtered (a harmless,
  // idempotent re-affirmation of membership, not a second narrowing
  // mechanism).
  //
  // CR-03 (39.1-REVIEW): `eventKey` is forwarded too — the chart's set drill
  // writes `event=`, and without this axis the terminus ignored it (the list
  // stayed on the whole pairing while the URL claimed a set).
  const terminusAxes: DrillDownAxes = useMemo(
    () => ({
      fighterId: effectiveFighter?.id,
      vsFighterId: effectiveOpponent?.id,
      stageId: axesFromUrl.stageId,
      eventKey: axesFromUrl.eventKey,
      from: axesFromUrl.from,
      to: axesFromUrl.to,
      claimId: axesFromUrl.claimId,
    }),
    [
      effectiveFighter?.id,
      effectiveOpponent?.id,
      axesFromUrl.stageId,
      axesFromUrl.eventKey,
      axesFromUrl.from,
      axesFromUrl.to,
      axesFromUrl.claimId,
    ],
  );

  // Computed here (BEFORE the loading/empty-state early returns below) so
  // `useMatchupFormNow` — a hook — is always called unconditionally, never
  // skipped by an early return (Rules of Hooks). Harmless to compute even on
  // the branches that return early: `matches`/`effectiveFighter`/
  // `effectiveOpponent` are already in scope regardless.
  //
  // WR-C02 (39.1-REVIEW.md): also memoized, for the SAME reason as
  // `terminusAxes` above: `FilteredMatchList`'s D-16 memo keys on BOTH
  // `axes` and `matches` — stabilizing only `axes` while this array still
  // got a fresh reference every render left the underlying recomputation
  // just as unfixed, for a different reason (mirrors `OpponentHubPage.tsx`'s
  // own `sortedOpponentMatches` useMemo). A beneficial side effect:
  // `useMatchupFormNow` below now also gets a stable input.
  const effectiveFighterIdForFilter = effectiveFighter?.id;
  const effectiveOpponentIdForFilter = effectiveOpponent?.id;
  const matchupMatches = useMemo(
    () =>
      effectiveFighterIdForFilter != null && effectiveOpponentIdForFilter != null
        ? matches.filter(
            (m) =>
              m.fighter_id === effectiveFighterIdForFilter &&
              m.opponent_id === effectiveOpponentIdForFilter,
          )
        : [],
    [matches, effectiveFighterIdForFilter, effectiveOpponentIdForFilter],
  );
  const sortedMatchupMatches = useMemo(
    () => sortMatchesNewestFirst(matchupMatches),
    [matchupMatches],
  );
  const formNowInsight = useMatchupFormNow({ matchupMatches, horizon });

  // Plan 39.1-24 (gap closure, Task 2, DD-09 reachability): the ONE
  // matchupOrPlayer insight this page shares with `MatchupOrPlayerCard`
  // (which takes the result as a prop below) and this page's own
  // `FilteredMatchList` terminus (`resolveClaim`/`claimSummary`). Called
  // unconditionally, above every early return (Rules of Hooks), mirroring
  // `useMatchupFormNow` just above.
  const matchupOrPlayerInsight = useMatchupOrPlayerInsight({ matchupMatches, horizon });

  // Plan 39.1-26 (gap closure, Task 1): the effective fighter/vs pairing
  // this page's door hrefs must carry — the SAME pairing both insights above
  // were computed over, never the persisted selection alone. A door is a
  // plain relative `<Link>`, never routed through `setSearchParams` (which
  // merges), so without this carry a followed door would drop a URL-seeded
  // pairing entirely, reverting to whatever the persisted selection resolves
  // to. Declared above every early return, mirroring `terminusAxes` above.
  const pairingDoorCarry = useMemo(
    () =>
      buildDrillDownSearch({
        fighterId: effectiveFighter?.id,
        vsFighterId: effectiveOpponent?.id,
      }),
    [effectiveFighter?.id, effectiveOpponent?.id],
  );

  // Plan 39.1-26 (gap closure, Task 1): both this pairing's own insights now
  // resolve a followed door's claim, not just `matchupOrPlayer` alone.
  const insightsForTerminus = useMemo(
    () => [formNowInsight, matchupOrPlayerInsight].filter((i): i is Insight => i != null),
    [formNowInsight, matchupOrPlayerInsight],
  );
  const claimSummary = useMemo(() => {
    if (axesFromUrl.claimId == null || effectiveOpponent == null) return undefined;
    if (formNowInsight != null && formNowInsight.id === axesFromUrl.claimId) {
      return buildFormNowVerdict(formNowInsight, effectiveOpponent.id, t);
    }
    if (matchupOrPlayerInsight != null && matchupOrPlayerInsight.id === axesFromUrl.claimId) {
      return buildMatchupOrPlayerVerdict(matchupOrPlayerInsight, t, effectiveOpponent.id);
    }
    return undefined;
  }, [axesFromUrl.claimId, effectiveOpponent, formNowInsight, matchupOrPlayerInsight, t]);
  // WR-C02 (39.1-REVIEW.md) precedent, re-applied: an inline arrow function
  // passed as `resolveClaim` would be a NEW reference every render, breaking
  // `FilteredMatchList`'s D-16 memo on every unrelated parent re-render.
  // Memoized by `insightsForTerminus` alone — the only thing this closure
  // actually reads.
  const resolveClaimForTerminus = useCallback(
    (claimId: string, ms: Match[]) =>
      resolveInsightClaim({ claimId, insights: insightsForTerminus, matches: ms }),
    [insightsForTerminus],
  );

  // Plan 39.1-26 (gap closure, Task 1): the chart's counted-games door —
  // built by `buildInsightDoors` from the SAME `formNowInsight` the
  // terminus above resolves against, anchored to `#matchup-table` (this
  // page's own terminus id, not the default `#games`) and carrying the
  // effective pairing so a URL-seeded pairing survives the round trip.
  // `undefined` whenever the insight has zero counted games.
  const formNowGamesDoor = formNowInsight
    ? buildInsightDoors({
        insight: formNowInsight,
        subjectPath,
        anchor: `#${MATCHUP_TABLE_ANCHOR_ID}`,
        carry: pairingDoorCarry,
      }).find((door) => door.kind === 'games')
    : undefined;

  // Plan 39.1-26 (gap closure, Task 1): landing is real in a browser
  // (BrowserRouter performs no hash scroll of its own — `AppRouter.tsx`) —
  // this scrolls the terminus into view once per navigation whenever the
  // hash names it, covering the chart door click.
  const location = useLocation();
  useEffect(() => {
    if (location.hash === `#${MATCHUP_TABLE_ANCHOR_ID}`) {
      document
        .getElementById(MATCHUP_TABLE_ANCHOR_ID)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [location.key, location.hash]);

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

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern — a page
  // skeleton echoing the loaded page's own section shapes (matrix, the
  // 2-up counterpick/stage-table pair, the PageGrid rail block at 4/8/8/4,
  // and the results table), so nothing shifts when data lands. This page is
  // not fully on the PageGrid/GridCell contract for its OWN non-rail
  // sections (the matrix and 2-up pair use raw grid classes, matching the
  // loaded layout below) — only the PageGrid block's spans are asserted for
  // an exact grid-span match, since that is the only section of this page
  // that already carries `data-span`. The filter card (fighter pickers +
  // HorizonSwitch) needs resolved fighter selections, so it is intentionally
  // omitted here too.
  if (fightersLoading || matchesLoading) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-6">
        <span className="sr-only">{t('matchups.loading')}</span>
        <CardSkeleton variant="chart" statusLabel={t('matchups.loading')} />
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <CardSkeleton variant="list" rows={4} statusLabel={t('matchups.loading')} />
          <CardSkeleton variant="list" rows={4} statusLabel={t('matchups.loading')} />
        </div>
        <PageGrid>
          <GridCell span={4} stack>
            <CardSkeleton variant="stat-row" rows={2} statusLabel={t('matchups.loading')} />
            <CardSkeleton variant="insight" statusLabel={t('matchups.loading')} />
          </GridCell>
          <GridCell span={8}>
            <CardSkeleton variant="chart" statusLabel={t('matchups.loading')} />
          </GridCell>
          <GridCell span={8}>
            <CardSkeleton variant="list" rows={4} statusLabel={t('matchups.loading')} />
          </GridCell>
          <GridCell span={4}>
            <CardSkeleton variant="insight" statusLabel={t('matchups.loading')} />
          </GridCell>
        </PageGrid>
        <CardSkeleton variant="list" rows={5} statusLabel={t('matchups.loading')} />
      </div>
    );
  }

  // Plan 39.1-20: a background refetch (matches already loaded once) holds
  // the previous frame at reduced opacity instead of flashing a skeleton.
  const isRefetching = matchesFetching && !matchesLoading;

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

  return (
    <MatchupsContext.Provider value={contextValue}>
      <div className="flex flex-col gap-6">
        {usingInferredFighters && <ChooseFavoritesPrompt />}
        {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

        {/* UI-SPEC §10.4: one filter row — the fighter picker, a spacer, then the
            page's single HorizonSwitch (INS-02). Never a per-chart control. */}
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-6 pt-6">
            <div className="flex flex-1 flex-wrap items-center justify-center gap-6">
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
            </div>
            <HorizonSwitch />
          </CardContent>
        </Card>

        <MatchupMatrix matches={matches} />

        {/* Plan 39.1-20: a background refetch (matches already loaded once)
            holds this whole detail block at reduced opacity instead of
            flashing a skeleton — the page's PageGrid lives inside this same
            wrapper, and MatchupChart's own `data-slot="matchup-chart-body"`
            (which exists only once this branch is reached) doubles as this
            route's layout-oracle loaded marker. */}
        <div
          id={MATCHUP_DETAIL_ANCHOR_ID}
          className={cn(
            'flex flex-col gap-6 scroll-mt-16',
            isRefetching &&
              'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
          )}
        >
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
            <CounterpickAdvisor matchupMatches={matchupMatches} />
            <MatchupStageTable matchupMatches={matchupMatches} />
          </div>

          {/*
            UI-SPEC §8.3's placement table. DOM order is the NARROW-width
            reading order (record tile -> Matchup Insights -> trend ->
            MatchupOrPlayer -> PairingOpponents) with `xl:order-*` re-flowing to the
            >=1280px pairing: trend(8) + stack(4) on row A, PairingOpponents
            (8, Task 3) + MatchupOrPlayer (4, Task 2) on row B. `GridCell`
            (39.1-06) only expresses a single `lg` breakpoint transition, so
            this block uses raw Tailwind classes at the `sm`/`lg`/`xl`
            breakpoints (640/1024/1280px — the same three widths UI-SPEC's
            table names) rather than the primitive, matching the plan's own
            "static responsive classes" instruction.
          */}
          <PageGrid>
            <div className="col-span-12 xl:order-2 xl:col-span-4">
              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:flex xl:flex-col">
                <MatchWinLossCard matchupMatches={matchupMatches} horizon={horizon} />
                <MatchupInsights matchupMatches={matchupMatches} />
              </div>
            </div>
            <div className="col-span-12 xl:order-1 xl:col-span-8">
              <ChartCard
                title={t('matchups.winRateTrend')}
                caption={t('shared.evidence.type.fact')}
                abstained={
                  matchupMatches.length < ABSTENTION_FLOOR_GAMES
                    ? { gamesNeeded: ABSTENTION_FLOOR_GAMES - matchupMatches.length }
                    : null
                }
                insight={
                  formNowInsight && effectiveOpponent
                    ? renderFormNowHead(
                        formNowInsight,
                        effectiveOpponent.id,
                        t,
                        i18n.language,
                        formNowGamesDoor ? (
                          <Link to={formNowGamesDoor.href}>
                            {t('insights.door.seeGames', { count: formNowGamesDoor.count })}
                          </Link>
                        ) : undefined,
                      )
                    : null
                }
              >
                <MatchupChart matchupMatches={matchupMatches} horizon={horizon} />
              </ChartCard>
            </div>
            <div className="col-span-12 xl:order-3 xl:col-span-8">
              <PairingOpponents matchupMatches={matchupMatches} />
            </div>
            <div className="col-span-12 xl:order-4 xl:col-span-4">
              <MatchupOrPlayerCard
                matchupMatches={matchupMatches}
                insight={matchupOrPlayerInsight}
                doorCarry={pairingDoorCarry}
              />
            </div>
          </PageGrid>

          <Card id={MATCHUP_TABLE_ANCHOR_ID} className="scroll-mt-16">
            <CardHeader>
              <CardTitle>{t('matchups.results')}</CardTitle>
            </CardHeader>
            <CardContent>
              <FilteredMatchList
                matches={sortedMatchupMatches}
                axes={terminusAxes}
                resolveClaim={resolveClaimForTerminus}
                claimSummary={claimSummary}
                eventKeyForMatch={formStripEventKeyForMatch}
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

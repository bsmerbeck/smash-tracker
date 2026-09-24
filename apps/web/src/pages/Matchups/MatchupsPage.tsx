import { useCallback, useId, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter, Insight, Match } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  buildPeriodSeries,
  periodPointMatchIdsForKey,
} from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartCard } from '@/components/charts/ChartCard';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { cn } from '@/lib/utils';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { buildInsightDoors, resolveInsightClaim } from '@/components/analytics/insightDoors';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useHorizon } from '@/hooks/useHorizon';
import { useClaimFollowsHorizon, useUrlClaimRewriter } from '@/hooks/useClaimFollowsHorizon';
import { useLandingScroll } from '@/hooks/useLandingScroll';
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
  const {
    horizon,
    isLoading: horizonLoading,
    explicitChangeCount: horizonChangeCount,
  } = useHorizon();

  // Plan 39.1-30 (item 5): stable across re-renders — attaches the pairing
  // identity heading to the grid it names via `aria-labelledby`.
  const pairingHeadingId = useId();
  // WR-07: the pairing picker's <label htmlFor> targets.
  const fighterSelectId = useId();
  const opponentSelectId = useId();

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

  // CR-02 (39.1-REVIEW): the ONE period series `MatchupChart` plots AND this
  // page's terminus resolves a trend-point drill (`event=<point.key>`)
  // against — each game resolves to both its form-strip set key and its
  // period key, so one `event` axis narrows to exactly the clicked mark's
  // games. Above every early return (Rules of Hooks).
  const periodSeries = useMemo(
    () => buildPeriodSeries({ matches: matchupMatches }),
    [matchupMatches],
  );
  // WR-02 (39.1-REVIEW iteration 2): the URL's `event=` period key resolves
  // by the key's OWN grain rule over this same base, not through whichever
  // grain the ladder picks right now — a key drawn at `week` still lands on
  // its week after a range filter or a sync moves the ladder to `month`.
  // While the grain is unchanged this is exactly the plotted point's games.
  const drillEventKey = axesFromUrl.eventKey;
  const periodEventMatchIds = useMemo(() => {
    if (drillEventKey == null) return undefined;
    const ids = periodPointMatchIdsForKey(drillEventKey, matchupMatches);
    return ids ? new Set(ids) : undefined;
  }, [drillEventKey, matchupMatches]);
  const eventKeysForMatch = useCallback(
    (match: Match): string[] => {
      const setKey = formStripEventKeyForMatch(match);
      return drillEventKey != null && periodEventMatchIds?.has(match.id)
        ? [setKey, drillEventKey]
        : [setKey];
    },
    [drillEventKey, periodEventMatchIds],
  );

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

  // WR-01 (39.1-REVIEW iteration 2): the same claim-follows-horizon rule as
  // Fighter Analysis and Trends — now that the HorizonSwitch drives this
  // page (CR-01), a switch press re-points a followed door's claim to the
  // same insight at the new horizon; one that cannot resolve is shown as
  // not applied by the terminus. Above every early return (Rules of Hooks).
  const hasPageClaim = useCallback(
    (id: string) => insightsForTerminus.some((insight) => insight.id === id),
    [insightsForTerminus],
  );
  const rewriteClaim = useUrlClaimRewriter();
  useClaimFollowsHorizon({
    horizon,
    horizonLoading,
    horizonChangeCount,
    claimId: axesFromUrl.claimId,
    hasClaim: hasPageClaim,
    rewriteClaim,
  });

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
  // hash names it, covering the chart door click. WR-02 (39.1-REVIEW):
  // gated on the data having landed, so a cold load / shared door URL lands
  // on the terminus too.
  useLandingScroll({
    anchorId: MATCHUP_TABLE_ANCHOR_ID,
    ready: !fightersLoading && !matchesLoading,
  });

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

  // Plan 39.1-30 (items 3/5, UI-SPEC §6.1/§6.6): the ONE loading pattern — a
  // page skeleton echoing the loaded page's own section shapes (matrix, the
  // single two-stack PageGrid at rail-4/chart-8, and the results table), so
  // nothing shifts when data lands. Mirrors the loaded block's rail order
  // (stat-row, insight, insight, list) and chart order (chart, list, list)
  // — the SAME two GridCells the loaded branch below renders, same
  // classNames, so the grid never reflows on load. The filter card (fighter
  // pickers + HorizonSwitch) needs resolved fighter selections, so it is
  // intentionally omitted here too.
  if (fightersLoading || matchesLoading) {
    return (
      <PageShell>
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">{t('matchups.loading')}</span>
          <CardSkeleton variant="chart" statusLabel={t('matchups.loading')} />
          <PageGrid>
            <GridCell
              span={4}
              stack
              className="lg:col-span-12 xl:col-span-4 xl:col-start-9 xl:row-start-1"
            >
              <CardSkeleton variant="stat-row" rows={2} statusLabel={t('matchups.loading')} />
              <CardSkeleton variant="insight" statusLabel={t('matchups.loading')} />
              <CardSkeleton variant="insight" statusLabel={t('matchups.loading')} />
              <CardSkeleton variant="list" rows={4} statusLabel={t('matchups.loading')} />
            </GridCell>
            <GridCell
              span={8}
              stack
              className="lg:col-span-12 xl:col-span-8 xl:col-start-1 xl:row-start-1"
            >
              <CardSkeleton variant="chart" statusLabel={t('matchups.loading')} />
              <CardSkeleton variant="list" rows={4} statusLabel={t('matchups.loading')} />
              <CardSkeleton variant="list" rows={4} statusLabel={t('matchups.loading')} />
            </GridCell>
          </PageGrid>
          <CardSkeleton variant="list" rows={5} statusLabel={t('matchups.loading')} />
        </div>
      </PageShell>
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
      <PageShell>
        <div className="flex flex-col gap-6">
          {usingInferredFighters && <ChooseFavoritesPrompt />}
          {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

          {/* UI-SPEC §10.4: one filter row — the fighter picker, a spacer, then the
              page's single HorizonSwitch (INS-02). Never a per-chart control. */}
          <Card>
            <CardContent className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pt-6">
              {/*
                Plan 39.1-32 (item 9, UI-SPEC §10.4 one filter row, §6.6 below
                640): a grid picker — one column below 640px (label over a
                full-width control, 'vs' centred between), fixed EQUAL 15rem
                tracks from 640px up (so both controls stay the same width
                regardless of the selected fighter name's length), 'vs' in the
                auto track between them on the controls' centre line.
              */}
              <div
                data-slot="matchup-pairing-picker"
                className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-[15rem_auto_15rem] sm:items-end sm:gap-x-3"
              >
                {/*
                  WR-07 (39.1-REVIEW.md): the captions are form LABELS tied to
                  their selects (which take their accessible names from
                  them), never h3 headings — two h3s ahead of the page's h2
                  skipped a heading level and cluttered the outline.
                */}
                <div className="flex min-w-0 flex-col gap-1">
                  <label
                    htmlFor={fighterSelectId}
                    data-slot="matchup-pairing-label"
                    className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {t('matchups.you')}
                  </label>
                  <SelectFighter id={fighterSelectId} />
                </div>
                <span
                  data-slot="matchup-pairing-vs"
                  className="justify-self-center text-sm text-muted-foreground sm:flex sm:h-9 sm:items-center sm:justify-self-auto"
                >
                  {t('matchups.vs')}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <label
                    htmlFor={opponentSelectId}
                    data-slot="matchup-pairing-label"
                    className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {t('matchups.opponent')}
                  </label>
                  <SelectOpponent id={opponentSelectId} />
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
            aria-labelledby={effectiveFighter && effectiveOpponent ? pairingHeadingId : undefined}
            className={cn(
              'flex flex-col gap-6 scroll-mt-16',
              isRefetching &&
                'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
            )}
          >
            {/*
              Plan 39.1-30 (item 5, UI-SPEC §5.1/§6.1): the identity row is no
              longer a floating centred line between cards — it is a
              left-aligned overline heading attached to (and directly above)
              the grid it names, in one `flex flex-col gap-3` pair. A
              left-aligned label reads as "this section is about X vs Y",
              never as a decorative banner.
            */}
            {effectiveFighter && effectiveOpponent && (
              <div className="flex flex-col gap-3">
                <h2
                  id={pairingHeadingId}
                  data-slot="matchup-detail-heading"
                  className="flex items-center gap-2"
                >
                  {effectiveFighter.url && (
                    <img src={effectiveFighter.url} alt="" className="size-6 object-contain" />
                  )}
                  {effectiveOpponent.url && (
                    <img src={effectiveOpponent.url} alt="" className="size-6 object-contain" />
                  )}
                  <span className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase">
                    {t('matchups.pairingHeading', {
                      fighter: localizedFighterName(effectiveFighter.id, t),
                      opponent: localizedFighterName(effectiveOpponent.id, t),
                    })}
                  </span>
                </h2>

                {/*
                  UI-SPEC §6.1 (GridCell stack, "No orphan half"), §8.3
                  (advisor span 4 / stage table span 8), §6.6 (single column
                  below 1280, chart cell spans 12 at 1024-1279). Plan 39.1-30
                  replaces the old row-coupled 8+4 trend/stack row, the
                  8+4 PairingOpponents/MatchupOrPlayer row and the separate
                  advisor/stage-table 2-up with ONE PageGrid holding two
                  column stacks, explicitly placed side by side at >=1280 via
                  `xl:col-start`/`xl:row-start` — never a CSS `order` utility,
                  so the visual placement is a property of the grid, not a
                  DOM-order override. DOM stays rail-first at every width
                  (UI-SPEC §14.5 tab order, §6.6 insight-before-chart): the
                  rail (record, insights, matchup-or-player, advisor) always
                  precedes the chart stack (trend, by-opponent, stage
                  breakdown) in markup, which is also the narrow-width
                  reading order — `xl:col-start-9` moves the rail to the
                  right of the chart stack visually without touching DOM
                  order.
                */}
                <PageGrid>
                  <GridCell
                    span={4}
                    stack
                    className="lg:col-span-12 xl:col-start-9 xl:row-start-1 xl:col-span-4"
                  >
                    <MatchWinLossCard matchupMatches={matchupMatches} horizon={horizon} />
                    <MatchupInsights matchupMatches={matchupMatches} />
                    <MatchupOrPlayerCard
                      matchupMatches={matchupMatches}
                      insight={matchupOrPlayerInsight}
                      doorCarry={pairingDoorCarry}
                    />
                    <CounterpickAdvisor matchupMatches={matchupMatches} />
                  </GridCell>
                  <GridCell
                    span={8}
                    stack
                    className="lg:col-span-12 xl:col-start-1 xl:row-start-1 xl:col-span-8"
                  >
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
                      <MatchupChart
                        matchupMatches={matchupMatches}
                        horizon={horizon}
                        periodSeries={periodSeries}
                      />
                    </ChartCard>
                    <PairingOpponents matchupMatches={matchupMatches} />
                    <MatchupStageTable matchupMatches={matchupMatches} />
                  </GridCell>
                </PageGrid>
              </div>
            )}

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
                  eventKeyForMatch={eventKeysForMatch}
                  onClearFilters={() => setDrillDown({})}
                  showDelete
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </PageShell>
    </MatchupsContext.Provider>
  );
}

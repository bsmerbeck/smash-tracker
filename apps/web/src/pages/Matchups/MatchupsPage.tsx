import { useCallback, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter, Insight, Match } from '@smash-tracker/shared';
import { periodPointMatchIdsForKey } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageShell } from '@/components/analytics/PageShell';
import { PageFilterRow } from '@/components/analytics/PageFilterRow';
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
import { buildMatchupPeriodSeries } from './lib/matchupPeriodSeries';
import { createFormStripSetKeyResolver } from '@/lib/formStripEvents';
import { PairingHero } from './components/PairingHero';
import { buildFormNowVerdict, useMatchupFormNow } from './components/MatchupChart';
import {
  MatchupOrPlayerCard,
  buildMatchupOrPlayerVerdict,
  useMatchupOrPlayerInsight,
} from './components/MatchupOrPlayerCard';
import { MatchupInsights } from './components/MatchupInsights';
import { MatchupStageTable } from './components/MatchupStageTable';
import { MATCHUP_MATRIX_ANCHOR_ID, MATCHUP_TABLE_ANCHOR_ID } from './lib/matchupAnchors';
import { MatchupMatrix, MATCHUP_DETAIL_ANCHOR_ID } from './components/MatchupMatrix';
import { CounterpickAdvisor } from './components/CounterpickAdvisor';
import { PairingOpponents } from './components/PairingOpponents';

/**
 * Plan 39.1-44 (sketch 003 A, UI-SPEC §6.1 / §6.6): the two grid cells'
 * responsive classes, shared with the loading skeleton so the grid never
 * reflows on load. The span-8 stack takes the full row below 1280px
 * (`lg:col-span-12`). The span-4 rail is a card COLUMN at every width — beside
 * the stack from xl, under it below. Sketch 003 draws an auto-fit card row
 * between 640 and 1279px, but real-Chrome `guard:layout` (grid-balance,
 * "No orphan half", UI-SPEC §6.1) measured it at 1024x768 as an orphan half
 * (Matchup Insights 566px beside MatchupOrPlayer 222px, ratio 0.29) and a
 * 510px dead gap: unequal-height cards cannot share a row without stretching
 * (banned) or leaving holes, so the locked rule wins over the sketch at that
 * tier (deviation recorded in 39.1-44-SUMMARY).
 */
const STACK_CELL_CLASS = 'lg:col-span-12 xl:col-span-8';
const RAIL_CELL_CLASS = 'lg:col-span-12 xl:col-span-4 flex flex-col gap-4';

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
  const {
    matches,
    allMatches,
    isLoading: matchesLoading,
    isFetching: matchesFetching,
    filterActive,
  } = useFilteredMatches();
  const {
    horizon,
    setHorizon,
    isLoading: horizonLoading,
    explicitChangeCount: horizonChangeCount,
  } = useHorizon();
  // Plan 39.1-44: ONE clock for the page — the FormNow insight, the hero's
  // horizon figures and its share bar resolve the same windows (D-06 / D-12).
  // A lazy `useState` initializer is this codebase's sanctioned one-time read
  // of `Date.now()` (React Compiler forbids a bare call in the render body).
  const [nowMs] = useState(() => Date.now());

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
  const formNowInsight = useMatchupFormNow({ matchupMatches, horizon, nowMs });

  // CR-02 (39.1-REVIEW): the ONE period series `MatchupChart` plots AND this
  // page's terminus resolves a trend-point drill (`event=<point.key>`)
  // against — each game resolves to both its form-strip set key and its
  // period key, so one `event` axis narrows to exactly the clicked mark's
  // games. Above every early return (Rules of Hooks).
  // Plan 39.1-41 (PD-41-1): quarterly — `buildMatchupPeriodSeries`, the ONE
  // scoped builder the chart's own tests exercise.
  const periodSeries = useMemo(() => buildMatchupPeriodSeries(matchupMatches), [matchupMatches]);
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
  // Plan 39.1-42 (PD-42-4): the strip's set keys over the SAME
  // `matchupMatches` MatchupChart builds its strip from — a manual play
  // session is one set, a legacy `game:<id>` key still resolves.
  const stripSetKeysForMatch = useMemo(
    () => createFormStripSetKeyResolver(matchupMatches),
    [matchupMatches],
  );
  const eventKeysForMatch = useCallback(
    (match: Match): string[] => {
      const setKeys = stripSetKeysForMatch(match);
      return drillEventKey != null && periodEventMatchIds?.has(match.id)
        ? [...setKeys, drillEventKey]
        : setKeys;
    },
    [drillEventKey, periodEventMatchIds, stripSetKeysForMatch],
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

  // Plan 39.1-26 (gap closure, Task 1): the hero's counted-games door (plan
  // 39.1-44 moved it from the chart head to the hero's last row) —
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
  // page skeleton echoing the loaded page's own section shapes so nothing
  // shifts when data lands. Plan 39.1-44 re-shapes it to sketch A: the single
  // PageGrid's span-8 stack [hero chart, By opponent list] then the span-4
  // rail (three insight cards + the stage list), then the matrix and results
  // lists — the SAME two GridCells, classNames and order the loaded branch
  // renders, so the grid never reflows on load. The filter row (fighter
  // pickers + HorizonSwitch) needs resolved fighter selections, so it is
  // intentionally omitted here too.
  if (fightersLoading || matchesLoading) {
    return (
      <PageShell>
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">{t('matchups.loading')}</span>
          <PageGrid>
            <GridCell span={8} stack className={STACK_CELL_CLASS}>
              <CardSkeleton variant="chart" statusLabel={t('matchups.loading')} />
              <CardSkeleton variant="list" rows={4} statusLabel={t('matchups.loading')} />
            </GridCell>
            <GridCell span={4} className={RAIL_CELL_CLASS}>
              <CardSkeleton variant="insight" statusLabel={t('matchups.loading')} />
              <CardSkeleton variant="insight" statusLabel={t('matchups.loading')} />
              <CardSkeleton variant="insight" statusLabel={t('matchups.loading')} />
              <CardSkeleton variant="list" rows={4} statusLabel={t('matchups.loading')} />
            </GridCell>
          </PageGrid>
          <CardSkeleton variant="list" rows={3} statusLabel={t('matchups.loading')} />
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

  // Plan 39.1-44 (PD-44-4, sketch 003 `.filters`): ONE unboxed filter row with
  // no visible title (the pairing hero's heading is the page h1) — the fighter
  // picker, a spacer, then the page's single HorizonSwitch (INS-02). Never a
  // per-chart control.
  const filterRow = (
    <PageFilterRow
      leading={
        /*
          Plan 39.1-32 (item 9, UI-SPEC §10.4 one filter row, §6.6 below
          640): a grid picker — one column below 640px (label over a
          full-width control, 'vs' centred between), fixed EQUAL 15rem
          tracks from 640px up (so both controls stay the same width
          regardless of the selected fighter name's length), 'vs' in the
          auto track between them on the controls' centre line.
        */
        <div
          data-slot="matchup-pairing-picker"
          className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-[15rem_auto_15rem] sm:items-end sm:gap-x-3"
        >
          {/*
            WR-07 (39.1-REVIEW.md): the captions are form LABELS tied to
            their selects (which take their accessible names from them),
            never h3 headings.
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
      }
      trailing={<HorizonSwitch />}
    />
  );

  // Mirrors `MatchupOrPlayerCard`'s own render rule (`!insight || state ===
  // 'hidden'` renders nothing) so its slot wrapper exists only with the card.
  const showsMatchupOrPlayer =
    matchupOrPlayerInsight != null && matchupOrPlayerInsight.state !== 'hidden';

  return (
    <MatchupsContext.Provider value={contextValue}>
      <PageShell filterRow={filterRow}>
        {usingInferredFighters && <ChooseFavoritesPrompt />}
        {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

        {/* Plan 39.1-20: a background refetch (matches already loaded once)
            holds this whole detail block at reduced opacity instead of
            flashing a skeleton — the hero's MatchupChart body
            (`data-slot="matchup-chart-body"`, which exists only once this
            branch is reached) doubles as this route's layout-oracle loaded
            marker. */}
        {/*
          WR-06 (39.1-REVIEW.md): a <section>, not a div — ARIA prohibits
          naming the generic role, so aria-labelledby on a div was never
          exposed. A section becomes a named region exactly when the
          pairing heading (the hero's h1) exists to name it.
        */}
        <section
          id={MATCHUP_DETAIL_ANCHOR_ID}
          aria-labelledby={effectiveFighter && effectiveOpponent ? pairingHeadingId : undefined}
          className={cn(
            'flex flex-col gap-6 scroll-mt-16',
            isRefetching &&
              'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
          )}
        >
          {/*
            Plan 39.1-44 (sketch 003 A `renderA`, PD-44-1, UI-SPEC §6.1 "No
            orphan half", §6.6): ONE PageGrid — a span-8 stack [pairing hero,
            By opponent] beside a span-4 rail [Matchup Insights,
            MatchupOrPlayer, Counterpick Advisor, Stage breakdown] at
            >= 1280px; below 1280 the stack spans 12 and the rail is an
            auto-fit card row (one column on a phone). DOM order is the
            reading order at EVERY width — the hero first — and no
            placement utility (`col-start` / `row-start` / `order`) moves
            anything: the side-by-side is a property of the grid. The
            `section-order` oracle family proves it in a real browser.
          */}
          {effectiveFighter && effectiveOpponent && (
            <PageGrid>
              <GridCell span={8} stack className={STACK_CELL_CLASS}>
                <PairingHero
                  headingId={pairingHeadingId}
                  fighter={effectiveFighter}
                  opponent={effectiveOpponent}
                  matchupMatches={matchupMatches}
                  formNowInsight={formNowInsight}
                  gamesDoor={formNowGamesDoor}
                  periodSeries={periodSeries}
                  horizon={horizon}
                  setHorizon={setHorizon}
                  isLoading={horizonLoading || matchesLoading}
                  nowMs={nowMs}
                />
                <div data-slot="pairing-opponents">
                  <PairingOpponents matchupMatches={matchupMatches} nowMs={nowMs} />
                </div>
              </GridCell>
              <GridCell span={4} slot="matchups-rail" className={RAIL_CELL_CLASS}>
                <div data-slot="matchup-insights">
                  <MatchupInsights matchupMatches={matchupMatches} />
                </div>
                {showsMatchupOrPlayer && (
                  <div data-slot="matchup-or-player">
                    <MatchupOrPlayerCard
                      matchupMatches={matchupMatches}
                      insight={matchupOrPlayerInsight}
                      doorCarry={pairingDoorCarry}
                    />
                  </div>
                )}
                <div data-slot="counterpick-advisor">
                  <CounterpickAdvisor matchupMatches={matchupMatches} />
                </div>
                <div data-slot="stage-breakdown">
                  <MatchupStageTable matchupMatches={matchupMatches} />
                </div>
              </GridCell>
            </PageGrid>
          )}

          {/* Plan 39.1-44 (PD-44-1, sketch 003 A): the matrix is navigation,
              not the answer — demoted below the pairing; the hero's "Other
              pairings" door targets it. */}
          <div data-slot="matchup-matrix" id={MATCHUP_MATRIX_ANCHOR_ID} className="scroll-mt-16">
            <MatchupMatrix matches={matches} />
          </div>

          <div data-slot="matchup-results" id={MATCHUP_TABLE_ANCHOR_ID} className="scroll-mt-16">
            <Card>
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
        </section>
      </PageShell>
    </MatchupsContext.Provider>
  );
}

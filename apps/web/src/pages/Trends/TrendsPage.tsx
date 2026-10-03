import { useCallback, useMemo } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { resolveEntryTiers, type Insight, type Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { PageFilterRow } from '@/components/analytics/PageFilterRow';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { resolveInsightClaim } from '@/components/analytics/insightDoors';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useHorizon } from '@/hooks/useHorizon';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useClaimFollowsHorizon, useUrlClaimRewriter } from '@/hooks/useClaimFollowsHorizon';
import { useLandingScroll } from '@/hooks/useLandingScroll';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { cn } from '@/lib/utils';
import { stagesById } from '@/data/stages';
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
import { createFormStripSetKeyResolver } from '@/lib/formStripEvents';
import { TrendsHero } from './components/TrendsHero';
import {
  TrendsReadsRail,
  buildTrendsVerdict,
  useTrendsInsights,
} from './components/TrendsReadsRail';
import { CareerTimelineCard } from './components/CareerTimelineCard';
import { SessionsAndTilt } from './components/SessionsAndTilt';
import { RecentEvents } from './components/RecentEvents';
import { SettingComparison } from './components/SettingComparison';
import { MatchTypeMix } from './components/MatchTypeMix';
import { PlayRhythmCard } from './components/PlayRhythmCard';
import { PlayRhythmHeat } from './components/PlayRhythmHeat';
import {
  useTrendsCardInsights,
  buildMixShiftVerdict,
  buildPlayRhythmVerdict,
} from './lib/useTrendsCardInsights';

const GAMES_ANCHOR_ID = 'games';

/**
 * Plan 39.1-38 (design-audit item 9; UI-SPEC §8.2 "insight before chart"):
 * below lg the cells stack in DOM order — stat row, reads rail, career
 * timeline, [Sessions, Recent events], [Setting, Mix] — so a phone reads the
 * insight before the chart. At lg these placement utilities restore the
 * desktop composition (stat row row 1, timeline row 2, the three 4-col cells
 * row 3 with the reads in the centre), never a CSS `order` utility; the
 * loading skeleton uses the same constants.
 */
const TRENDS_HERO_PLACEMENT = 'lg:row-start-1';
const TRENDS_TIMELINE_PLACEMENT = 'lg:row-start-2';
const TRENDS_LEFT_STACK_PLACEMENT = 'lg:col-start-1 lg:row-start-3';
const TRENDS_READS_PLACEMENT = 'lg:col-start-5 lg:row-start-3';
const TRENDS_RIGHT_STACK_PLACEMENT = 'lg:col-start-9 lg:row-start-3';
/**
 * Plan 41-03 (B1, DD-41-05, UI-SPEC 6.3): row 4, "Play rhythm", its own `PageGrid` UNDER the rails grid.
 * Row 3's three rails are content-hugging and ragged by design (`items-start`, never stretched), so a row
 * placed inside that same grid would sit below cells that end up to ~280px short of it - a dead gap the
 * layout oracle rightly flags. A section of its own (like the `#games` terminus that follows it) keeps
 * row 3 a self-contained rail row and row 4 a balanced 8 + 4 pair. DOM order is read, then heat (a phone
 * reads the insight before the chart). At 1024-1279 the read spans 12 above a 12-col heat; from 1280 the
 * heat is 8 cols at the left and the read 4 cols at the right, both in this grid's first row.
 */
const TRENDS_RHYTHM_READ_PLACEMENT =
  'lg:col-span-12 lg:col-start-1 lg:row-start-1 xl:col-span-4 xl:col-start-9';
const TRENDS_RHYTHM_CHART_PLACEMENT =
  'lg:col-span-12 lg:col-start-1 lg:row-start-2 xl:col-span-8 xl:row-start-1';

/**
 * Trends, recomposed onto the insight-first Pro-desk grid contract (UI-SPEC
 * §8.2, TRND-02, INS-05): `PageShell` -> one filter row (title + `HorizonSwitch`)
 * -> `PageGrid` rows. Own-account only (38 D-04) — every link this page
 * builds is an own-account link, never branched on coach state.
 *
 * Row 1 is the five-figure `StatRow` hero. Row 2 is the 12-col career
 * timeline (`CareerTimelineCard`, UI-SPEC §12.1, sketch 002-C) — plan
 * 39.1-34 retired the interim chart.js Rating Curve / Monthly Performance
 * slot here (owner decision 2026-09-25, superseding D-02 for the timeline
 * only). Row 3 is the three 4-col
 * rails: left (Sessions & Tilt, Recent events), centre (`TrendsReadsRail`,
 * the engine-backed reads), right (Setting comparison, Match-type mix). The
 * six-column `Tournaments` table is removed from this page (UI-SPEC §8.2);
 * plan 39.2-07 then deleted the component itself once `TournamentsTable`
 * replaced it on `/tournaments`.
 *
 * Plan 41-03 (B1, DD-41-05): row 4, "Play rhythm" — the `PlayRhythm` read
 * (4 cols) and the year x month activity heat (8 cols), under the three rails
 * and above the `#games` terminus; not mounted at 0 games in scope.
 *
 * The page-level `RatingModelNote` banner is REMOVED here (UI-SPEC §8.2): it
 * is demoted to a secondary door on `TrendsReadsRail`'s rating-move card.
 */
export function TrendsPage() {
  const { t, i18n } = useTranslation();
  const [searchParams] = useSearchParams();
  const { matches, allMatches, isLoading, isFetching, filterActive } = useFilteredMatches();
  const {
    horizon,
    isLoading: horizonLoading,
    explicitChangeCount: horizonChangeCount,
  } = useHorizon();

  const stageIds = useMemo(() => new Set(stagesById.keys()), []);
  // D-05: a tolerant read of every drill-down axis currently in the URL —
  // this page writes none of them itself today (only a rail card's
  // counted-games door writes `claim=`), but the read side and the
  // conditional terminus row are wired now so the read half of DD-09's
  // contract matches every other insight-first surface (UI-SPEC §10.3).
  const axesFromUrl = useMemo(
    () => readDrillDownParams(searchParams, { stageIds }),
    [searchParams, stageIds],
  );
  const hasDrillAxis =
    axesFromUrl.fighterId != null ||
    axesFromUrl.vsFighterId != null ||
    axesFromUrl.stageId != null ||
    axesFromUrl.eventKey != null ||
    axesFromUrl.from != null ||
    axesFromUrl.to != null ||
    axesFromUrl.claimId != null;

  // WR-C02 (39.1-REVIEW.md) precedent, applied here for the SAME reason as
  // every other insight-first page: `FilteredMatchList`'s D-16 memo keys on
  // reference identity, so both `terminusAxes` and `sortedMatches` must be
  // memoized, declared BEFORE this component's `isLoading`/`allMatches`
  // early returns below (Rules of Hooks).
  const terminusAxes: DrillDownAxes = useMemo(
    () => ({
      fighterId: axesFromUrl.fighterId,
      vsFighterId: axesFromUrl.vsFighterId,
      stageId: axesFromUrl.stageId,
      eventKey: axesFromUrl.eventKey,
      from: axesFromUrl.from,
      to: axesFromUrl.to,
      claimId: axesFromUrl.claimId,
    }),
    [
      axesFromUrl.fighterId,
      axesFromUrl.vsFighterId,
      axesFromUrl.stageId,
      axesFromUrl.eventKey,
      axesFromUrl.from,
      axesFromUrl.to,
      axesFromUrl.claimId,
    ],
  );
  const sortedMatches = useMemo(() => sortMatchesNewestFirst(matches), [matches]);
  // Plan 39.1-42 (PD-42-4): the thin strip's set keys over the SAME
  // `matches` CareerTimelineCard builds its strip from — a manual play
  // session is one set, a legacy `game:<id>` key still resolves.
  const stripSetKeysForMatch = useMemo(() => createFormStripSetKeyResolver(matches), [matches]);

  // Plan 41-04 (B2, DD-41-08): the ONE tier resolution — every registry entry against ALL own-account
  // matches (the 39.2 resolve-once rule: never a filtered subset, or an out-of-range match would
  // un-assign and a tier would resolve off a partial record). The career timeline's diamonds and the
  // terminus' `event=<entryKey>` resolver both read it; Phase 42's recorded tiers arrive through the
  // same resolver with no change here.
  const { data: tournamentEntries } = useTournamentEntries();
  const resolvedEntries = useMemo(
    () => resolveEntryTiers(tournamentEntries ?? [], allMatches),
    [tournamentEntries, allMatches],
  );
  // RESEARCH correction 9: a diamond's `event=<entryKey>` must list exactly that entry's games, so a
  // match assigned to a resolved entry also answers to the entry's key (after its strip set keys).
  // Memoised for the terminus' D-16 reference check (WR-C02).
  const entryKeyByMatchId = useMemo(() => {
    const byMatch = new Map<string, string>();
    for (const resolved of resolvedEntries) {
      for (const match of resolved.matches) {
        byMatch.set(match.id, resolved.entryKey);
      }
    }
    return byMatch;
  }, [resolvedEntries]);
  const eventKeyForMatch = useMemo(
    () => (match: Match) => {
      const setKeys = stripSetKeysForMatch(match);
      const entryKey = entryKeyByMatchId.get(match.id);
      return entryKey === undefined ? setKeys : [...setKeys, entryKey];
    },
    [stripSetKeysForMatch, entryKeyByMatchId],
  );

  // Plan 39.1-24 (gap closure, Task 2, DD-09 reachability): the ONE insight
  // computation this page shares with `TrendsReadsRail` (which takes the
  // result as props below) and this page's own NEW page-level
  // `FilteredMatchList` terminus (`resolveClaim`/`claimSummary`) — mirrors
  // `FighterAnalysisPage.tsx`'s Task 1 wiring. Called unconditionally, above
  // every early return.
  const {
    insights: trendsInsights,
    dismissedIds,
    dismiss,
    restoreAll,
  } = useTrendsInsights({ matches, horizon });
  // Plan 39.1-27 (gap closure, SC4/INS-04): the ONE `settingGap`/`mixShift`/
  // `volumeForm` computation this page shares with `SettingComparison`/
  // `MatchTypeMix` (which take the result as props) and its own terminus
  // below — called unconditionally, above every early return, beside
  // `useTrendsInsights`.
  const cardInsights = useTrendsCardInsights({ matches, horizon });
  // The hero's/rail's own insights lead `pageInsights`, followed by the
  // three card insights (non-null only) — one array, one terminus resolver,
  // matching `FighterAnalysisPage.tsx`'s `pageInsights` precedent.
  const pageInsights = useMemo(() => {
    const cards = [
      cardInsights.settingGap,
      cardInsights.mixShift,
      cardInsights.volumeForm,
      cardInsights.playRhythm,
    ].filter((insight): insight is Insight => insight != null);
    return [...trendsInsights, ...cards];
  }, [
    trendsInsights,
    cardInsights.settingGap,
    cardInsights.mixShift,
    cardInsights.volumeForm,
    cardInsights.playRhythm,
  ]);
  const insightById = useMemo(
    () => new Map(pageInsights.map((insight) => [insight.id, insight])),
    [pageInsights],
  );
  const accountNameForClaim = t('trends.title');
  const claimSummary =
    axesFromUrl.claimId != null
      ? (() => {
          const insight = insightById.get(axesFromUrl.claimId!);
          if (!insight) return undefined;
          // Plan 39.1-27 (gap closure, Task 2): mixShift's own raw
          // `matchType` literal must never reach the summary — the SAME
          // `buildMixShiftVerdict` the line itself uses.
          if (insight.templateId === 'mixShift') return buildMixShiftVerdict(insight, t);
          // Plan 41-03: playRhythm's month and share arrive as numbers; the host formats them.
          if (insight.templateId === 'playRhythm') {
            return buildPlayRhythmVerdict(insight, t, i18n.language);
          }
          return buildTrendsVerdict(insight, t, accountNameForClaim);
        })()
      : undefined;
  // WR-C02 (39.1-REVIEW.md) precedent, re-applied: an inline arrow function
  // passed as `resolveClaim` would be a NEW reference every render, breaking
  // `FilteredMatchList`'s D-16 memo on every unrelated parent re-render.
  // Memoized by `pageInsights` alone — the only thing this closure
  // actually reads.
  const resolveClaimForTerminus = useCallback(
    (claimId: string, ms: Match[]) =>
      resolveInsightClaim({ claimId, insights: pageInsights, matches: ms }),
    [pageInsights],
  );

  // Plan 39.1-27: `AppRouter.tsx` uses `BrowserRouter`, which performs no
  // hash scroll of its own, and this terminus mounts conditionally — so an
  // effect after mount is the only place the scroll can land. Fires once per
  // navigation whenever the hash names this page's terminus AND the
  // terminus is actually mounted (`hasDrillAxis`). No state update inside
  // this effect (react-compiler lint rule). Mirrors
  // `FighterAnalysisPage.tsx`'s plan 39.1-25 landing effect.
  //
  // WR-02 (39.1-REVIEW): gated on `ready` (data landed, terminus mounted) so
  // a cold load, refresh or shared door URL lands on the terminus too.
  const location = useLocation();
  useLandingScroll({ anchorId: GAMES_ANCHOR_ID, ready: !isLoading && hasDrillAxis });

  // WR-01 (39.1-REVIEW): the terminus mounts only while a drill axis is in
  // the URL, and this page's doors write one — Clear filters drops every
  // axis the terminus reads (and the `#games` hash), which unmounts it.
  const navigate = useNavigate();
  /** The current search minus every axis this page's terminus narrows by — the ONE spelling every writer below shares. */
  function searchWithoutDrillAxes(): URLSearchParams {
    const params = new URLSearchParams(searchParams);
    for (const key of [
      DRILL_DOWN_FIGHTER_PARAM,
      DRILL_DOWN_VS_PARAM,
      DRILL_DOWN_STAGE_PARAM,
      DRILL_DOWN_EVENT_PARAM,
      DRILL_DOWN_FROM_PARAM,
      DRILL_DOWN_TO_PARAM,
      DRILL_DOWN_CLAIM_PARAM,
    ]) {
      params.delete(key);
    }
    return params;
  }
  function handleClearFilters(): void {
    const search = searchWithoutDrillAxes().toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' });
  }

  // Plan 39.1-35 (UI-SPEC §10.3, §12.1 "click a period → from / to →
  // FilteredMatchList"): a career-timeline period or month drills through
  // Phase 38's URL contract, built exactly like FighterAnalysisPage's
  // `handleHeroDrill` — a drill REPLACES any prior narrowing or claim axis,
  // keeps every other param, and lands on this page's own terminus. The
  // page's own pathname, never a subject prefix (Trends is own-account only,
  // 38 D-04).
  function handleTimelineDrill({ fromMs, toMs }: { fromMs: number; toMs: number }): void {
    const params = searchWithoutDrillAxes();
    for (const [key, value] of buildDrillDownSearch({ from: fromMs, to: toMs })) {
      params.set(key, value);
    }
    navigate({
      pathname: location.pathname,
      search: `?${params.toString()}`,
      hash: `#${GAMES_ANCHOR_ID}`,
    });
  }

  // Plan 39.1-35 (UI-SPEC §10.1 FormStrip set → `event=<key>`): a thin
  // account's per-game strip set drills like every other FormStrip host's —
  // the terminus below resolves the key through the SAME
  // `createFormStripSetKeyResolver` rule over the strip's own base, so the
  // list is exactly that set's games (plan 39.1-42: a session set too).
  function handleTimelineSetDrill(setKey: string): void {
    const params = searchWithoutDrillAxes();
    for (const [key, value] of buildDrillDownSearch({ eventKey: setKey })) {
      params.set(key, value);
    }
    navigate({
      pathname: location.pathname,
      search: `?${params.toString()}`,
      hash: `#${GAMES_ANCHOR_ID}`,
    });
  }

  // Plan 41-04 (B2, DD-41-08): a career-timeline event diamond drills to exactly that event's games —
  // `event=<entryKey>`, the key the terminus' `eventKeyForMatch` above answers to.
  function handleTimelineEventDrill(entryKey: string): void {
    const params = searchWithoutDrillAxes();
    for (const [key, value] of buildDrillDownSearch({ eventKey: entryKey })) {
      params.set(key, value);
    }
    navigate({
      pathname: location.pathname,
      search: `?${params.toString()}`,
      hash: `#${GAMES_ANCHOR_ID}`,
    });
  }

  // WR-01 (39.1-REVIEW): a claim id ends in its horizon — re-point it to the
  // same insight at a new horizon; one that cannot resolve is shown as not
  // applied by the terminus. Mirrors `FighterAnalysisPage.tsx`.
  const hasPageClaim = useCallback((id: string) => insightById.has(id), [insightById]);
  const rewriteClaim = useUrlClaimRewriter();
  useClaimFollowsHorizon({
    horizon,
    horizonLoading,
    horizonChangeCount,
    claimId: axesFromUrl.claimId,
    hasClaim: hasPageClaim,
    rewriteClaim,
  });

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern — a page
  // skeleton built from the SAME PageGrid spans as the loaded
  // hero(12)/timeline(12)/rails(4+4+4) layout, so nothing shifts when data
  // lands. The filter row here is only a static title + HorizonSwitch (no
  // data-derived props), but is still omitted for consistency with every
  // other page in this plan.
  if (isLoading) {
    return (
      <PageShell>
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">{t('trends.loading')}</span>
          <PageGrid>
            <GridCell span={12} className={TRENDS_HERO_PLACEMENT}>
              <CardSkeleton variant="stat-row" rows={5} statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={4} className={TRENDS_READS_PLACEMENT}>
              <CardSkeleton variant="insight" statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={12} className={TRENDS_TIMELINE_PLACEMENT}>
              <CardSkeleton variant="chart" statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={4} stack className={TRENDS_LEFT_STACK_PLACEMENT}>
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={4} stack className={TRENDS_RIGHT_STACK_PLACEMENT}>
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
            </GridCell>
          </PageGrid>
          <PageGrid>
            <GridCell span={4} className={TRENDS_RHYTHM_READ_PLACEMENT}>
              <CardSkeleton variant="insight" statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={8} className={TRENDS_RHYTHM_CHART_PLACEMENT}>
              <CardSkeleton variant="chart" statusLabel={t('trends.loading')} />
            </GridCell>
          </PageGrid>
        </div>
      </PageShell>
    );
  }

  // Plan 39.1-20: a background refetch (matches already loaded once) holds
  // the previous frame at reduced opacity instead of flashing a skeleton.
  const isRefetching = isFetching && !isLoading;

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">{t('trends.noMatches')}</h2>
        <Button asChild className="mt-2">
          <Link to="/dashboard">{t('common.goToDashboard')}</Link>
        </Button>
      </div>
    );
  }

  // Plan 39.1-38 (design-audit item 6; UI-SPEC §10.4, sketch 002-C
  // `.filters`): ONE unboxed row — title, spacer, HorizonSwitch.
  const filterRow = <PageFilterRow title={t('trends.title')} trailing={<HorizonSwitch />} />;

  // Plan 41-03: row 4 is not mounted at 0 games in scope (the page-level no-matches view covers it);
  // a dismissed read leaves the row's heat in place.
  const showPlayRhythm =
    matches.length > 0 &&
    cardInsights.playRhythm != null &&
    !dismissedIds.includes(cardInsights.playRhythm.id);

  const refetchingClass = cn(
    isRefetching && 'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
  );
  const showRhythmGrid = matches.length > 0 || hasDrillAxis;

  return (
    <PageShell filterRow={filterRow}>
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <PageGrid className={refetchingClass}>
        {/* Plan 39.1-38 (UI-SPEC §8.2 "insight before chart"): DOM order is
            the phone reading order — stat row, reads, timeline, then the two
            rail stacks; lg placement keeps the desktop composition. */}
        <GridCell span={12} className={TRENDS_HERO_PLACEMENT}>
          <TrendsHero matches={matches} horizon={horizon} />
        </GridCell>

        <GridCell span={4} className={TRENDS_READS_PLACEMENT}>
          <TrendsReadsRail
            insights={trendsInsights}
            dismissedIds={dismissedIds}
            dismiss={dismiss}
            restoreAll={restoreAll}
            horizon={horizon}
          />
        </GridCell>

        <GridCell span={12} className={TRENDS_TIMELINE_PLACEMENT}>
          <CareerTimelineCard
            matches={matches}
            horizon={horizon}
            onSelectPeriod={handleTimelineDrill}
            onSelectSet={handleTimelineSetDrill}
            resolvedEntries={resolvedEntries}
            onSelectEventMarker={handleTimelineEventDrill}
          />
        </GridCell>

        <GridCell span={4} stack className={TRENDS_LEFT_STACK_PLACEMENT}>
          <SessionsAndTilt matches={matches} />
          <RecentEvents matches={matches} allMatches={allMatches} />
        </GridCell>

        <GridCell span={4} stack className={TRENDS_RIGHT_STACK_PLACEMENT}>
          <SettingComparison
            matches={matches}
            horizon={horizon}
            settingGapInsight={cardInsights.settingGap}
          />
          <MatchTypeMix
            matches={matches}
            horizon={horizon}
            mixShiftInsight={cardInsights.mixShift}
            volumeFormInsight={cardInsights.volumeForm}
          />
        </GridCell>
      </PageGrid>

      {showRhythmGrid && (
        <PageGrid className={refetchingClass}>
          {showPlayRhythm && cardInsights.playRhythm && (
            <GridCell span={4} slot="trends-rhythm-read" className={TRENDS_RHYTHM_READ_PLACEMENT}>
              <PlayRhythmCard
                insight={cardInsights.playRhythm}
                onDismiss={() => dismiss(cardInsights.playRhythm!.id)}
              />
            </GridCell>
          )}

          {/* Plan 41-03: the heat follows the read in the DOM (a phone reads the insight first); the
            placement constants put it beside the read from 1280 and under it from 1024. */}
          {matches.length > 0 && (
            <GridCell span={8} slot="trends-rhythm-chart" className={TRENDS_RHYTHM_CHART_PLACEMENT}>
              <PlayRhythmHeat matches={matches} onSelectMonth={handleTimelineDrill} />
            </GridCell>
          )}

          {hasDrillAxis && (
            <GridCell span={12}>
              <Card id={GAMES_ANCHOR_ID} className="scroll-mt-16">
                <CardHeader>
                  <CardTitle>{t('matchups.results')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <FilteredMatchList
                    matches={sortedMatches}
                    axes={terminusAxes}
                    eventKeyForMatch={eventKeyForMatch}
                    resolveClaim={resolveClaimForTerminus}
                    claimSummary={claimSummary}
                    onClearFilters={handleClearFilters}
                    showDelete
                  />
                </CardContent>
              </Card>
            </GridCell>
          )}
        </PageGrid>
      )}
    </PageShell>
  );
}

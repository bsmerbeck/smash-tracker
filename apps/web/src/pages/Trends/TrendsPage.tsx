import { useCallback, useEffect, useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Insight, Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { resolveInsightClaim } from '@/components/analytics/insightDoors';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useHorizon } from '@/hooks/useHorizon';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { cn } from '@/lib/utils';
import { stagesById } from '@/data/stages';
import {
  readDrillDownParams,
  sortMatchesNewestFirst,
  type DrillDownAxes,
} from '@/lib/drillDownParams';
import { TrendsHero } from './components/TrendsHero';
import {
  TrendsReadsRail,
  buildTrendsVerdict,
  useTrendsInsights,
} from './components/TrendsReadsRail';
import { CareerTimelineSlot } from './components/CareerTimelineSlot';
import { SessionsAndTilt } from './components/SessionsAndTilt';
import { RecentEvents } from './components/RecentEvents';
import { SettingComparison } from './components/SettingComparison';
import { MatchTypeMix } from './components/MatchTypeMix';
import { useTrendsCardInsights, buildMixShiftVerdict } from './lib/useTrendsCardInsights';

const GAMES_ANCHOR_ID = 'games';

/**
 * Trends, recomposed onto the insight-first Pro-desk grid contract (UI-SPEC
 * §8.2, TRND-02, INS-05): `PageShell` -> one filter row (title + `HorizonSwitch`)
 * -> `PageGrid` rows. Own-account only (38 D-04) — every link this page
 * builds is an own-account link, never branched on coach state.
 *
 * Row 1 is the five-figure `StatRow` hero. Row 2 is the interim
 * career-timeline slot (`CareerTimelineSlot`: the existing `RatingCurve`/
 * `MonthlyPerformance` charts at 6+6, D-02/D-13 — Phase 41 replaces this with
 * the bound career-timeline chart, UI-SPEC §12.1). Row 3 is the three 4-col
 * rails: left (Sessions & Tilt, Recent events), centre (`TrendsReadsRail`,
 * the engine-backed reads), right (Setting comparison, Match-type mix). The
 * six-column `Tournaments` table is removed from this page (UI-SPEC §8.2) —
 * `Tournaments.tsx` itself stays committed, since `TournamentsPage.tsx`
 * still imports it.
 *
 * The page-level `RatingModelNote` banner is REMOVED here (UI-SPEC §8.2): it
 * is demoted to a secondary door on `TrendsReadsRail`'s rating-move card.
 */
export function TrendsPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { matches, allMatches, isLoading, isFetching, filterActive } = useFilteredMatches();
  const { horizon } = useHorizon();

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
    const cards = [cardInsights.settingGap, cardInsights.mixShift, cardInsights.volumeForm].filter(
      (insight): insight is Insight => insight != null,
    );
    return [...trendsInsights, ...cards];
  }, [trendsInsights, cardInsights.settingGap, cardInsights.mixShift, cardInsights.volumeForm]);
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
          return insight.templateId === 'mixShift'
            ? buildMixShiftVerdict(insight, t)
            : buildTrendsVerdict(insight, t, accountNameForClaim);
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
  const location = useLocation();
  useEffect(() => {
    if (location.hash === `#${GAMES_ANCHOR_ID}` && hasDrillAxis) {
      document
        .getElementById(GAMES_ANCHOR_ID)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [location.key, location.hash, hasDrillAxis]);

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
            <GridCell span={12}>
              <CardSkeleton variant="stat-row" rows={5} statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={12}>
              <CardSkeleton variant="chart" statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={4} stack>
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={4}>
              <CardSkeleton variant="insight" statusLabel={t('trends.loading')} />
            </GridCell>
            <GridCell span={4} stack>
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
              <CardSkeleton variant="list" rows={3} statusLabel={t('trends.loading')} />
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

  const filterRow = (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-6 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('trends.title')}</h1>
        <HorizonSwitch />
      </CardContent>
    </Card>
  );

  return (
    <PageShell filterRow={filterRow}>
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <PageGrid
        className={cn(
          isRefetching &&
            'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
        )}
      >
        <GridCell span={12}>
          <TrendsHero matches={matches} horizon={horizon} />
        </GridCell>

        <GridCell span={12}>
          <CareerTimelineSlot matches={matches} />
        </GridCell>

        <GridCell span={4} stack>
          <SessionsAndTilt matches={matches} />
          <RecentEvents matches={matches} />
        </GridCell>

        <GridCell span={4}>
          <TrendsReadsRail
            insights={trendsInsights}
            dismissedIds={dismissedIds}
            dismiss={dismiss}
            restoreAll={restoreAll}
            horizon={horizon}
          />
        </GridCell>

        <GridCell span={4} stack>
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
                  resolveClaim={resolveClaimForTerminus}
                  claimSummary={claimSummary}
                  showDelete
                />
              </CardContent>
            </Card>
          </GridCell>
        )}
      </PageGrid>
    </PageShell>
  );
}

import { useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter, Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { cn } from '@/lib/utils';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { resolveInsightClaim } from '@/components/analytics/insightDoors';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useHorizon } from '@/hooks/useHorizon';
import { useClaimFollowsHorizon, useUrlClaimRewriter } from '@/hooks/useClaimFollowsHorizon';
import { useSortedFighters } from '@/hooks/useFighterName';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { ChooseFavoritesPrompt } from '@/components/ChooseFavoritesPrompt';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { inferFighterIdsFromMatches } from '@/lib/inferredFighters';
import {
  readDrillDownParams,
  sortMatchesNewestFirst,
  type DrillDownAxes,
} from '@/lib/drillDownParams';
import { AddMatchForm } from '@/pages/Dashboard/components/AddMatchForm';
import { MatchTable } from './components/MatchTable';
import { RosterUsage } from './components/RosterUsage';
import { StageBreakdown } from './components/StageBreakdown';
import {
  MatchDataRail,
  buildMatchDataVerdict,
  useMatchDataInsights,
} from './components/MatchDataRail';

const GAMES_ANCHOR_ID = 'games';

/**
 * Ports legacy/src/screens/MatchData. Rebuilt onto the insight-first grid
 * contract (T-39.1-16, UI-SPEC §8.4, owner note 7): `PageShell` -> one filter
 * row (`HorizonSwitch`) -> `PageGrid` rows — the match table full-width, the
 * roster/stage cards an 8-col stack beside the 4-col roster rail, and a
 * conditional `FilteredMatchList` terminus row (T-39.1-14's identical
 * read-side-only precedent: this page writes no drill axis of its own yet,
 * but the read side and the conditional mount are wired now).
 *
 * Phase 30.3 (Gate 4, fighter-preference fallback): when the subject has
 * matches but NO saved primary/secondary favorites (imported demo
 * histories), the page infers a read-only fighter list from the fighters
 * observed in those matches instead of dead-ending on the choose-fighters
 * gate — which now only renders when there is neither a saved selection nor
 * a match to infer from. "Choose favorites" stays available as a
 * non-blocking prompt banner above the real content.
 */
export function MatchDataPage() {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const [searchParams] = useSearchParams();
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

  const stageIds = useMemo(() => new Set(stagesById.keys()), []);
  // D-05: a tolerant read of every drill-down axis currently in the URL —
  // this page writes none of them itself yet (RosterUsage/StageBreakdown
  // rows NAVIGATE AWAY to fighter-analysis/stage-detail rather than writing
  // a local axis), but the read side and the conditional terminus row are
  // wired now so future wiring has a mount point (UI-SPEC §10.3).
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

  // WR-C02 (39.1-REVIEW.md): this object literal was rebuilt fresh every
  // render (a NEW reference even when every field's VALUE was unchanged),
  // defeating `FilteredMatchList`'s D-16 reference-identity memo on every
  // parent re-render — same fix as `OpponentHubPage.tsx`/`StageDetailPage.tsx`'s
  // own "WR-03 (38-REVIEW-FIX)". Declared here, BEFORE this component's
  // loading/empty-state early returns below, so this hook is called on
  // EVERY render — Rules of Hooks (mirrors this page's own `stageIds`/
  // `axesFromUrl` memos just above, and `MatchupsPage.tsx`'s identical
  // placement for the same finding).
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
  // Also moved above the early returns (and memoized), for the SAME reason
  // as `terminusAxes` just above: `FilteredMatchList`'s D-16 memo keys on
  // BOTH `axes` and `matches` — stabilizing only `axes` while `matches`
  // still got a fresh array reference every render left the underlying
  // recomputation just as unfixed, for a different reason (mirrors
  // `OpponentHubPage.tsx`'s own `sortedOpponentMatches` useMemo).
  const sortedMatches = useMemo(() => sortMatchesNewestFirst(matches), [matches]);

  // Plan 39.1-24 (gap closure, Task 2, DD-09 reachability): the ONE insight
  // computation this page shares with `MatchDataRail` (which takes the
  // result as props below) and this page's own `FilteredMatchList` terminus
  // (`resolveClaim`/`claimSummary`) — mirrors `FighterAnalysisPage.tsx`'s
  // Task 1 wiring. Called unconditionally, above every early return.
  const {
    insights: matchDataInsights,
    dismissedIds,
    dismiss,
    restoreAll,
  } = useMatchDataInsights({ matches, horizon });
  const insightById = useMemo(
    () => new Map(matchDataInsights.map((insight) => [insight.id, insight])),
    [matchDataInsights],
  );
  // A dedicated name distinct from `matchData.title` — matches
  // `MatchDataRail.tsx`'s own `accountName` derivation so the claim summary
  // reads the same entity the rail card itself rendered.
  const accountNameForClaim = t('matchData.roster.railName');
  const claimSummary =
    axesFromUrl.claimId != null
      ? (() => {
          const insight = insightById.get(axesFromUrl.claimId!);
          return insight ? buildMatchDataVerdict(insight, t, accountNameForClaim) : undefined;
        })()
      : undefined;
  // WR-C02 (39.1-REVIEW.md) precedent, re-applied: an inline arrow function
  // passed as `resolveClaim` would be a NEW reference every render, breaking
  // `FilteredMatchList`'s D-16 memo on every unrelated parent re-render.
  // Memoized by `matchDataInsights` alone — the only thing this closure
  // actually reads.
  const resolveClaimForTerminus = useCallback(
    (claimId: string, ms: Match[]) =>
      resolveInsightClaim({ claimId, insights: matchDataInsights, matches: ms }),
    [matchDataInsights],
  );

  // WR-01 (39.1-REVIEW iteration 2): the same claim-follows-horizon rule as
  // Fighter Analysis, Trends and Matchups — a HorizonSwitch press re-points a
  // followed rail door's claim to the same insight at the new horizon; one
  // that cannot resolve is shown as not applied by the terminus. Above every
  // early return (Rules of Hooks).
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
  // 260725-Q1: alphabetized by localized name — matches every other fighter
  // picker in the app.
  const fighterSprites = useSortedFighters(rawFighterSprites);

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern — a page
  // skeleton built from the SAME PageGrid spans as the loaded
  // table(12)/roster+stage(8)/rail(4) layout, so nothing shifts when data
  // lands. The filter row (HorizonSwitch only) needs no fighter/match data,
  // but is intentionally omitted here too, matching every other page in this
  // plan — `PageShell`'s `filterRow` is an optional slot.
  if (fightersLoading || matchesLoading) {
    return (
      <PageShell>
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">{t('matchData.loading')}</span>
          <PageGrid>
            <GridCell span={12}>
              <CardSkeleton variant="list" rows={5} statusLabel={t('matchData.loading')} />
            </GridCell>
            <GridCell span={8} stack>
              <CardSkeleton variant="list" rows={4} statusLabel={t('matchData.loading')} />
              <CardSkeleton variant="list" rows={4} statusLabel={t('matchData.loading')} />
            </GridCell>
            <GridCell span={4}>
              <CardSkeleton variant="insight" statusLabel={t('matchData.loading')} />
            </GridCell>
          </PageGrid>
        </div>
      </PageShell>
    );
  }

  // Plan 39.1-20: a background refetch (matches already loaded once) holds
  // the previous frame at reduced opacity instead of flashing a skeleton.
  const isRefetching = matchesFetching && !matchesLoading;

  if (fighterSprites.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t('shared.noFighters.title')}</h1>
          <p className="max-w-md text-muted-foreground">{t('shared.noFighters.subtitle')}</p>
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
          <h2 className="text-xl font-semibold tracking-tight">{t('matchData.noMatches')}</h2>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <AddMatchForm fighterSprites={fighterSprites} fighter={fighterSprites[0]} />
            <Button asChild variant="outline">
              <Link to={subjectPath('/dashboard')}>{t('common.goToDashboard')}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const filterRow = (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-end gap-6 pt-6">
        <HorizonSwitch />
      </CardContent>
    </Card>
  );

  return (
    <PageShell filterRow={filterRow}>
      {usingInferredFighters && <ChooseFavoritesPrompt />}
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <PageGrid
        className={cn(
          isRefetching &&
            'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
        )}
      >
        <GridCell span={12}>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('matchData.title')}</CardTitle>
              <AddMatchForm fighterSprites={fighterSprites} fighter={fighterSprites[0]} />
            </CardHeader>
            <CardContent>
              <MatchTable matches={matches} fighterSprites={fighterSprites} />
            </CardContent>
          </Card>
        </GridCell>

        <GridCell span={8} stack>
          <RosterUsage matches={matches} />
          <StageBreakdown matches={matches} />
        </GridCell>

        <GridCell span={4}>
          <MatchDataRail
            insights={matchDataInsights}
            dismissedIds={dismissedIds}
            dismiss={dismiss}
            restoreAll={restoreAll}
            horizon={horizon}
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

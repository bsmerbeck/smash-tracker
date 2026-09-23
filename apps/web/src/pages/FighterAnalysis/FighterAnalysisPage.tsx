import { useCallback, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter, Match } from '@smash-tracker/shared';
import { buildPeriodSeries, periodPointMatchIdsForKey } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { cn } from '@/lib/utils';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { resolveInsightClaim } from '@/components/analytics/insightDoors';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useFighterName } from '@/hooks/useFighterName';
import { useHorizon } from '@/hooks/useHorizon';
import { useClaimFollowsHorizon, useUrlClaimRewriter } from '@/hooks/useClaimFollowsHorizon';
import { useLandingScroll } from '@/hooks/useLandingScroll';
import { usePersistedSelection } from '@/hooks/usePersistedSelection';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { inferFighterIdsFromMatches } from '@/lib/inferredFighters';
import { ChooseFavoritesPrompt } from '@/components/ChooseFavoritesPrompt';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { buildOpponentEvidence } from '@/lib/stats';
import { buildOpponentHubPath } from '@/lib/analyzeOpponent';
import {
  buildDrillDownSearch,
  readDrillDownParams,
  sortMatchesNewestFirst,
  DRILL_DOWN_STAGE_PARAM,
  DRILL_DOWN_EVENT_PARAM,
  DRILL_DOWN_FROM_PARAM,
  DRILL_DOWN_TO_PARAM,
  DRILL_DOWN_CLAIM_PARAM,
  type DrillDownAxes,
} from '@/lib/drillDownParams';
import { formStripEventKeyForMatch } from '@/pages/Matchups/components/MatchupChart';
import { SelectFighter } from './components/SelectFighter';
import { FighterHero, type FighterHeroDrillAxes } from './components/FighterHero';
import {
  FighterInsightRail,
  buildInsightVerdict,
  useFighterInsights,
} from './components/FighterInsightRail';
import { useFighterFormNow } from './lib/useFighterFormNow';
import { VsCharactersList } from './components/VsCharactersList';
import { VsPlayersList } from './components/VsPlayersList';
import { StageMastery } from './components/StageMastery';
import { MatchupCoverage } from './components/MatchupCoverage';
import { PracticeRecommendations } from './components/PracticeRecommendations';
import { MatchupStageGuide } from './components/MatchupStageGuide';
import { OpponentTable, type OpponentTableRow } from './components/OpponentTable';

const GAMES_ANCHOR_ID = 'games';

/**
 * Fighter Analysis command center, rebuilt onto the insight-first grid
 * contract (T-39.1-14, UI-SPEC §8.1): `PageShell` → one filter row →
 * `PageGrid` rows. The hero leads at every width (DD-07) — it is always the
 * first grid cell in DOM order; only the `xl:col-span-4` rail cell shares
 * its row at >=1280px (UI-SPEC §6.6's placement table). Ports
 * legacy/src/screens/FighterAnalysis.
 */
export function FighterAnalysisPage() {
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
  const { data: aliasMap } = useOpponentAliases();
  const {
    horizon,
    setHorizon,
    isLoading: horizonLoading,
    explicitChangeCount: horizonChangeCount,
  } = useHorizon();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch, matching `OpponentsPage.tsx`'s convention.
  const [refreshedAt] = useState(() => Date.now());

  const stageIds = useMemo(() => new Set(stagesById.keys()), []);
  // D-05: a tolerant read of every drill-down axis currently in the URL —
  // this page writes none of them itself yet (no in-page control narrows by
  // stage/event/date-range within this plan; the terminus list below is
  // reachable today only via a URL a future plan's click handler writes),
  // but the read side and the conditional terminus row are wired now so
  // that future wiring has a mount point (UI-SPEC §10.3).
  const axesFromUrl = useMemo(
    () => readDrillDownParams(searchParams, { stageIds }),
    [searchParams, stageIds],
  );
  const hasDrillAxis =
    axesFromUrl.stageId != null ||
    axesFromUrl.eventKey != null ||
    axesFromUrl.from != null ||
    axesFromUrl.to != null ||
    axesFromUrl.claimId != null;

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

  const { fighter, setFighter, orderedFighterSprites, fighterUsageById } = usePersistedSelection({
    fighterSprites: rawFighterSprites,
  });

  // WR-C02 (39.1-REVIEW.md): this object literal was rebuilt fresh every
  // render (a NEW reference even when every field's VALUE was unchanged),
  // defeating `FilteredMatchList`'s D-16 reference-identity memo on every
  // parent re-render (a horizon toggle, a background refetch, any sibling
  // state change) — same fix as `OpponentHubPage.tsx`/`StageDetailPage.tsx`'s
  // own "WR-03 (38-REVIEW-FIX)". Declared here, BEFORE this component's
  // conditional early returns below (loading/no-fighters/no-matches), so
  // this hook is called on EVERY render — rules-of-hooks, mirroring where
  // `OpponentHubPage.tsx`/`StageDetailPage.tsx` place their own copy.
  const terminusAxes: DrillDownAxes = useMemo(
    () => ({
      fighterId: fighter?.id,
      stageId: axesFromUrl.stageId,
      eventKey: axesFromUrl.eventKey,
      from: axesFromUrl.from,
      to: axesFromUrl.to,
      claimId: axesFromUrl.claimId,
    }),
    [
      fighter?.id,
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
  // still gets a fresh array reference every render leaves the underlying
  // recomputation just as unfixed, for a different reason (mirrors
  // `OpponentHubPage.tsx`'s own `sortedOpponentMatches` useMemo).
  const fighterIdForFilter = fighter?.id;
  const fighterMatches = useMemo(
    () =>
      fighterIdForFilter != null ? matches.filter((m) => m.fighter_id === fighterIdForFilter) : [],
    [matches, fighterIdForFilter],
  );
  const sortedFighterMatches = useMemo(
    () => sortMatchesNewestFirst(fighterMatches),
    [fighterMatches],
  );

  // CR-02 (39.1-REVIEW): the ONE period series the hero plots AND this
  // page's terminus resolves a trend-point drill against. A point drills as
  // `event=<point.key>`; each game resolves to BOTH its form-strip set key
  // and its period key, so the one `event` axis narrows to exactly a set's
  // games or exactly a point's games — never a reconstructed time window.
  const periodSeries = useMemo(
    () => buildPeriodSeries({ matches: fighterMatches }),
    [fighterMatches],
  );
  // WR-02 (39.1-REVIEW iteration 2): the URL's `event=` period key resolves
  // by the key's OWN grain rule over this same base, not through whichever
  // grain the ladder picks right now — a key drawn at `week` still lands on
  // its week after a range filter or a sync moves the ladder to `month`.
  // While the grain is unchanged this is exactly the plotted point's games.
  const drillEventKey = axesFromUrl.eventKey;
  const periodEventMatchIds = useMemo(() => {
    if (drillEventKey == null) return undefined;
    const ids = periodPointMatchIdsForKey(drillEventKey, fighterMatches);
    return ids ? new Set(ids) : undefined;
  }, [drillEventKey, fighterMatches]);
  const eventKeysForMatch = useCallback(
    (match: Match): string[] => {
      const setKey = formStripEventKeyForMatch(match);
      return drillEventKey != null && periodEventMatchIds?.has(match.id)
        ? [setKey, drillEventKey]
        : [setKey];
    },
    [drillEventKey, periodEventMatchIds],
  );

  // Plan 39.1-24 (gap closure, orchestrator Finding 8, DD-09 reachability):
  // the ONE insight computation this page shares with `FighterInsightRail`
  // (which takes the result as props below) and this page's own
  // `FilteredMatchList` terminus (`resolveClaim`/`claimSummary`) — called
  // unconditionally, above every early return, matching every other hook on
  // this page. `fighterIdForFilter` is `undefined` before a fighter is
  // resolved; the hook itself tolerates that (zero insights, never a throw).
  const {
    insights: fighterInsights,
    dismissedIds,
    dismiss,
    restoreAll,
  } = useFighterInsights({
    fighterId: fighterIdForFilter,
    fighterMatches,
    horizon,
  });
  // Plan 39.1-25 (gap closure, SC4/INS-04, D-12): the ONE `formNow`
  // computation this page shares with the hero (verdict, strip, trend, the
  // counted-games door) and its own terminus below — never a second,
  // independently-built `formNow` insight (the hero no longer builds its
  // own). Called unconditionally, above every early return, beside
  // `useFighterInsights`.
  const heroFormNow = useFighterFormNow({
    fighterId: fighterIdForFilter,
    fighterMatches,
    horizon,
  });
  // The hero's own `formNow` insight leads `pageInsights` (so its
  // `claim=<id>` door resolves through the SAME array the rail's insights
  // already resolve through) — one array, one terminus resolver.
  const pageInsights = useMemo(
    () => (heroFormNow.insight ? [heroFormNow.insight, ...fighterInsights] : fighterInsights),
    [heroFormNow.insight, fighterInsights],
  );
  const insightById = useMemo(
    () => new Map(pageInsights.map((insight) => [insight.id, insight])),
    [pageInsights],
  );
  // React Compiler forbids a bare fighter-name lookup with an `undefined` id
  // (`useFighterName` always needs a number) — a sentinel id resolves to the
  // hook's own "unknown fighter" fallback string, harmless since it is only
  // ever interpolated into `claimSummary` when a real claim/insight is found.
  const fighterNameForClaim = useFighterName(fighterIdForFilter ?? -1);
  const claimSummary =
    axesFromUrl.claimId != null
      ? (() => {
          const insight = insightById.get(axesFromUrl.claimId!);
          return insight ? buildInsightVerdict(insight, t, fighterNameForClaim) : undefined;
        })()
      : undefined;
  // WR-C02 (39.1-REVIEW.md) precedent, re-applied: an inline arrow function
  // passed as `resolveClaim` would be a NEW reference every render, breaking
  // `FilteredMatchList`'s D-16 memo on every unrelated parent re-render
  // (a horizon toggle, a background refetch) exactly like the un-memoized
  // `terminusAxes` object literal this file already fixed once. Memoized by
  // `pageInsights` alone — the only thing this closure actually reads
  // (plan 39.1-24's D-16 memo lesson, now keyed on the shared array).
  const resolveClaimForTerminus = useCallback(
    (claimId: string, ms: Match[]) =>
      resolveInsightClaim({ claimId, insights: pageInsights, matches: ms }),
    [pageInsights],
  );

  // Plan 39.1-25 / WR-02 (39.1-REVIEW): scroll the terminus into view once
  // per navigation whenever the hash names it — only once the data has
  // landed and the terminus is actually mounted, so a cold load, refresh or
  // shared door URL lands there too (not just an in-app door click).
  const location = useLocation();
  useLandingScroll({
    anchorId: GAMES_ANCHOR_ID,
    ready: !fightersLoading && !matchesLoading && fighter != null && hasDrillAxis,
  });

  // Plan 39.1-25 (gap closure, SC6/TRND-04): the ONE URL writer for a hero
  // trend-point or form-strip-set drill. A drill REPLACES any prior
  // narrowing or claim axis (never composes with a claim door someone
  // followed earlier) — `pathname` is passed explicitly so a `/coach/
  // :clientId` or `/workspace/:tenantId` prefix survives.
  const navigate = useNavigate();
  /** The current search minus every axis this page's terminus narrows by — the ONE spelling every writer below shares. */
  function searchWithoutDrillAxes(): URLSearchParams {
    const params = new URLSearchParams(searchParams);
    params.delete(DRILL_DOWN_STAGE_PARAM);
    params.delete(DRILL_DOWN_EVENT_PARAM);
    params.delete(DRILL_DOWN_FROM_PARAM);
    params.delete(DRILL_DOWN_TO_PARAM);
    params.delete(DRILL_DOWN_CLAIM_PARAM);
    return params;
  }
  function handleHeroDrill(axes: FighterHeroDrillAxes): void {
    const params = searchWithoutDrillAxes();
    for (const [key, value] of buildDrillDownSearch(axes)) {
      params.set(key, value);
    }
    navigate({
      pathname: location.pathname,
      search: `?${params.toString()}`,
      hash: `#${GAMES_ANCHOR_ID}`,
    });
  }

  // WR-01 (39.1-REVIEW): this page writes drill axes (the hero drills and
  // the insight doors), so its terminus must offer a way back out — Clear
  // filters drops every axis and the `#games` hash (the terminus unmounts,
  // since it only exists while an axis is present).
  function handleClearFilters(): void {
    const search = searchWithoutDrillAxes().toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' });
  }

  // WR-01 (39.1-REVIEW): a set/period drill or a `formNow:character:<id>`
  // claim belongs to the fighter it was drawn from — switching fighter drops
  // them (Matchups' `handleSetFighter` precedent) rather than narrowing the
  // new fighter to an unrelated set, or silently falling back to all games.
  function handleSelectFighter(next: Fighter): void {
    setFighter(next);
    if (hasDrillAxis) handleClearFilters();
  }

  // WR-01 (39.1-REVIEW): a claim id ends in its horizon; when the horizon
  // changes, re-point it to the same insight at the new horizon. One that
  // cannot resolve stays in the URL and the terminus shows it as not applied
  // (iteration 2 — the same rule on every page that accepts `claim=`).
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
  // skeleton built from the SAME PageGrid spans as the loaded hero(8)/
  // rail(4)/vs-lists(12)/existing-cards(12) layout, so nothing shifts when
  // data lands. The filter row (fighter picker + HorizonSwitch) needs the
  // resolved `fighter`/`orderedFighterSprites`, so it isn't rendered here —
  // `PageShell`'s `filterRow` is an optional slot.
  if (fightersLoading || matchesLoading) {
    return (
      <PageShell>
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">{t('fighterAnalysis.loading')}</span>
          <PageGrid>
            <GridCell span={8}>
              <CardSkeleton variant="chart" statusLabel={t('fighterAnalysis.loading')} />
            </GridCell>
            <GridCell span={4}>
              <CardSkeleton variant="insight" statusLabel={t('fighterAnalysis.loading')} />
            </GridCell>
            <GridCell span={12}>
              <CardSkeleton variant="list" rows={4} statusLabel={t('fighterAnalysis.loading')} />
            </GridCell>
            <GridCell span={12} stack>
              <CardSkeleton variant="list" rows={3} statusLabel={t('fighterAnalysis.loading')} />
              <CardSkeleton variant="chart" statusLabel={t('fighterAnalysis.loading')} />
              <CardSkeleton variant="list" rows={3} statusLabel={t('fighterAnalysis.loading')} />
            </GridCell>
          </PageGrid>
        </div>
      </PageShell>
    );
  }

  // Plan 39.1-20: a background refetch (matches already loaded once) holds
  // the previous frame at reduced opacity instead of flashing a skeleton.
  const isRefetching = matchesFetching && !matchesLoading;

  if (orderedFighterSprites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('shared.noFighters.title')}</h1>
        <p className="max-w-md text-muted-foreground">{t('fighterAnalysis.noFightersSubtitle')}</p>
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

  // Phase 38-07 (H-02/Q11.4): the own-subject host consumes the SAME
  // identity-resolving inventory the opponents list/hub already use, rather
  // than the legacy raw-tag `getOpponentRecords` — two raw tags belonging to
  // one person now render as ONE row. `OpponentTable` itself is
  // presentational (no query/router hook), so the row build + sort +
  // destination-builder all live here.
  const opponentEvidenceRows = fighter
    ? buildOpponentEvidence({ matches: fighterMatches, aliasMap: aliasMap ?? {}, refreshedAt }).rows
    : [];
  const opponentTableRows: OpponentTableRow[] = [...opponentEvidenceRows]
    .sort((a, b) => b.total - a.total)
    .map((row) => ({
      key: row.identity,
      displayLabel: row.displayTag,
      wins: row.wins,
      losses: row.losses,
      total: row.total,
      winRate: row.winRate,
    }));

  function opponentHubHref(row: OpponentTableRow): string | undefined {
    if (!fighter) return undefined;
    const search = buildDrillDownSearch({ fighterId: fighter.id }).toString();
    return subjectPath(`${buildOpponentHubPath(row.key)}${search ? `?${search}` : ''}`);
  }

  const filterRow = (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-6 pt-6">
        <div className="flex flex-1 flex-col items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('fighterAnalysis.title')}</h1>
          <SelectFighter
            fighter={fighter}
            fighterSprites={orderedFighterSprites}
            fighterUsageById={fighterUsageById}
            onChange={handleSelectFighter}
          />
        </div>
        <HorizonSwitch />
      </CardContent>
    </Card>
  );

  return (
    <PageShell filterRow={filterRow}>
      {usingInferredFighters && <ChooseFavoritesPrompt />}
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      {fighter && (
        <PageGrid
          className={cn(
            isRefetching &&
              'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
          )}
        >
          {/* DD-07: the hero leads at every width — first in DOM order,
              never reordered by a responsive class. */}
          <GridCell span={8}>
            <FighterHero
              fighter={fighter}
              fighterMatches={fighterMatches}
              allMatches={allMatches}
              horizon={horizon}
              setHorizon={setHorizon}
              isLoading={horizonLoading || matchesLoading}
              formNowInsight={heroFormNow.insight}
              nowMs={heroFormNow.nowMs}
              periodSeries={periodSeries}
              onDrill={handleHeroDrill}
            />
          </GridCell>

          <GridCell span={4}>
            <FighterInsightRail
              fighterId={fighter.id}
              insights={fighterInsights}
              dismissedIds={dismissedIds}
              dismiss={dismiss}
              restoreAll={restoreAll}
              horizon={horizon}
            />
          </GridCell>

          {/* UI-SPEC §8.1: the 2-up "vs characters" / "vs players" list pair, stacking below 860px (container). */}
          <GridCell span={12}>
            <div className="@container grid grid-cols-1 gap-4 @[860px]:grid-cols-2">
              <VsCharactersList fighterId={fighter.id} fighterMatches={fighterMatches} />
              <VsPlayersList
                fighterId={fighter.id}
                fighterMatches={fighterMatches}
                aliasMap={aliasMap ?? {}}
              />
            </div>
          </GridCell>

          {/* The existing cards, in their current order, placed by content class rather than what space is left over. No card root here carries a stretch utility (UIX-04). */}
          <GridCell span={12} stack>
            <StageMastery
              fighterMatches={fighterMatches}
              stageHref={(stageId) => subjectPath(`/stages/${stageId}`)}
            />

            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <MatchupCoverage allFilteredMatches={matches} fighterMatches={fighterMatches} />
              </div>
              <PracticeRecommendations
                allFilteredMatches={matches}
                fighterMatches={fighterMatches}
              />
            </div>

            <MatchupStageGuide fighterMatches={fighterMatches} />

            <OpponentTable rows={opponentTableRows} hubHref={opponentHubHref} />
          </GridCell>

          {hasDrillAxis && (
            <GridCell span={12}>
              <Card id={GAMES_ANCHOR_ID} className="scroll-mt-16">
                <CardHeader>
                  <CardTitle>{t('matchups.results')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <FilteredMatchList
                    matches={sortedFighterMatches}
                    axes={terminusAxes}
                    resolveClaim={resolveClaimForTerminus}
                    claimSummary={claimSummary}
                    eventKeyForMatch={eventKeysForMatch}
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

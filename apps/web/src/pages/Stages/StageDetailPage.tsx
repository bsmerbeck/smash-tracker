import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ABSTENTION_FLOOR_GAMES,
  UNKNOWN_STAGE_ID,
  buildStageBreakdown,
  binEventSeries,
  buildStageEventSeries,
  isUnknownCharacter,
  resolveEventBin,
} from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { LIST_CAP, LIST_CAP_RAIL } from '@/components/analytics/BoundedList';
import { ChartCard } from '@/components/charts/ChartCard';
import { TrendLine, type TrendEventPoint } from '@/components/charts/TrendLine';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { SampleCue, SampleCueGlyph, UnknownRow } from '@/components/EvidenceCues';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { PageShell } from '@/components/analytics/PageShell';
import { GridCell, PageGrid } from '@/components/analytics/PageGrid';
import { cn } from '@/lib/utils';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { getStageById, stagesById } from '@/data/stages';
import { stageAbbreviation } from '@/components/StageOption';
import { localizedFighterName } from '@/lib/fighterNames';
import { buildOpponentHubPath } from '@/lib/analyzeOpponent';
import {
  buildDrillDownSearch,
  readDrillDownParams,
  sortMatchesNewestFirst,
  type DrillDownAxes,
} from '@/lib/drillDownParams';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { TrackToggle } from '@/components/analytics/track/TrackToggle';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import {
  buildEventKeysForMatch,
  buildEventTrendPoints,
  readableEventLabel,
} from '@/lib/eventTrendPoints';

/**
 * Phase 38-06 (DRL-01/D-06/D-13): the per-stage detail route every stage row
 * in the app drills into — a child route of the shared `subjectAnalyticsRoutes`
 * list, mounted once under all three subject families. Mirrors
 * `OpponentHubPage.tsx`'s shell (plan 38-05): reads ONLY subject-scoped
 * hooks and branches on NOTHING subject-related — the only thing that
 * differs between families is the route prefix, resolved at the router.
 *
 * D-13: this page never manufactures a best-or-worst verdict of its own, and
 * never re-derives the gating status of whichever row linked here — that
 * status belongs to the SOURCE row (the Matchup Stage Guide, the Stage
 * Mastery caption, or an ungated tournament "Stages Played" fact). This page
 * is a neutral list of what was recorded on this stage, nothing more.
 */

const STAGE_IDS = new Set(stagesById.keys());

/** WR-C06 (39.1-REVIEW.md): stable ids the two show-all/show-fewer toggles' `aria-controls` point at — this page mounts once per route, so static ids are safe. */
const BY_OPPONENT_TABLE_ID = 'stage-by-opponent-table';
const BY_CHARACTER_TABLE_ID = 'stage-by-character-table';

/**
 * Base-10 parses `raw`, then applies an integer-and-finite guard, then
 * rejects any value `Number.parseInt` would have silently truncated (e.g.
 * `"3.5"` -> `3`) by re-parsing the full string as a `Number` and requiring
 * the two parses to agree — the same tolerance discipline
 * `@/lib/drillDownParams.ts`'s (unexported) `parseIntegerAxis` uses for every
 * other numeric axis in this milestone. A non-numeric, fractional, or
 * out-of-range segment resolves to `undefined` — never a throw.
 */
function parseStageIdSegment(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return undefined;
  }
  const asNumber = Number(raw);
  if (!Number.isFinite(asNumber) || asNumber !== parsed) {
    return undefined;
  }
  return parsed;
}

/** `true` for a real stage id OR the unknown-stage sentinel — both are legitimate values for this page. */
function isKnownStageSegment(stageId: number): boolean {
  return stageId === UNKNOWN_STAGE_ID || STAGE_IDS.has(stageId);
}

/**
 * Win rate as a whole-number percentage, matching `getWinLossRecord`'s
 * convention (100 when there are no losses) — `StageOpponentGroup`/
 * `StageCharacterGroup` carry `wins`/`losses`/`total` but no pre-computed
 * `winRate` field of their own, unlike `StageRecord`.
 */
/**
 * Plan 39.1-38 (UI-SPEC §6.6 "< 640 tables become stacked rows"): the same
 * phone-layout mechanism FilteredMatchList and MatrixHeat use — Tailwind's
 * `sm` breakpoint as a read-once `matchMedia` check, defaulting to the table
 * when the API is unavailable (jsdom, unless a test stubs it).
 */
const NARROW_LAYOUT_QUERY = '(max-width: 639px)';

function useIsNarrowViewport(): boolean {
  const [isNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(NARROW_LAYOUT_QUERY).matches
      : false,
  );
  return isNarrow;
}

function winRatePercent(wins: number, losses: number): number {
  const total = wins + losses;
  return losses > 0 ? Math.round((wins / total) * 100) : 100;
}

export function StageDetailPage() {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const params = useParams<{ stageId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { matches, isLoading, isFetching } = useFilteredMatches();
  const { data: aliasMap } = useOpponentAliases();
  const [refreshedAt] = useState(() => Date.now());
  // Plan 39.1-18 (UI-SPEC §6.4, UIX-02): both nested-scroller tables on this
  // page (previously sharing one fixed-height, scrolling wrapper class)
  // become capped lists with a show-all/show-fewer toggle, matching
  // `OpponentTable.tsx`'s established cap-ladder idiom (plan 39.1-14) — the
  // by-opponent table at `LIST_CAP` (8), the per-fighter split at
  // `LIST_CAP_RAIL` (5) per this plan's own action text.
  const [byOpponentExpanded, setByOpponentExpanded] = useState(false);
  const [byCharacterExpanded, setByCharacterExpanded] = useState(false);
  const isNarrowViewport = useIsNarrowViewport();

  const resolvedStageId = useMemo(() => {
    const parsed = parseStageIdSegment(params.stageId);
    return parsed != null && isKnownStageSegment(parsed) ? parsed : undefined;
  }, [params.stageId]);

  // D-05: tolerant read — only the event and date-window axes are consumed
  // by this page; a `stage`/`fighter`/`vs` query param (this page's own path
  // already carries the stage identity) is simply not read here.
  //
  // WR-05 (38-REVIEW-FIX): `from`/`to` are read alongside `eventKey` — the
  // "Stages Played" aggregate row on `TournamentDetailPage.tsx` links to a
  // from/to window (instead of a single `event=` anchor) when a stage's
  // games span more than one proximity block, so this page must narrow by
  // that window exactly as it already narrows by `event=`, or the row's own
  // count and this page's regions would disagree again.
  const axesFromUrl = useMemo(
    () => readDrillDownParams(searchParams, { stageIds: STAGE_IDS }),
    [searchParams],
  );
  const eventAxis = axesFromUrl.eventKey;
  const fromAxis = axesFromUrl.from;
  const toAxis = axesFromUrl.to;

  // The FULL (never event-narrowed) event series for this stage — the source
  // of both the event-key -> match-id lookup the terminus needs and the
  // anchor whose label becomes the header subtitle.
  const fullEventSeries = useMemo(
    () =>
      resolvedStageId != null
        ? buildStageEventSeries({ matches, stageId: resolvedStageId, refreshedAt })
        : [],
    [matches, resolvedStageId, refreshedAt],
  );

  // Plan 39.1-39: `event=` names either an anchor or a display bin
  // (`bin:<grain>:<ms>`, written by a click on the binned trend) — a bin
  // resolves against the FULL series at its own grain.
  const eventAnchor = useMemo(() => {
    if (eventAxis == null) return null;
    return (
      fullEventSeries.find((a) => a.key === eventAxis) ??
      resolveEventBin(fullEventSeries, eventAxis) ??
      null
    );
  }, [fullEventSeries, eventAxis]);

  // D-06: arriving with an event axis scopes EVERY region (by-opponent,
  // by-character, over-time, games) to that event; arriving without one is
  // the account-wide view. WR-05 (38-REVIEW-FIX): a from/to date window
  // (the aggregate "Stages Played" row's multi-block link) scopes every
  // region the same way `event=` does — never just the games-list terminus —
  // so a row's own count and this page's regions can't disagree. `event=`
  // takes priority when both are somehow present (the two producers in this
  // codebase never emit both together).
  const sourceMatches = useMemo(() => {
    if (eventAxis != null) {
      if (!eventAnchor) {
        return [];
      }
      const idSet = new Set(eventAnchor.matchIds);
      return matches.filter((m) => idSet.has(m.id));
    }
    if (fromAxis != null || toAxis != null) {
      return matches.filter(
        (m) => (fromAxis == null || m.time >= fromAxis) && (toAxis == null || m.time <= toAxis),
      );
    }
    return matches;
  }, [matches, eventAxis, eventAnchor, fromAxis, toAxis]);

  const breakdown = useMemo(
    () =>
      resolvedStageId != null
        ? buildStageBreakdown({
            matches: sourceMatches,
            aliasMap: aliasMap ?? {},
            stageId: resolvedStageId,
            refreshedAt,
          })
        : null,
    [sourceMatches, aliasMap, resolvedStageId, refreshedAt],
  );

  // The by-character view excludes unknown-character games from its own
  // denominators (they still appear in the games list below) — computed as
  // its OWN `buildStageBreakdown` call over the known-character subset, since
  // the engine's `byCharacter` grouping has no character-knownness filter of
  // its own and `packages/shared` is out of scope for this plan.
  const knownCharacterMatches = useMemo(
    () => sourceMatches.filter((m) => !isUnknownCharacter(m)),
    [sourceMatches],
  );
  const characterBreakdown = useMemo(
    () =>
      resolvedStageId != null
        ? buildStageBreakdown({
            matches: knownCharacterMatches,
            aliasMap: aliasMap ?? {},
            stageId: resolvedStageId,
            refreshedAt,
          })
        : null,
    [knownCharacterMatches, aliasMap, resolvedStageId, refreshedAt],
  );
  const unknownCharacterBucket = useMemo(() => {
    if (resolvedStageId == null) return null;
    const games = sourceMatches.filter(
      (m) => (m.map?.id ?? UNKNOWN_STAGE_ID) === resolvedStageId && isUnknownCharacter(m),
    );
    if (games.length === 0) return null;
    return {
      games: games.length,
      wins: games.filter((m) => m.win).length,
      losses: games.filter((m) => !m.win).length,
    };
  }, [sourceMatches, resolvedStageId]);

  const trendSeries = useMemo(
    () =>
      resolvedStageId != null
        ? buildStageEventSeries({ matches: sourceMatches, stageId: resolvedStageId, refreshedAt })
        : [],
    [sourceMatches, resolvedStageId, refreshedAt],
  );
  // Plan 39.1-39 (VIZ-01, UI-SPEC §11): the PLOTTED series is binned by the
  // engine to at most 60 points (identity at or under the bound); the chart
  // never bins. Points come only through the shared host mapper, with
  // readable, pre-resolved tooltip labels (UI-SPEC §10.2).
  const trendPoints: TrendEventPoint[] = useMemo(
    () =>
      buildEventTrendPoints({
        series: binEventSeries(trendSeries),
        opponentTag: '',
        t,
        locale: i18n.language,
      }),
    [trendSeries, t, i18n.language],
  );

  // WR-03 (38-REVIEW-FIX): a memoised resolver, never a function-per-render
  // (`FilteredMatchList`'s D-16 memoize-by-reference contract). Plan 39.1-39:
  // a game resolves to its anchor key AND its bin key at every grain, so a
  // bin click and a tournament link each list exactly their own games.
  const eventKeyForMatch = useMemo(
    () => buildEventKeysForMatch(fullEventSeries),
    [fullEventSeries],
  );

  /**
   * WR-02 (38-REVIEW-FIX): mirrors `OpponentHubPage.tsx`'s
   * `handleSelectTrendPoint` — clicking an anchor on this page's OWN
   * event-anchored trend writes the SAME `event=` axis arriving via a link
   * already sets, re-scoping every region (D-06) exactly as a fresh
   * `?event=` arrival does. Previously this page's `<TrendLine>` passed no
   * `onSelectPoint` at all, the only structurally-identical chart usage in
   * this milestone that didn't.
   */
  function handleSelectTrendPoint(point: TrendEventPoint) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of buildDrillDownSearch({ eventKey: point.eventKey }).entries()) {
        next.set(key, value);
      }
      return next;
    });
  }

  // WR-03 (38-REVIEW-FIX): same fix as `OpponentHubPage.tsx` — this literal
  // was a fresh object every render, independently defeating
  // `FilteredMatchList`'s D-16 memo regardless of the `eventKeyForMatch` fix
  // above. WR-05: `from`/`to` are included so the games-list terminus
  // narrows by the same window `sourceMatches` above uses for every other
  // region.
  const terminusAxes: DrillDownAxes = useMemo(
    () => ({ stageId: resolvedStageId, eventKey: eventAxis, from: fromAxis, to: toAxis }),
    [resolvedStageId, eventAxis, fromAxis, toAxis],
  );
  // Phase 38-04 (D-16): the single-owner ordering helper — never a local
  // `.sort((a, b) => b.time - a.time)`, which would drop the ascending
  // match-id tiebreak this helper owns.
  const sortedMatches = useMemo(() => sortMatchesNewestFirst(matches), [matches]);

  const sortedByOpponent = useMemo(
    () => (breakdown ? [...breakdown.byOpponent].sort((a, b) => b.total - a.total) : []),
    [breakdown],
  );
  const sortedByCharacter = useMemo(
    () =>
      characterBreakdown
        ? [...characterBreakdown.byCharacter].sort((a, b) => b.total - a.total)
        : [],
    [characterBreakdown],
  );
  const visibleByOpponent = byOpponentExpanded
    ? sortedByOpponent
    : sortedByOpponent.slice(0, LIST_CAP);
  const byOpponentHasMore = sortedByOpponent.length > LIST_CAP;
  const visibleByCharacter = byCharacterExpanded
    ? sortedByCharacter
    : sortedByCharacter.slice(0, LIST_CAP_RAIL);
  const byCharacterHasMore = sortedByCharacter.length > LIST_CAP_RAIL;

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern — a
  // skeleton echoing the loaded page's own section stack. Plan 39.1-37: the
  // page is on PageShell/PageGrid now, so the skeleton carries the loaded
  // spans — over time (8) beside by opponent (4), then by character and the
  // games list full-width.
  if (isLoading) {
    return (
      <PageShell>
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">{t('stages.detail.loading')}</span>
          <PageGrid>
            <GridCell span={8}>
              <CardSkeleton variant="chart" statusLabel={t('stages.detail.loading')} />
            </GridCell>
            <GridCell span={4}>
              <CardSkeleton variant="list" rows={4} statusLabel={t('stages.detail.loading')} />
            </GridCell>
            <GridCell span={12}>
              <CardSkeleton variant="list" rows={4} statusLabel={t('stages.detail.loading')} />
            </GridCell>
            <GridCell span={12}>
              <CardSkeleton variant="list" rows={4} statusLabel={t('stages.detail.loading')} />
            </GridCell>
          </PageGrid>
        </div>
      </PageShell>
    );
  }

  // Plan 39.1-20: a background refetch (matches already loaded once) holds
  // the previous frame at reduced opacity instead of flashing a skeleton.
  const isRefetching = isFetching && !isLoading;

  const showEmpty = resolvedStageId == null || !breakdown || breakdown.sample.rawSampleSize === 0;

  const stage = resolvedStageId != null ? getStageById(resolvedStageId) : undefined;
  const stageName =
    resolvedStageId === UNKNOWN_STAGE_ID
      ? t('common.unknown')
      : (stage?.name ?? t('common.unknown'));
  // Plan 39.1-39: the subtitle names the event the way the trend's tooltip
  // does (a session's date, a bin's period, a tournament's name) — never an
  // engine key or ISO string.
  const eventLabel =
    eventAxis != null
      ? eventAnchor
        ? readableEventLabel({ point: eventAnchor, t, locale: i18n.language })
        : eventAxis
      : null;

  // Plan 39.1-37 (UIX-01): the one page container (content capped at 1440px).
  return (
    <PageShell>
      <div className="flex items-center gap-3">
        {stage?.url ? (
          <img src={stage.url} alt="" className="h-14 w-24 shrink-0 rounded object-cover" />
        ) : (
          <span
            className="flex h-14 w-24 shrink-0 items-center justify-center rounded bg-muted text-sm font-semibold text-muted-foreground"
            aria-hidden="true"
          >
            {stage ? stageAbbreviation(stage.name) : '??'}
          </span>
        )}
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('stages.detail.title', { stage: stageName })}
          </h1>
          {eventLabel != null && (
            <p className="text-sm text-muted-foreground">
              {t('stages.detail.atEvent', { eventName: eventLabel })}
            </p>
          )}
        </div>
        {/* Plan 39.2-10 (T-04): Track sits on the right of the identity row; it renders only for a real (positive) stage id. */}
        {resolvedStageId != null && (
          <TrackToggle
            kind="stage"
            itemRef={resolvedStageId}
            name={stageName}
            className="ml-auto"
          />
        )}
      </div>

      {showEmpty ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-16 text-center text-sm text-muted-foreground">
          {t('stages.detail.empty')}
        </div>
      ) : (
        <div
          data-slot="stage-detail-body"
          className={cn(
            // Plan 39.1-20 [Rule 1]: was `display: contents` (a pure
            // passthrough box) — `opacity` has no visual effect on a
            // `display: contents` element (it generates no box of its own
            // to apply the property to), which would have silently made
            // the refetch-dim rule below a no-op on this route. A real
            // `flex flex-col gap-6` box reproduces the SAME child spacing
            // `contents` achieved (this element's only child before was the
            // parent's own `flex flex-col gap-6`), while giving `opacity`
            // something to apply to.
            'flex flex-col gap-6',
            isRefetching &&
              'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
          )}
        >
          {/* Plan 39.1-37 (UI-SPEC §6.1 chart = 8 + 4; owner item 5): the Over
              Time trend in an 8-col cell beside the By opponent list (3
              columns, a ranked list) in a 4-col cell; By character and the
              games list stay full-width rows below. */}
          <PageGrid>
            <GridCell span={8}>
              <ChartCard
                title={t('stages.detail.overTime')}
                abstained={
                  breakdown && breakdown.sample.rawSampleSize < ABSTENTION_FLOOR_GAMES
                    ? { gamesNeeded: ABSTENTION_FLOOR_GAMES - breakdown.sample.rawSampleSize }
                    : null
                }
              >
                <TrendLine
                  mode="event"
                  points={trendPoints}
                  onSelectPoint={handleSelectTrendPoint}
                />
              </ChartCard>
            </GridCell>
            <GridCell span={4}>
              <Card>
                <CardHeader>
                  <CardTitle>{t('stages.detail.byOpponent')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table id={BY_OPPONENT_TABLE_ID}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('matchups.opponent')}</TableHead>
                        <TableHead>{t('matchups.stageTable.record')}</TableHead>
                        <TableHead>{t('matchups.stageTable.winRate')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleByOpponent.map((row) => (
                        // Plan 39.1-39 (audit 8.1, UI-SPEC §10.1): a Phase 38
                        // DrillableRow — the whole row is the link (overlay),
                        // the tag is plain foreground text, a chevron closes it.
                        <TableRow key={row.identity} className="relative hover:bg-accent">
                          <TableCell className="text-sm">
                            <DrillableRow
                              as="overlay"
                              to={subjectPath(
                                `${buildOpponentHubPath(row.displayTag)}?${buildDrillDownSearch({ stageId: resolvedStageId }).toString()}`,
                              )}
                              ariaLabel={t('shared.drillableRow.aria', {
                                subject: row.displayTag,
                                context: t('stages.detail.byOpponent'),
                              })}
                            />
                            {row.displayTag}
                          </TableCell>
                          <TableCell className="text-sm">
                            {row.wins}-{row.losses}
                          </TableCell>
                          <TableCell className="text-sm whitespace-normal">
                            {/* Plan 39.1-37: the 4-col rail cell is narrower
                                than the words cue's 280px, so it carries the
                                glyph form (UI-SPEC §14.3; the sentence is its
                                aria-label) and may wrap rather than push the
                                table past the card edge. */}
                            <span className="flex flex-wrap items-center gap-x-2">
                              {winRatePercent(row.wins, row.losses)}%
                              <span className="text-xs text-muted-foreground">
                                <SampleCueGlyph sample={row.sample} />
                              </span>
                              <DrillableRowChevron className="ml-auto" />
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                      {breakdown?.unnamed && (
                        <tr className="text-muted-foreground">
                          <td colSpan={100} className="px-2 py-1 text-sm">
                            {t('shared.evidence.unnamedBucket', { count: breakdown.unnamed.games })}
                          </td>
                        </tr>
                      )}
                    </TableBody>
                  </Table>
                  {byOpponentHasMore && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className={MUTED_LINK_TONE}
                      onClick={() => setByOpponentExpanded((prev) => !prev)}
                      aria-expanded={byOpponentExpanded}
                      aria-controls={BY_OPPONENT_TABLE_ID}
                    >
                      {byOpponentExpanded
                        ? t('analytics.list.showFewer')
                        : t('analytics.list.showAll', { count: sortedByOpponent.length })}
                    </Button>
                  )}
                </CardContent>
              </Card>
            </GridCell>
            <GridCell span={12}>
              <Card>
                <CardHeader>
                  <CardTitle>{t('stages.detail.byCharacter')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {isNarrowViewport ? (
                    // Plan 39.1-38 (UI-SPEC §6.6 / §6.5 rule 1; deferred from
                    // 39.1-37): below 640px each pairing is one stacked
                    // two-line row — the pairing in one truncating slot (with
                    // its full text as a title), then record · rate · games
                    // and the glyph confidence cue, each token wrapping whole —
                    // so no column hides behind a horizontal scroll. One link
                    // per row, same destination as the table's.
                    <ul
                      id={BY_CHARACTER_TABLE_ID}
                      data-slot="stage-by-character"
                      className="flex flex-col divide-y"
                    >
                      {visibleByCharacter.map((row) => {
                        const mySprite = getFighterById(row.myFighterId);
                        const theirSprite = getFighterById(row.theirFighterId);
                        const myName = mySprite
                          ? localizedFighterName(row.myFighterId, t)
                          : t('common.unknown');
                        const theirName = theirSprite
                          ? localizedFighterName(row.theirFighterId, t)
                          : t('common.unknown');
                        const pairingText = `${myName} ${t('matchups.vs')} ${theirName}`;
                        const games = row.wins + row.losses;
                        return (
                          <li
                            key={row.key}
                            className="relative flex min-w-0 flex-col gap-1 py-2 hover:bg-accent"
                          >
                            <DrillableRow
                              as="overlay"
                              to={subjectPath(
                                `/matchups?${buildDrillDownSearch({ fighterId: row.myFighterId, vsFighterId: row.theirFighterId, stageId: resolvedStageId }).toString()}`,
                              )}
                              ariaLabel={t('shared.drillableRow.aria', {
                                subject: pairingText,
                                context: t('stages.detail.byCharacter'),
                              })}
                            />
                            <span className="flex min-w-0 items-center gap-1 text-sm">
                              {mySprite?.url && (
                                <img
                                  src={mySprite.url}
                                  alt=""
                                  className="size-5 shrink-0 object-contain"
                                />
                              )}
                              {theirSprite?.url && (
                                <img
                                  src={theirSprite.url}
                                  alt=""
                                  className="size-5 shrink-0 object-contain"
                                />
                              )}
                              <span
                                data-slot="stage-by-character-pairing"
                                title={pairingText}
                                className="min-w-0 flex-1 truncate"
                              >
                                {pairingText}
                              </span>
                              <DrillableRowChevron />
                            </span>
                            <div
                              data-slot="stage-by-character-record"
                              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground tabular-nums"
                            >
                              <span className="sr-only">{t('matchups.stageTable.record')}</span>
                              <span className="whitespace-nowrap text-foreground">
                                {row.wins}-{row.losses}
                              </span>
                              <span className="sr-only">{t('matchups.stageTable.winRate')}</span>
                              <span className="whitespace-nowrap">
                                {winRatePercent(row.wins, row.losses)}%
                              </span>
                              <span className="whitespace-nowrap">
                                {t('common.games', { count: games })}
                              </span>
                              <span className="whitespace-nowrap text-xs">
                                <SampleCueGlyph sample={row.sample} />
                              </span>
                            </div>
                          </li>
                        );
                      })}
                      <UnknownRow bucket={unknownCharacterBucket} as="li" />
                    </ul>
                  ) : (
                    <Table id={BY_CHARACTER_TABLE_ID} data-slot="stage-by-character">
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('shared.filteredMatchList.columnMyCharacter')}</TableHead>
                          <TableHead>
                            {t('shared.filteredMatchList.columnTheirCharacter')}
                          </TableHead>
                          <TableHead>{t('matchups.stageTable.record')}</TableHead>
                          <TableHead>{t('matchups.stageTable.winRate')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleByCharacter.map((row) => {
                          const mySprite = getFighterById(row.myFighterId);
                          const theirSprite = getFighterById(row.theirFighterId);
                          const myName = mySprite
                            ? localizedFighterName(row.myFighterId, t)
                            : t('common.unknown');
                          const theirName = theirSprite
                            ? localizedFighterName(row.theirFighterId, t)
                            : t('common.unknown');
                          // Plan 39.1-39: the row's two per-cell links (same
                          // URL) collapse into the ONE DrillableRow overlay.
                          return (
                            <TableRow key={row.key} className="relative hover:bg-accent">
                              <TableCell className="text-sm">
                                <DrillableRow
                                  as="overlay"
                                  to={subjectPath(
                                    `/matchups?${buildDrillDownSearch({ fighterId: row.myFighterId, vsFighterId: row.theirFighterId, stageId: resolvedStageId }).toString()}`,
                                  )}
                                  ariaLabel={t('shared.drillableRow.aria', {
                                    subject: `${myName} ${t('matchups.vs')} ${theirName}`,
                                    context: t('stages.detail.byCharacter'),
                                  })}
                                />
                                <span className="flex items-center gap-1">
                                  {mySprite?.url && (
                                    <img
                                      src={mySprite.url}
                                      alt=""
                                      className="size-5 object-contain"
                                    />
                                  )}
                                  {myName}
                                </span>
                              </TableCell>
                              <TableCell className="text-sm">
                                <span className="flex items-center gap-1">
                                  {theirSprite?.url && (
                                    <img
                                      src={theirSprite.url}
                                      alt=""
                                      className="size-5 object-contain"
                                    />
                                  )}
                                  {theirName}
                                </span>
                              </TableCell>
                              <TableCell className="text-sm">
                                {row.wins}-{row.losses}
                              </TableCell>
                              <TableCell className="text-sm">
                                <span className="flex items-center justify-between gap-2">
                                  <span className="flex items-center gap-2">
                                    {winRatePercent(row.wins, row.losses)}%
                                    <SampleCue sample={row.sample} />
                                  </span>
                                  <DrillableRowChevron />
                                </span>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        <UnknownRow bucket={unknownCharacterBucket} as="tr" />
                      </TableBody>
                    </Table>
                  )}
                  {byCharacterHasMore && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className={MUTED_LINK_TONE}
                      onClick={() => setByCharacterExpanded((prev) => !prev)}
                      aria-expanded={byCharacterExpanded}
                      aria-controls={BY_CHARACTER_TABLE_ID}
                    >
                      {byCharacterExpanded
                        ? t('analytics.list.showFewer')
                        : t('analytics.list.showAll', { count: sortedByCharacter.length })}
                    </Button>
                  )}
                </CardContent>
              </Card>
            </GridCell>
            <GridCell span={12}>
              <Card>
                <CardHeader>
                  <CardTitle>{t('stages.detail.games')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <FilteredMatchList
                    matches={sortedMatches}
                    axes={terminusAxes}
                    eventKeyForMatch={eventKeyForMatch}
                  />
                </CardContent>
              </Card>
            </GridCell>
          </PageGrid>
        </div>
      )}
    </PageShell>
  );
}

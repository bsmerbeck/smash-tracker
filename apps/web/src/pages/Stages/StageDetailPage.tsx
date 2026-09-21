import { useCallback, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  UNKNOWN_STAGE_ID,
  buildStageBreakdown,
  buildStageEventSeries,
  isUnknownCharacter,
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
import { SampleCue, UnknownRow } from '@/components/EvidenceCues';
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
function winRatePercent(wins: number, losses: number): number {
  const total = wins + losses;
  return losses > 0 ? Math.round((wins / total) * 100) : 100;
}

export function StageDetailPage() {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const params = useParams<{ stageId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { matches, isLoading } = useFilteredMatches();
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

  const eventAnchor = useMemo(
    () => (eventAxis != null ? (fullEventSeries.find((a) => a.key === eventAxis) ?? null) : null),
    [fullEventSeries, eventAxis],
  );

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
  const trendPoints: TrendEventPoint[] = useMemo(
    () =>
      trendSeries.map((anchor) => ({
        eventKey: anchor.key,
        cumulativeWinRate: anchor.cumulativeWinRate,
        wins: anchor.wins,
        losses: anchor.losses,
        context: {
          opponentTag: '',
          eventLabel: anchor.label,
          dateMs: anchor.startMs,
        },
      })),
    [trendSeries],
  );

  const eventKeyByMatchId = useMemo(() => {
    const map = new Map<string, string>();
    for (const anchor of fullEventSeries) {
      for (const id of anchor.matchIds) {
        map.set(id, anchor.key);
      }
    }
    return map;
  }, [fullEventSeries]);
  // WR-03 (38-REVIEW-FIX): `useCallback`, not a plain function-per-render —
  // see `OpponentHubPage.tsx`'s identical fix for the full rationale
  // (`FilteredMatchList`'s D-16 memoize-by-reference contract).
  const eventKeyForMatch = useCallback(
    (match: Match): string | undefined => eventKeyByMatchId.get(match.id),
    [eventKeyByMatchId],
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

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="text-muted-foreground">{t('stages.detail.loading')}</div>
      </div>
    );
  }

  const showEmpty = resolvedStageId == null || !breakdown || breakdown.sample.rawSampleSize === 0;

  const stage = resolvedStageId != null ? getStageById(resolvedStageId) : undefined;
  const stageName =
    resolvedStageId === UNKNOWN_STAGE_ID
      ? t('common.unknown')
      : (stage?.name ?? t('common.unknown'));
  const eventLabel = eventAxis != null ? (eventAnchor?.label ?? eventAxis) : null;

  return (
    <div className="flex flex-col gap-6">
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
      </div>

      {showEmpty ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-16 text-center text-sm text-muted-foreground">
          {t('stages.detail.empty')}
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('stages.detail.byOpponent')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('matchups.opponent')}</TableHead>
                    <TableHead>{t('matchups.stageTable.record')}</TableHead>
                    <TableHead>{t('matchups.stageTable.winRate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleByOpponent.map((row) => (
                    <TableRow key={row.identity}>
                      <TableCell className="text-sm">
                        <Link
                          to={subjectPath(
                            `${buildOpponentHubPath(row.displayTag)}?${buildDrillDownSearch({ stageId: resolvedStageId }).toString()}`,
                          )}
                          className="text-primary hover:underline"
                        >
                          {row.displayTag}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.wins}-{row.losses}
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="flex items-center gap-2">
                          {winRatePercent(row.wins, row.losses)}%
                          <SampleCue sample={row.sample} />
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
                  onClick={() => setByOpponentExpanded((prev) => !prev)}
                >
                  {byOpponentExpanded
                    ? t('analytics.list.showFewer')
                    : t('analytics.list.showAll', { count: sortedByOpponent.length })}
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('stages.detail.byCharacter')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('shared.filteredMatchList.columnMyCharacter')}</TableHead>
                    <TableHead>{t('shared.filteredMatchList.columnTheirCharacter')}</TableHead>
                    <TableHead>{t('matchups.stageTable.record')}</TableHead>
                    <TableHead>{t('matchups.stageTable.winRate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleByCharacter.map((row) => {
                    const mySprite = getFighterById(row.myFighterId);
                    const theirSprite = getFighterById(row.theirFighterId);
                    return (
                      <TableRow key={row.key}>
                        <TableCell className="text-sm">
                          <Link
                            to={subjectPath(
                              `/matchups?${buildDrillDownSearch({ fighterId: row.myFighterId, vsFighterId: row.theirFighterId, stageId: resolvedStageId }).toString()}`,
                            )}
                            className="flex items-center gap-1 text-primary hover:underline"
                          >
                            {mySprite?.url && (
                              <img src={mySprite.url} alt="" className="size-5 object-contain" />
                            )}
                            {mySprite
                              ? localizedFighterName(row.myFighterId, t)
                              : t('common.unknown')}
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm">
                          <Link
                            to={subjectPath(
                              `/matchups?${buildDrillDownSearch({ fighterId: row.myFighterId, vsFighterId: row.theirFighterId, stageId: resolvedStageId }).toString()}`,
                            )}
                            className="flex items-center gap-1 text-primary hover:underline"
                          >
                            {theirSprite?.url && (
                              <img src={theirSprite.url} alt="" className="size-5 object-contain" />
                            )}
                            {theirSprite
                              ? localizedFighterName(row.theirFighterId, t)
                              : t('common.unknown')}
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.wins}-{row.losses}
                        </TableCell>
                        <TableCell className="text-sm">
                          <span className="flex items-center gap-2">
                            {winRatePercent(row.wins, row.losses)}%
                            <SampleCue sample={row.sample} />
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <UnknownRow bucket={unknownCharacterBucket} as="tr" />
                </TableBody>
              </Table>
              {byCharacterHasMore && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => setByCharacterExpanded((prev) => !prev)}
                >
                  {byCharacterExpanded
                    ? t('analytics.list.showFewer')
                    : t('analytics.list.showAll', { count: sortedByCharacter.length })}
                </Button>
              )}
            </CardContent>
          </Card>

          <ChartCard
            title={t('stages.detail.overTime')}
            abstained={
              breakdown && breakdown.sample.rawSampleSize < ABSTENTION_FLOOR_GAMES
                ? { gamesNeeded: ABSTENTION_FLOOR_GAMES - breakdown.sample.rawSampleSize }
                : null
            }
          >
            <TrendLine mode="event" points={trendPoints} onSelectPoint={handleSelectTrendPoint} />
          </ChartCard>

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
        </>
      )}
    </div>
  );
}

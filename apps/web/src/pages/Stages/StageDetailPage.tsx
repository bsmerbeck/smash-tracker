import { useMemo, useState } from 'react';
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
const BY_TABLE_MAX_HEIGHT_CLASS = 'max-h-[400px] overflow-y-auto';

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
  const [searchParams] = useSearchParams();
  const { matches, isLoading } = useFilteredMatches();
  const { data: aliasMap } = useOpponentAliases();
  const [refreshedAt] = useState(() => Date.now());

  const resolvedStageId = useMemo(() => {
    const parsed = parseStageIdSegment(params.stageId);
    return parsed != null && isKnownStageSegment(parsed) ? parsed : undefined;
  }, [params.stageId]);

  // D-05: tolerant read — only the event axis is consumed by this page; a
  // `stage`/`fighter`/`vs` query param (this page's own path already carries
  // the stage identity) is simply not read here.
  const axesFromUrl = useMemo(
    () => readDrillDownParams(searchParams, { stageIds: STAGE_IDS }),
    [searchParams],
  );
  const eventAxis = axesFromUrl.eventKey;

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
  // the account-wide view.
  const sourceMatches = useMemo(() => {
    if (eventAxis == null) {
      return matches;
    }
    if (!eventAnchor) {
      return [];
    }
    const idSet = new Set(eventAnchor.matchIds);
    return matches.filter((m) => idSet.has(m.id));
  }, [matches, eventAxis, eventAnchor]);

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
  function eventKeyForMatch(match: Match): string | undefined {
    return eventKeyByMatchId.get(match.id);
  }

  const terminusAxes: DrillDownAxes = { stageId: resolvedStageId, eventKey: eventAxis };
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
              <div className={BY_TABLE_MAX_HEIGHT_CLASS}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('matchups.opponent')}</TableHead>
                      <TableHead>{t('matchups.stageTable.record')}</TableHead>
                      <TableHead>{t('matchups.stageTable.winRate')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedByOpponent.map((row) => (
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
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('stages.detail.byCharacter')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={BY_TABLE_MAX_HEIGHT_CLASS}>
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
                    {sortedByCharacter.map((row) => {
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
                                <img
                                  src={theirSprite.url}
                                  alt=""
                                  className="size-5 object-contain"
                                />
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
              </div>
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
            <TrendLine mode="event" points={trendPoints} />
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

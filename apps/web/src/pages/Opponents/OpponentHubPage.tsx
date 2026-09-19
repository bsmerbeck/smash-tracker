import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match, SampleMeta } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  EVIDENCE_POLICY_VERSION,
  RECENCY_TREATMENT,
  UNKNOWN_STAGE_ID,
  buildOpponentCrossTab,
  buildOpponentEventSeries,
  confidenceTierFor,
  resolveAliasChain,
} from '@smash-tracker/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ChartCard } from '@/components/charts/ChartCard';
import {
  MatrixHeat,
  type MatrixHeatAxis,
  type MatrixHeatCell,
} from '@/components/charts/MatrixHeat';
import { TrendLine, type TrendEventPoint } from '@/components/charts/TrendLine';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { SampleCue, MixedContextBadge } from '@/components/EvidenceCues';
import { getOpponentSources, useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { useOpponentNotes } from '@/hooks/useOpponentNotes';
import { useAuth } from '@/hooks/useAuth';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import {
  buildOpponentEvidence,
  buildOpponentProfile,
  resolveOpponentIdentities,
} from '@/lib/stats';
import {
  ANALYZE_OPPONENT_PLAYER_PARAM,
  buildOpponentHubPath,
  readOpponentHubTagParam,
  resolveAnalyzeOpponentPreselection,
} from '@/lib/analyzeOpponent';
import {
  DRILL_DOWN_EVENT_PARAM,
  DRILL_DOWN_FIGHTER_PARAM,
  DRILL_DOWN_STAGE_PARAM,
  DRILL_DOWN_VS_PARAM,
  buildDrillDownSearch,
  readDrillDownParams,
  sortMatchesNewestFirst,
  type DrillDownAxes,
} from '@/lib/drillDownParams';
import { SpriteList } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { alphaStageList } from '@/lib/stageOptions';
import { localizedFighterName } from '@/lib/fighterNames';
import { ScoutingHeader } from './components/ScoutingHeader';
import { WhatTheyPlayTable } from './components/WhatTheyPlayTable';
import { ScoutingStagesCard } from './components/ScoutingStagesCard';
import { RecentEncounters } from './components/RecentEncounters';
import { TournamentHistory } from './components/TournamentHistory';
import { MergeOpponentDialog } from './components/MergeOpponentDialog';
import { MergedNamesCard } from './components/MergedNamesCard';
import { TendenciesCard } from './components/TendenciesCard';
import { ExportH2HButton } from './components/ExportH2HButton';
import { PrintableEvidencePacket } from './components/PrintableEvidencePacket';
import {
  groupTournamentBlocks,
  getEncounterContext,
  resolveTournamentEntry,
} from './tournamentHistory';
import { buildEvidencePacket } from './evidencePacket';

/**
 * Phase 38-05 (D-01/D-02): the opponent hub — a child route of the SAME
 * `/opponents` base the list page owns, carrying the resolved tag as a
 * path segment. Mounted once via `subjectAnalyticsRoutes.tsx` under all
 * three subject families; this page reads ONLY subject-scoped hooks and
 * branches on NOTHING subject-related — the only thing that differs between
 * families is the route prefix, resolved at the router.
 */

const OPPONENT_HUB_TAG_PATTERN = /\/opponents\/([^/]+)/;
const OPPONENT_HUB_LIST_ANCHOR_ID = 'opponent-hub-list';
const ALL_AXIS_VALUE = '__all__';

/**
 * D-02: reads the raw (still percent-encoded) tag segment directly from
 * `useLocation().pathname` rather than `useParams()` — the same
 * decode-on-read discipline `useActiveSubject.ts` already uses for the
 * `/coach/:clientId` id segment. The regex matches the URL TOPOLOGY only
 * (the literal "/opponents/<segment>" substring), never a subject-type
 * prefix, so it resolves identically under the personal, coach and
 * workspace families with no branch of its own.
 */
function useHubTagFromPathname(): string | null {
  const { pathname } = useLocation();
  return useMemo(() => {
    const match = OPPONENT_HUB_TAG_PATTERN.exec(pathname);
    return match ? readOpponentHubTagParam(match[1]) : null;
  }, [pathname]);
}

/**
 * D-10: the hub's OWN un-pooling chips. Deliberately NOT part of
 * `@/lib/drillDownParams.ts`'s axis contract (D-05) — they narrow which
 * games feed the matrix/trend below, they carry no opponent/character/stage
 * identity, and they are not read by `FilteredMatchList`'s terminus. Still
 * written to their own URL params (never persisted, never touching the
 * global analytics filter) so a hub visit remains fully URL-addressable.
 */
const HUB_CONTEXT_PARAM = 'context';
const HUB_SOURCE_PARAM = 'source';
type HubContextChip = 'online' | 'offline' | 'unspecified';
type HubSourceChip = 'manual' | 'startgg' | 'parrygg';

function matchContext(match: Match): HubContextChip {
  const type = match.matchType ?? '';
  if (type === 'quickplay' || type.startsWith('online')) return 'online';
  if (type.startsWith('offline')) return 'offline';
  return 'unspecified';
}

function matchSource(match: Match): HubSourceChip {
  if (match.source === 'startgg') return 'startgg';
  if (match.source === 'parrygg') return 'parrygg';
  return 'manual';
}

const STAGE_IDS = new Set(stagesById.keys());

export function OpponentHubPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const subjectPath = useSubjectPath();
  const [searchParams, setSearchParams] = useSearchParams();
  const { matches, isLoading, filterActive } = useFilteredMatches();
  const { data: tournamentEntries } = useTournamentEntries();
  const { data: aliasMap } = useOpponentAliases();
  const { data: noteMap } = useOpponentNotes();
  const { user } = useAuth();
  const [refreshedAt] = useState(() => Date.now());
  const [mergeCandidate, setMergeCandidate] = useState<string | null>(null);

  const pathTag = useHubTagFromPathname();

  // D-02: one identity resolver, one hop — the SAME technique the list page
  // uses (build the resolver once over the filtered matches and the alias
  // map, resolve the target, keep matches whose resolved identity matches).
  // No second identity comparison is written anywhere on this page.
  const resolve = useMemo(
    () => resolveOpponentIdentities(matches, aliasMap ?? {}),
    [matches, aliasMap],
  );
  const targetIdentity = useMemo(
    () => (pathTag ? resolve({ opponent: pathTag }) : null),
    [resolve, pathTag],
  );
  const opponentMatches = useMemo(() => {
    if (!targetIdentity) return [];
    return matches.filter((m) => resolve(m) === targetIdentity);
  }, [matches, resolve, targetIdentity]);

  // OPP-01: the head-to-head figures below are taken from `buildOpponentProfile`
  // (`@/lib/stats`, which re-exports the engine) — never counted locally.
  const profile = useMemo(() => {
    if (!targetIdentity) return null;
    return buildOpponentProfile({
      matches,
      aliasMap: aliasMap ?? {},
      opponentTag: targetIdentity,
      refreshedAt,
    });
  }, [matches, aliasMap, targetIdentity, refreshedAt]);

  const tournamentBlocks = useMemo(() => groupTournamentBlocks(opponentMatches), [opponentMatches]);
  const encounterContext = useMemo(() => getEncounterContext(tournamentBlocks), [tournamentBlocks]);

  /**
   * Phase 38-07 (D-08/D-12): a per-match tournament-link resolver for
   * `RecentEncounters`'s inline expansion — built once from the SAME
   * `tournamentBlocks`/`tournamentEntries` `TournamentHistory` already
   * resolves, so the two surfaces never disagree about which tournament a
   * match belongs to.
   */
  const tournamentLinkByMatchId = useMemo(() => {
    const map = new Map<string, { href: string; label: string }>();
    for (const block of tournamentBlocks) {
      const registryEntry = resolveTournamentEntry(block, tournamentEntries ?? []);
      const entryPath =
        registryEntry?.entryKey ??
        (registryEntry?.eventId != null ? String(registryEntry.eventId) : null);
      if (!entryPath) continue;
      const href = subjectPath(`/tournaments/${entryPath}`);
      for (const set of block.sets) {
        for (const game of set.games) {
          map.set(game.match.id, { href, label: block.displayName });
        }
      }
    }
    return map;
  }, [tournamentBlocks, tournamentEntries, subjectPath]);

  function tournamentLinkForMatch(match: Match) {
    return tournamentLinkByMatchId.get(match.id);
  }

  // D-15/pitfall 7: a `player=` hint carried from the legacy redirect is an
  // IDENTITY FALLBACK OF LAST RESORT, never a filter axis — it is NOT part
  // of `@/lib/drillDownParams.ts`'s axis contract. Fires at most once, only
  // when the path tag resolves to zero games, and only replace-navigates
  // when the hint names a DIFFERENT canonical identity that actually has
  // games; otherwise it falls through to the empty state with no navigation.
  const attemptedPlayerFallback = useRef(false);
  useEffect(() => {
    // `aliasMap === undefined` (not yet arrived) is checked explicitly
    // rather than trusting a query's own `isLoading` flag — a disabled
    // query (auth still resolving) reports `isLoading: false` with
    // `data: undefined`. Resolving against a still-empty `matches`/
    // `aliasMap` on the premature render would set the "attempted" flag on
    // a meaningless answer and never retry once real data arrives.
    if (isLoading || aliasMap === undefined || !pathTag || opponentMatches.length > 0) return;
    if (attemptedPlayerFallback.current) return;
    const playerHint = searchParams.get(ANALYZE_OPPONENT_PLAYER_PARAM);
    if (!playerHint) return;
    attemptedPlayerFallback.current = true;
    const hintTag = resolveAnalyzeOpponentPreselection(searchParams, matches, aliasMap ?? {});
    if (!hintTag) return;
    const hintIdentity = resolve({ opponent: hintTag });
    if (hintIdentity === targetIdentity) return;
    const hintHasMatches = matches.some((m) => resolve(m) === hintIdentity);
    if (!hintHasMatches) return;
    navigate(
      subjectPath(
        `${buildOpponentHubPath(hintTag)}?${ANALYZE_OPPONENT_PLAYER_PARAM}=${encodeURIComponent(playerHint)}`,
      ),
      { replace: true },
    );
  }, [
    isLoading,
    pathTag,
    opponentMatches.length,
    searchParams,
    matches,
    aliasMap,
    resolve,
    targetIdentity,
    navigate,
    subjectPath,
  ]);

  // D-05: tolerant read of the character/stage drill-down axes.
  const axesFromUrl = useMemo(
    () => readDrillDownParams(searchParams, { stageIds: STAGE_IDS }),
    [searchParams],
  );
  const hubContext = searchParams.get(HUB_CONTEXT_PARAM) as HubContextChip | null;
  const hubSource = searchParams.get(HUB_SOURCE_PARAM) as HubSourceChip | null;

  /** D-15: writes ONLY the URL — no persisting setter, no global filter touch. */
  function setUrlParam(key: string, value: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    });
  }

  function scrollToList() {
    document
      .getElementById(OPPONENT_HUB_LIST_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** D-05: writes through the plan 38-04 param builder — the sole spelling for every drill-down axis this page composes. */
  function handleSelectCell(cell: MatrixHeatCell) {
    const [myStr, theirStr] = cell.rowKey.split(':');
    const axes: Partial<DrillDownAxes> = {
      fighterId: myStr != null ? Number(myStr) : undefined,
      vsFighterId: theirStr != null ? Number(theirStr) : undefined,
      stageId: Number(cell.colKey),
    };
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of buildDrillDownSearch(axes).entries()) {
        next.set(key, value);
      }
      return next;
    });
    scrollToList();
  }

  function handleSelectTrendPoint(point: TrendEventPoint) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of buildDrillDownSearch({ eventKey: point.eventKey }).entries()) {
        next.set(key, value);
      }
      return next;
    });
    scrollToList();
  }

  /**
   * Phase 38-07 (D-12/D-14): TournamentHistory's set rows write the SAME
   * event-anchor axis `handleSelectTrendPoint` above already writes — one
   * event, one destination shape, regardless of which surface produced it.
   */
  function handleSelectEvent(eventKey: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of buildDrillDownSearch({ eventKey }).entries()) {
        next.set(key, value);
      }
      return next;
    });
    scrollToList();
  }

  const chipFilteredMatches = useMemo(() => {
    return opponentMatches.filter((m) => {
      if (hubContext && matchContext(m) !== hubContext) return false;
      if (hubSource && matchSource(m) !== hubSource) return false;
      return true;
    });
  }, [opponentMatches, hubContext, hubSource]);

  const crossTab = useMemo(() => {
    if (!targetIdentity) return null;
    return buildOpponentCrossTab({
      matches: chipFilteredMatches,
      aliasMap: aliasMap ?? {},
      opponentTag: targetIdentity,
      refreshedAt,
    });
  }, [chipFilteredMatches, aliasMap, targetIdentity, refreshedAt]);

  const matrixRows: MatrixHeatAxis[] = useMemo(() => {
    if (!crossTab) return [];
    return crossTab.rows.map((row) => ({
      key: row.rowKey,
      label: `${localizedFighterName(row.myFighterId, t)} ${t('matchups.vs')} ${localizedFighterName(row.theirFighterId, t)}`,
    }));
  }, [crossTab, t]);

  const matrixCols: MatrixHeatAxis[] = useMemo(() => {
    if (!crossTab) return [];
    return crossTab.cols.map((col) => ({
      key: col.colKey,
      label: stagesById.get(col.stageId)?.name ?? t('common.unknown'),
      isUnknown: col.stageId === UNKNOWN_STAGE_ID,
    }));
  }, [crossTab, t]);

  const matrixCells: MatrixHeatCell[] = useMemo(() => {
    if (!crossTab) return [];
    return crossTab.cells.map((cell) => ({
      rowKey: cell.rowKey,
      colKey: cell.colKey,
      wins: cell.wins,
      losses: cell.losses,
      total: cell.total,
      confidenceTier: cell.confidenceTier,
      sample: cell.sample,
    }));
  }, [crossTab]);

  // OPP-03: opponent-scoped by default, opponent-CHARACTER-scoped when `vs`
  // is set WITHOUT switching opponents — achieved by narrowing the matches
  // handed to `buildOpponentEventSeries` before it re-resolves identity over
  // them, rather than a second engine entry point.
  const trendSourceMatches = useMemo(() => {
    if (axesFromUrl.vsFighterId == null) return chipFilteredMatches;
    return chipFilteredMatches.filter((m) => m.opponent_id === axesFromUrl.vsFighterId);
  }, [chipFilteredMatches, axesFromUrl.vsFighterId]);

  const eventSeries = useMemo(() => {
    if (!targetIdentity) return [];
    return buildOpponentEventSeries({
      matches: trendSourceMatches,
      aliasMap: aliasMap ?? {},
      opponentTag: targetIdentity,
      refreshedAt,
    });
  }, [trendSourceMatches, aliasMap, targetIdentity, refreshedAt]);

  const eventKeyByMatchId = useMemo(() => {
    const map = new Map<string, string>();
    for (const anchor of eventSeries) {
      for (const id of anchor.matchIds) {
        map.set(id, anchor.key);
      }
    }
    return map;
  }, [eventSeries]);

  function eventKeyForMatch(match: Match): string | undefined {
    return eventKeyByMatchId.get(match.id);
  }

  const trendPoints: TrendEventPoint[] = useMemo(
    () =>
      eventSeries.map((anchor) => ({
        eventKey: anchor.key,
        cumulativeWinRate: anchor.cumulativeWinRate,
        wins: anchor.wins,
        losses: anchor.losses,
        context: {
          opponentTag: profile?.opponent ?? pathTag ?? '',
          eventLabel: anchor.label,
          dateMs: anchor.startMs,
        },
      })),
    [eventSeries, profile, pathTag],
  );

  const headToHeadSample: SampleMeta | null = useMemo(() => {
    if (!profile) return null;
    const total = profile.record.total;
    const abstained = total < ABSTENTION_FLOOR_GAMES;
    return {
      rawSampleSize: total,
      eligibleDenominator: total,
      knownFieldCoverage: total > 0 ? 1 : 0,
      dateRange: { firstMs: profile.firstPlayedAt, lastMs: profile.lastPlayedAt },
      refreshedAt,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      recencyTreatment: RECENCY_TREATMENT,
      confidenceTier: abstained ? null : confidenceTierFor(total),
    };
  }, [profile, refreshedAt]);

  // The candidate list for "Merge into..." — a config array, not a
  // denominator this page renders.
  const opponentRecords = useMemo(
    () => buildOpponentEvidence({ matches, aliasMap: aliasMap ?? {}, refreshedAt }).rows,
    [matches, aliasMap, refreshedAt],
  );
  const sources = useMemo(() => getOpponentSources(matches), [matches]);

  const mergedAliasesForSelected = useMemo(() => {
    if (!targetIdentity || !aliasMap) return [];
    return Object.keys(aliasMap).filter(
      (alias) => resolveAliasChain(alias, aliasMap) === targetIdentity,
    );
  }, [aliasMap, targetIdentity]);

  const evidencePacket = useMemo(() => {
    if (!profile) return null;
    return buildEvidencePacket(profile, tournamentBlocks, user?.email ?? 'you');
  }, [profile, tournamentBlocks, user]);

  const terminusAxes: DrillDownAxes = {
    fighterId: axesFromUrl.fighterId,
    vsFighterId: axesFromUrl.vsFighterId,
    stageId: axesFromUrl.stageId,
    eventKey: axesFromUrl.eventKey,
  };
  const sortedOpponentMatches = useMemo(
    () => sortMatchesNewestFirst(opponentMatches),
    [opponentMatches],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="text-muted-foreground">{t('opponents.loading')}</div>
      </div>
    );
  }

  const displayTag = profile?.opponent ?? pathTag ?? '';

  return (
    <div className="flex flex-col gap-6">
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">{displayTag}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {profile && (
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => setMergeCandidate(profile.opponent)}
            >
              {t('opponents.list.mergeInto')}
            </button>
          )}
          {evidencePacket && <ExportH2HButton packet={evidencePacket} />}
        </div>
      </div>

      {!profile ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-16 text-center text-sm text-muted-foreground">
          {t('opponents.hub.empty', { opponent: displayTag })}
        </div>
      ) : (
        <div key={profile.opponent} className="flex flex-col gap-6">
          {/* Identity header + head-to-head summary */}
          <div className="flex flex-col gap-2">
            <ScoutingHeader
              profile={profile}
              encounterContext={encounterContext}
              source={profile.source}
            />
            {headToHeadSample && <SampleCue sample={headToHeadSample} />}
          </div>

          {/* Filter bar (D-05/D-10) */}
          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {t('opponents.hub.filter.fighter')}
                </span>
                <Select
                  value={
                    axesFromUrl.fighterId != null ? String(axesFromUrl.fighterId) : ALL_AXIS_VALUE
                  }
                  onValueChange={(value) =>
                    setUrlParam(DRILL_DOWN_FIGHTER_PARAM, value === ALL_AXIS_VALUE ? null : value)
                  }
                >
                  <SelectTrigger
                    aria-label={t('opponents.hub.filter.fighter')}
                    className="w-full sm:w-[200px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_AXIS_VALUE}>{t('filters.all')}</SelectItem>
                    {SpriteList.map((sprite) => (
                      <SelectItem key={sprite.id} value={String(sprite.id)}>
                        {localizedFighterName(sprite.id, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {t('opponents.hub.filter.vs')}
                </span>
                <Select
                  value={
                    axesFromUrl.vsFighterId != null
                      ? String(axesFromUrl.vsFighterId)
                      : ALL_AXIS_VALUE
                  }
                  onValueChange={(value) =>
                    setUrlParam(DRILL_DOWN_VS_PARAM, value === ALL_AXIS_VALUE ? null : value)
                  }
                >
                  <SelectTrigger
                    aria-label={t('opponents.hub.filter.vs')}
                    className="w-full sm:w-[200px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_AXIS_VALUE}>{t('filters.all')}</SelectItem>
                    {SpriteList.map((sprite) => (
                      <SelectItem key={sprite.id} value={String(sprite.id)}>
                        {localizedFighterName(sprite.id, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {t('opponents.hub.filter.stage')}
                </span>
                <Select
                  value={axesFromUrl.stageId != null ? String(axesFromUrl.stageId) : ALL_AXIS_VALUE}
                  onValueChange={(value) =>
                    setUrlParam(DRILL_DOWN_STAGE_PARAM, value === ALL_AXIS_VALUE ? null : value)
                  }
                >
                  <SelectTrigger
                    aria-label={t('opponents.hub.filter.stage')}
                    className="w-full sm:w-[200px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_AXIS_VALUE}>{t('filters.all')}</SelectItem>
                    {alphaStageList.map((stage) => (
                      <SelectItem key={stage.id} value={String(stage.id)}>
                        {stage.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {crossTab && <MixedContextBadge cohort={crossTab.cohort} />}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={hubContext ?? ''}
                onValueChange={(next) => setUrlParam(HUB_CONTEXT_PARAM, next || null)}
              >
                <ToggleGroupItem value="online">
                  {t('shared.evidence.cohort.online')}
                </ToggleGroupItem>
                <ToggleGroupItem value="offline">
                  {t('shared.evidence.cohort.offline')}
                </ToggleGroupItem>
                <ToggleGroupItem value="unspecified">
                  {t('shared.evidence.cohort.unspecified')}
                </ToggleGroupItem>
              </ToggleGroup>

              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={hubSource ?? ''}
                onValueChange={(next) => setUrlParam(HUB_SOURCE_PARAM, next || null)}
              >
                <ToggleGroupItem value="manual">
                  {t('shared.evidence.cohort.manual')}
                </ToggleGroupItem>
                <ToggleGroupItem value="startgg">
                  {t('shared.evidence.cohort.startgg')}
                </ToggleGroupItem>
                <ToggleGroupItem value="parrygg">
                  {t('shared.evidence.cohort.parrygg')}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          {/* Cross-tab (OPP-02) */}
          <ChartCard title={t('matchups.matrix.title')}>
            <MatrixHeat
              rows={matrixRows}
              cols={matrixCols}
              cells={matrixCells}
              onSelectCell={handleSelectCell}
              emptyMessage={t('shared.evidence.abstained', { count: ABSTENTION_FLOOR_GAMES })}
            />
          </ChartCard>

          {/* Event-anchored trend (OPP-03) */}
          <ChartCard
            title={t('opponents.trend.title')}
            abstained={trendPoints.length === 0 ? { gamesNeeded: ABSTENTION_FLOOR_GAMES } : null}
          >
            <TrendLine mode="event" points={trendPoints} onSelectPoint={handleSelectTrendPoint} />
          </ChartCard>

          {/*
            Absorbed scouting cards (D-12) — content unchanged, chart.js
            trend removed. Phase 38-07 (D-14): the hub threads its resolved
            opponent identity into each card's destination builder; no
            absorbed card re-derives the opponent from its own data prop.
          */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <WhatTheyPlayTable
              byTheirFighter={profile.byTheirFighter}
              rowHref={(row) =>
                subjectPath(
                  `/matchups?${buildDrillDownSearch({ vsFighterId: row.opponentFighterId }).toString()}`,
                )
              }
            />
            <ScoutingStagesCard
              byStage={profile.byStage}
              stageHref={(stageId) => subjectPath(`/stages/${stageId}`)}
            />
          </div>
          <RecentEncounters
            matches={profile.recent}
            tournamentLinkForMatch={tournamentLinkForMatch}
          />
          <TournamentHistory
            blocks={tournamentBlocks}
            tournamentEntries={tournamentEntries ?? []}
            onSelectEvent={handleSelectEvent}
          />
          <TendenciesCard opponent={profile.opponent} note={noteMap?.[profile.opponent]} />
          <MergedNamesCard canonical={profile.opponent} aliases={mergedAliasesForSelected} />
          {evidencePacket && <PrintableEvidencePacket packet={evidencePacket} />}

          {/* Terminus (D-07/D-08) */}
          <div id={OPPONENT_HUB_LIST_ANCHOR_ID} className="scroll-mt-16">
            <FilteredMatchList
              matches={sortedOpponentMatches}
              axes={terminusAxes}
              eventKeyForMatch={eventKeyForMatch}
              onClearFilters={() => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.delete(DRILL_DOWN_FIGHTER_PARAM);
                  next.delete(DRILL_DOWN_VS_PARAM);
                  next.delete(DRILL_DOWN_STAGE_PARAM);
                  next.delete(DRILL_DOWN_EVENT_PARAM);
                  return next;
                });
              }}
            />
          </div>
        </div>
      )}

      {mergeCandidate && (
        <MergeOpponentDialog
          open={mergeCandidate != null}
          onOpenChange={(open) => {
            if (!open) {
              setMergeCandidate(null);
            }
          }}
          opponent={mergeCandidate}
          candidates={opponentRecords
            .map((o) => o.displayTag)
            .filter((name) => name !== mergeCandidate)}
          sources={sources}
          onMerged={() => setMergeCandidate(null)}
        />
      )}
    </div>
  );
}

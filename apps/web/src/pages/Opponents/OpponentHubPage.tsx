import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Insight, InsightKind, InsightScope, Match, SampleMeta } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  EVIDENCE_POLICY_VERSION,
  INSIGHT_TEMPLATES,
  RECENCY_TREATMENT,
  UNKNOWN_STAGE_ID,
  buildOpponentCrossTab,
  binEventSeries,
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
import { Button } from '@/components/ui/button';
import { ChartCard } from '@/components/charts/ChartCard';
import {
  MatrixHeat,
  type MatrixHeatAxis,
  type MatrixHeatCell,
} from '@/components/charts/MatrixHeat';
import { TrendLine, type TrendEventPoint } from '@/components/charts/TrendLine';
import { FormStrip, type FormStripEvent } from '@/components/charts/FormStrip';
import {
  buildFormStripEvents,
  createFormStripSetKeyResolver,
  formStripLabels,
  formStripRecentWindow,
} from '@/lib/formStripEvents';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { buildInsightDoors, resolveInsightClaim } from '@/components/analytics/insightDoors';
import { buildInsightEvidenceLine } from '@/components/analytics/insightEvidenceLine';
import { SampleCue, MixedContextBadge, CohortCompositionLine } from '@/components/EvidenceCues';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { PageShell } from '@/components/analytics/PageShell';
import { PageFilterRow } from '@/components/analytics/PageFilterRow';
import { GridCell, PageGrid } from '@/components/analytics/PageGrid';
import { cn } from '@/lib/utils';
import { getOpponentSources, useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { useOpponentNotes } from '@/hooks/useOpponentNotes';
import { useAuth } from '@/hooks/useAuth';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { DEFAULT_HORIZON } from '@/hooks/useHorizon';
import { useLandingScroll } from '@/hooks/useLandingScroll';
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
  DRILL_DOWN_CLAIM_PARAM,
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
import { TrackToggle } from '@/components/analytics/track/TrackToggle';
import { PrintableEvidencePacket } from './components/PrintableEvidencePacket';
import { HubPrepBriefCard } from './components/HubPrepBriefCard';
import {
  groupTournamentBlocks,
  getEncounterContext,
  resolveTournamentEntry,
} from './tournamentHistory';
import { buildEvidencePacket } from './evidencePacket';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { buildEventKeysForMatch, buildEventTrendPoints } from '@/lib/eventTrendPoints';

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

/** Phase 39.1 Plan 18 (UI-SPEC §8.6): the H2H trend's `formNow` verdict, at opponent-PLAYER scope — this hub's own identity, not a fighter-character pairing (`MatchupChart.tsx`'s `formNow` reuse, distinct scope kind). Looked up by id, matching that same precedent (`formNowTemplate` is not a public export of `@smash-tracker/shared`). */
const OPPONENT_FORM_NOW_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'formNow')!;

/** UI-SPEC §7.8: `InsightKind` (engine) -> `ClaimChipKind` (UI). Duplicated, not shared — this codebase's established "no shared file for one small mapping" convention (`MatchupChart.tsx`/`MatchupOrPlayerCard.tsx` both duplicate the same mapping). */
function claimChipKindFor(kind: InsightKind): ClaimChipKind {
  if (kind === 'inference') return 'trend';
  if (kind === 'recommendation') return 'suggestion';
  return 'fact';
}

/** Builds the player-scoped `InsightScope` for this resolved opponent identity — `formNow.ts` never derives this itself (D-09/D-15 axis-identity-at-the-boundary discipline). */
function buildOpponentFormNowScope(opponentTag: string): InsightScope {
  return {
    kind: 'player',
    key: `player:${opponentTag}`,
    axes: {},
    filter: (matches: Match[]) => matches,
  };
}

/**
 * Plan 39.1-26 (gap closure): the ONE verdict composition for the hub's own
 * `formNow` — `entity` is the resolved opponent's own display tag (a player
 * identity, never a fighter name; `formNow.ts` never supplies `entity`
 * itself, UI-SPEC §9.2 rule 7). Shared by `renderOpponentFormNowHead` (the
 * slot) and this page's own `claimSummary` (the terminus's active-filter
 * summary), so the two never independently re-derive the same sentence.
 */
function buildOpponentFormNowVerdict(insight: Insight, opponentTag: string, t: TFunction): string {
  const entity = `${t('matchups.vs')} ${opponentTag}`;
  return t(insight.copy.key, { ...insight.copy.values, entity });
}

/**
 * The insight slot's content (UI-SPEC §7.9): `InsightCard`'s head — claim
 * chip, verdict, evidence — WITHOUT the card's own chrome. Mirrors
 * `MatchupChart.tsx`'s `renderFormNowHead` exactly.
 *
 * Plan 39.1-26 (gap closure): gains an optional trailing `door` — the
 * counted-games door this page builds via `buildInsightDoors`, rendered as
 * a `Button asChild` wrapping the host's own `<Link>` inside
 * `data-slot="opponent-form-now-doors"`. `undefined` renders no doors row.
 */
function renderOpponentFormNowHead(
  insight: Insight,
  opponentTag: string,
  t: TFunction,
  locale: string,
  door?: ReactNode,
): ReactElement {
  const chipKind = claimChipKindFor(insight.kind);
  const verdict = buildOpponentFormNowVerdict(insight, opponentTag, t);

  // Plan 39.1-52: the one shared evidence builder (no dangling cue, never
  // "over 0"); the H2H head keeps its cue on the verdict's counted games.
  const count = typeof insight.copy.values.count === 'number' ? insight.copy.values.count : 0;
  const evidence = buildInsightEvidenceLine(insight, t, locale, { cueCount: count });

  return (
    <div className="flex flex-col gap-2" data-slot="opponent-form-now">
      <ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />
      <p
        className="line-clamp-3 text-base leading-6 font-medium text-pretty"
        data-slot="opponent-form-now-verdict"
      >
        {verdict}
      </p>
      {evidence && (
        <p
          className="text-xs leading-4 text-muted-foreground tabular-nums"
          data-slot="opponent-form-now-evidence"
        >
          {evidence}
        </p>
      )}
      {door && (
        <div className="flex flex-wrap gap-2" data-slot="opponent-form-now-doors">
          <Button asChild size="sm">
            {door}
          </Button>
        </div>
      )}
    </div>
  );
}

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

/** The identity `resolveOpponentIdentities` gives a game with an absent or empty opponent tag — the unnamed bucket, never a real opponent. */
const UNKNOWN_OPPONENT_IDENTITY = 'unknown';

export function OpponentHubPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const subjectPath = useSubjectPath();
  const [searchParams, setSearchParams] = useSearchParams();
  const { matches, allMatches, isLoading, isFetching, filterActive } = useFilteredMatches();
  const { data: tournamentEntries } = useTournamentEntries();
  const { data: aliasMap } = useOpponentAliases();
  const { data: noteMap } = useOpponentNotes();
  const { user } = useAuth();
  const [refreshedAt] = useState(() => Date.now());
  const [mergeCandidate, setMergeCandidate] = useState<string | null>(null);
  // Plan 39.1-18: lazy `useState` initializer, not a bare `Date.now()` call
  // in the render body — the React Compiler forbids the latter (see
  // `MatchupChart.tsx`'s `useMatchupFormNow` for the same discipline).
  const [formNowNowMs] = useState(() => Date.now());

  const pathTag = useHubTagFromPathname();

  // D-02: one identity resolver, one hop — the SAME technique the list page
  // uses (build the resolver once over the filtered matches and the alias
  // map, resolve the target, keep matches whose resolved identity matches).
  // No second identity comparison is written anywhere on this page (the
  // prep-brief card's resolver below is the same technique over all matches,
  // code review WEB-02).
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

  // Code review WEB-02: the prep-brief card's inputs are built from ALL
  // matches, never the filtered set. The card's door is a navigation
  // affordance, not an analytics figure, so the Dashboard's source/range
  // filter must not remove a shared event (its debrief door) or the games
  // that carry a provider-id link (its likely-opponent identity match) —
  // the same reason `PrepBriefPage` avoids `useFilteredMatches()`.
  const prepResolve = useMemo(
    () => resolveOpponentIdentities(allMatches, aliasMap ?? {}),
    [allMatches, aliasMap],
  );
  const prepIdentity = useMemo(
    () => (pathTag ? prepResolve({ opponent: pathTag }) : null),
    [prepResolve, pathTag],
  );
  // Code review R3-IN-05: the card needs a REAL identity with at least one
  // game. The identity is `canonicalize(pathTag)`, never null for a present
  // path tag, so without this a typo'd URL, a tag whose games were all
  // deleted and the unknown bucket all mounted the card in the empty state,
  // naming the raw URL tag.
  const prepIdentityMatches = useMemo(
    () =>
      prepIdentity && prepIdentity !== UNKNOWN_OPPONENT_IDENTITY
        ? allMatches.filter((m) => prepResolve(m) === prepIdentity)
        : [],
    [allMatches, prepResolve, prepIdentity],
  );
  // Plan 39.2-10 (TRK-02): the watchlist ref is the resolved canonical tag, and
  // only for a real identity with at least one game — the same gate the prep
  // card uses, so a typo'd URL never offers to track a rival who does not exist.
  const trackOpponentRef =
    prepIdentity && prepIdentity !== UNKNOWN_OPPONENT_IDENTITY && prepIdentityMatches.length > 0
      ? prepIdentity
      : null;
  const prepTournamentBlocks = useMemo(
    () => groupTournamentBlocks(prepIdentityMatches),
    [prepIdentityMatches],
  );
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

  /**
   * CR-01 (39.1-REVIEW): the ONE writer every hub drill goes through. A drill
   * REPLACES an active insight claim, never intersects it — merging a matrix
   * cell / trend point / set into a URL that still carried the H2H door's
   * `claim=` showed `countedMatchIds ∩ drill` under the old verdict, not the
   * games the clicked mark counted (the Matchups `clearFilterAxes` twin).
   */
  function writeHubDrill(axes: Partial<DrillDownAxes>) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(DRILL_DOWN_CLAIM_PARAM);
      for (const [key, value] of buildDrillDownSearch(axes).entries()) {
        next.set(key, value);
      }
      return next;
    });
    scrollToList();
  }

  /** D-05: writes through the plan 38-04 param builder — the sole spelling for every drill-down axis this page composes. */
  function handleSelectCell(cell: MatrixHeatCell) {
    const [myStr, theirStr] = cell.rowKey.split(':');
    writeHubDrill({
      fighterId: myStr != null ? Number(myStr) : undefined,
      vsFighterId: theirStr != null ? Number(theirStr) : undefined,
      stageId: Number(cell.colKey),
    });
  }

  function handleSelectTrendPoint(point: TrendEventPoint) {
    writeHubDrill({ eventKey: point.eventKey });
  }

  /**
   * Phase 38-07 (D-12/D-14): TournamentHistory's set rows write the SAME
   * event-anchor axis `handleSelectTrendPoint` above already writes — one
   * event, one destination shape, regardless of which surface produced it.
   */
  function handleSelectEvent(eventKey: string) {
    writeHubDrill({ eventKey });
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

  // WR-03 (38-REVIEW-FIX): a memoised resolver, never a function-per-render
  // — `FilteredMatchList`'s own doc comment states its narrowing is memoized
  // by array reference AND this resolver's reference (D-16); an unstable
  // reference here defeats that memo on every render even when neither the
  // matches nor the axes actually changed. Plan 39.1-39: a game resolves to
  // its anchor key AND its bin key at every grain, so a bin click and a
  // tournament set row's anchor key each list exactly their own games.
  //
  // Plan 39.1-42 (PD-42-4): plus the form strip's set keys over the SAME
  // `trendSourceMatches` the strip below is built from — a manual play
  // session is one set, a start.gg set its parsed id, and a legacy
  // `game:<id>` key still lands on its one game.
  const eventKeyForMatch = useMemo(() => {
    const anchorKeysForMatch = buildEventKeysForMatch(eventSeries);
    const stripSetKeysForMatch = createFormStripSetKeyResolver(trendSourceMatches);
    return (match: Match): string[] => [
      ...anchorKeysForMatch(match),
      ...stripSetKeysForMatch(match),
    ];
  }, [eventSeries, trendSourceMatches]);

  // Plan 39.1-39 (VIZ-01, UI-SPEC §11 / §10.2): the PLOTTED series is binned
  // by the engine to at most 60 points (identity at or under the bound), and
  // points come only through the shared host mapper with readable,
  // pre-resolved tooltip labels.
  const trendPoints: TrendEventPoint[] = useMemo(
    () =>
      buildEventTrendPoints({
        series: binEventSeries(eventSeries),
        opponentTag: profile?.opponent ?? pathTag ?? '',
        t,
        locale: i18n.language,
      }),
    [eventSeries, profile, pathTag, t, i18n.language],
  );

  // Plan 39.1-18 (UI-SPEC §8.6): the H2H trend's insight slot — `formNow` at
  // opponent-PLAYER scope, resolved over the SAME `trendSourceMatches` the
  // plot itself reads (chip-filtered, optionally narrowed to one opposing
  // character via `vs=`). No page-level `HorizonSwitch` exists on this hub,
  // so this reads `DEFAULT_HORIZON` directly (`HeroStats.tsx`'s own
  // optional-horizon-prop precedent for a page with no switch).
  const trendInsight = useMemo(() => {
    if (!targetIdentity) return null;
    const scope = buildOpponentFormNowScope(targetIdentity);
    const built = OPPONENT_FORM_NOW_TEMPLATE.build({
      matches: trendSourceMatches,
      scope,
      horizon: DEFAULT_HORIZON,
      nowMs: formNowNowMs,
    });
    return built[0] ?? null;
  }, [targetIdentity, trendSourceMatches, formNowNowMs]);

  // Plan 39.1-26 (gap closure, Task 2): the host context the trend's own
  // door must carry — exactly the inputs `chipFilteredMatches`/
  // `trendSourceMatches` above depend on (the un-pooling chips, and a `vs`
  // character narrowing). A prior matrix drill's `fighter`/`stage`/`event`
  // are deliberately never carried: the trend insight was never computed
  // over them. A door is a plain relative `<Link>`, never routed through
  // `setSearchParams` (which merges), so without this carry a followed door
  // would drop the chip/vs state entirely on navigation.
  const hubDoorCarry = useMemo(() => {
    const params = buildDrillDownSearch({ vsFighterId: axesFromUrl.vsFighterId });
    if (hubContext) params.set(HUB_CONTEXT_PARAM, hubContext);
    if (hubSource) params.set(HUB_SOURCE_PARAM, hubSource);
    return params;
  }, [axesFromUrl.vsFighterId, hubContext, hubSource]);

  // Plan 39.1-26 (gap closure, Task 2): the trend's counted-games door — the
  // `kind === 'games'` descriptor of `buildInsightDoors` over the SAME
  // `trendInsight` the terminus below resolves against, anchored to this
  // page's own `#opponent-hub-list` terminus id and carrying the chip/vs
  // context above.
  const trendGamesDoor = trendInsight
    ? buildInsightDoors({
        insight: trendInsight,
        subjectPath,
        anchor: `#${OPPONENT_HUB_LIST_ANCHOR_ID}`,
        carry: hubDoorCarry,
      }).find((door) => door.kind === 'games')
    : undefined;

  // Plan 39.1-26 (gap closure, Task 2): the terminus's claim resolver — a
  // one-element array (this hub has exactly one insight source), memoized so
  // `resolveClaim` below stays a stable reference (WR-03/D-16 precedent).
  const hubInsights = useMemo(() => (trendInsight ? [trendInsight] : []), [trendInsight]);
  const resolveClaimForTerminus = useCallback(
    (claimId: string, ms: Match[]) =>
      resolveInsightClaim({ claimId, insights: hubInsights, matches: ms }),
    [hubInsights],
  );

  // Plan 39.1-26 (gap closure, Task 2): landing is real in a browser
  // (BrowserRouter performs no hash scroll of its own — `AppRouter.tsx`) —
  // this scrolls the terminus into view once per navigation whenever the
  // hash names it, covering the H2H trend door click. WR-02 (39.1-REVIEW):
  // gated on the data having landed (the terminus lives inside the loaded
  // profile branch), so a cold load / shared door URL lands there too.
  useLandingScroll({
    anchorId: OPPONENT_HUB_LIST_ANCHOR_ID,
    ready: !isLoading && profile != null,
  });

  // The set-grouped form strip above the trend plot, replacing the header's
  // ten-pip indicator (`ScoutingHeader.tsx`). Plan 39.1-42: built by the ONE
  // strip derivation every FormStrip host uses (`buildFormStripEvents` over
  // `trendSourceMatches`) instead of `groupEncounters`' one-pseudo-set-per-
  // manual-game rows — Recent Encounters keeps its own grouping (UIX-08).
  // Plan 39.1-42 (UI-SPEC §7.10): collapsed horizons dim nothing; an empty
  // window dims every set.
  const trendRecentWindow = useMemo(() => formStripRecentWindow(trendInsight), [trendInsight]);
  const formStripEvents: FormStripEvent[] = useMemo(
    () => buildFormStripEvents(trendSourceMatches, trendRecentWindow, t, i18n.language),
    [trendSourceMatches, trendRecentWindow, t, i18n.language],
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
    return buildEvidencePacket(profile, tournamentBlocks, user?.email ?? 'you', i18n.language);
  }, [profile, tournamentBlocks, user, i18n.language]);

  // WR-03 (38-REVIEW-FIX): this object literal was rebuilt fresh every
  // render (a NEW reference even when every field's VALUE was unchanged) —
  // the same class of defect the review named for `eventKeyForMatch` above,
  // just for the axes half of `FilteredMatchList`'s D-16 memo key. Fixing
  // only `eventKeyForMatch` while leaving this unstable would have left the
  // memo just as broken, for a different reason, on this same page.
  const terminusAxes: DrillDownAxes = useMemo(
    () => ({
      fighterId: axesFromUrl.fighterId,
      vsFighterId: axesFromUrl.vsFighterId,
      stageId: axesFromUrl.stageId,
      eventKey: axesFromUrl.eventKey,
      claimId: axesFromUrl.claimId,
    }),
    [
      axesFromUrl.fighterId,
      axesFromUrl.vsFighterId,
      axesFromUrl.stageId,
      axesFromUrl.eventKey,
      axesFromUrl.claimId,
    ],
  );
  const sortedOpponentMatches = useMemo(
    () => sortMatchesNewestFirst(opponentMatches),
    [opponentMatches],
  );

  // Plan 39.1-20 (UIX-07, UI-SPEC §7.2): the ONE loading pattern — a
  // skeleton echoing the loaded hub's own section shapes (header, matrix,
  // the 8 + 4 trend | what-they-play/stages row, and the encounters/history
  // list below). Plan 39.1-37: the hub is on PageShell/PageGrid now, so the
  // skeleton's trend row carries the SAME spans as the loaded row.
  if (isLoading) {
    return (
      <PageShell>
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">{t('opponents.loading')}</span>
          <CardSkeleton variant="stat-row" rows={3} statusLabel={t('opponents.loading')} />
          <CardSkeleton variant="chart" statusLabel={t('opponents.loading')} />
          <PageGrid>
            <GridCell span={8}>
              <CardSkeleton variant="chart" statusLabel={t('opponents.loading')} />
            </GridCell>
            <GridCell span={4} stack>
              <CardSkeleton variant="list" rows={3} statusLabel={t('opponents.loading')} />
              <CardSkeleton variant="list" rows={3} statusLabel={t('opponents.loading')} />
            </GridCell>
          </PageGrid>
          <CardSkeleton variant="list" rows={4} statusLabel={t('opponents.loading')} />
          <CardSkeleton variant="list" rows={3} statusLabel={t('opponents.loading')} />
        </div>
      </PageShell>
    );
  }

  // Plan 39.1-20: a background refetch (matches already loaded once) holds
  // the previous frame at reduced opacity instead of flashing a skeleton.
  const isRefetching = isFetching && !isLoading;

  const displayTag = profile?.opponent ?? pathTag ?? '';

  // Code review R2-WR-01: the prep-brief card depends only on `allMatches`
  // (its identity, resolver and tournament blocks — WEB-02) and never on
  // the FILTERED `profile`. `profile` is null whenever the Dashboard's
  // source/range filter leaves no game against this opponent (e.g. a
  // `manual` filter over an opponent met only at a synced event), and the
  // card used to live only inside the non-null branch, so its debrief door
  // vanished exactly then. The element is built here, outside that branch:
  // the hub body mounts it at its UI-SPEC D.2 slot, and the empty state
  // mounts it right below the empty-state panel. Exactly one renders — and
  // only for a real identity with at least one game (code review R3-IN-05).
  const prepBriefCard =
    prepIdentity && prepIdentityMatches.length > 0 ? (
      <HubPrepBriefCard
        opponentIdentity={prepIdentity}
        opponentTag={displayTag}
        resolveOpponent={prepResolve}
        tournamentBlocks={prepTournamentBlocks}
      />
    ) : null;

  // Plan 39.1-26 (gap closure, Task 2): the terminus's active-filter summary
  // when the active claim is this page's OWN trend insight — the SAME
  // verdict sentence the slot above renders, via `buildOpponentFormNowVerdict`.
  const hubClaimSummary =
    axesFromUrl.claimId != null && trendInsight != null && trendInsight.id === axesFromUrl.claimId
      ? buildOpponentFormNowVerdict(trendInsight, displayTag, t)
      : undefined;

  // Plan 39.1-37 (UIX-01): the hub renders inside the one page container
  // (content capped at 1440px); its header row stays the first child.
  return (
    <PageShell>
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">{displayTag}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* Plan 39.2-10 (T-04): Track is the FIRST control of the group. It tracks the resolved canonical identity, so an alias-only URL never lists the same rival under two tags. */}
          {trackOpponentRef && (
            <TrackToggle kind="opponent" itemRef={trackOpponentRef} name={displayTag} />
          )}
          {profile && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className={`px-0 ${MUTED_LINK_TONE}`}
              onClick={() => setMergeCandidate(profile.opponent)}
            >
              {t('opponents.list.mergeInto')}
            </Button>
          )}
          {evidencePacket && <ExportH2HButton packet={evidencePacket} />}
        </div>
      </div>

      {!profile ? (
        <>
          <div className="flex items-center justify-center rounded-lg border border-dashed p-16 text-center text-sm text-muted-foreground">
            {t('opponents.hub.empty', { opponent: displayTag })}
          </div>
          {/* Code review R2-WR-01: the card survives an empty FILTERED profile. */}
          {prepBriefCard}
        </>
      ) : (
        <div
          key={profile.opponent}
          data-slot="opponent-hub-body"
          className={cn(
            'flex flex-col gap-6',
            isRefetching &&
              'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
          )}
        >
          {/* Identity header + head-to-head summary */}
          <div className="flex flex-col gap-2">
            <ScoutingHeader
              profile={profile}
              encounterContext={encounterContext}
              source={profile.source}
            />
            {headToHeadSample && <SampleCue sample={headToHeadSample} />}
          </div>

          {/* Filter bar (D-05/D-10). Plan 39.1-38 (design-audit row 7.5, UI-SPEC
              §10.4): one unboxed PageFilterRow — the three selects and the
              mixed-context badge lead, the two context/source toggle groups
              trail; no border, no padding box, no card. */}
          <PageFilterRow
            leading={
              <>
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
                    value={
                      axesFromUrl.stageId != null ? String(axesFromUrl.stageId) : ALL_AXIS_VALUE
                    }
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
                {crossTab && (
                  <div className="flex flex-col gap-1">
                    <CohortCompositionLine cohort={crossTab.cohort} />
                    <MixedContextBadge cohort={crossTab.cohort} showDetail />
                  </div>
                )}
              </>
            }
            trailing={
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
            }
          />

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

          {/* Event-anchored trend (OPP-03) — Plan 39.1-18: gains the formNow
              insight slot and a 20-tick set-grouped form strip above the
              plot (UI-SPEC §8.6), replacing the header's ten-pip indicator. */}
          {/*
            Plan 39.1-37 — OWNER DECISION 2026-09-25 (overrides UI-SPEC §8.6's
            "39.1 leaves the hub layout unchanged"): UI-SPEC §6.1's chart = 8 + 4
            row. The H2H trend card sits in an 8-col cell and the two short
            absorbed scouting lists (What they play, Stages — content
            unchanged, D-12; Phase 38-07 D-14 identity threading unchanged) are
            stacked in the 4-col cell beside it. Below lg every cell spans 12,
            in the same DOM order as before.
          */}
          <PageGrid>
            <GridCell span={8} stack>
              <ChartCard
                title={t('opponents.trend.title')}
                abstained={
                  trendPoints.length === 0 ? { gamesNeeded: ABSTENTION_FLOOR_GAMES } : null
                }
                insight={
                  trendInsight
                    ? renderOpponentFormNowHead(
                        trendInsight,
                        displayTag,
                        t,
                        i18n.language,
                        trendGamesDoor ? (
                          <Link to={trendGamesDoor.href}>
                            {t('insights.door.seeGames', { count: trendGamesDoor.count })}
                          </Link>
                        ) : undefined,
                      )
                    : null
                }
              >
                <FormStrip
                  events={formStripEvents}
                  limit={20}
                  // Plan 39.1-42: the kit's legend and foot formatters; the hub
                  // passes no title (no head) and keeps its empty-window note.
                  labels={{
                    ...formStripLabels(t),
                    // WR-03: names the games actually DRAWN of the total (kit-computed).
                    summary: ({ shown, total }) =>
                      t('analytics.strip.aria', { count: total, shown }),
                    empty: <span>{t('analytics.strip.empty')}</span>,
                    windowNote:
                      trendInsight && trendInsight.window.games === 0
                        ? t(`analytics.strip.windowEmpty.${DEFAULT_HORIZON}`)
                        : undefined,
                  }}
                  onSelectSet={handleSelectEvent}
                />
                <TrendLine
                  mode="event"
                  points={trendPoints}
                  onSelectPoint={handleSelectTrendPoint}
                />
              </ChartCard>
              {/* Plan 39-12 (PREP-05, D-10/D-11): the free prep-brief card — own-account only, renders nothing under a coach or workspace route. Mounted from `prepBriefCard` (built from ALL matches) at the UI-SPEC D.2 slot, directly under the H2H trend in the trend's own 8-col cell (39.1-37 grid). */}
              {prepBriefCard}
            </GridCell>
            <GridCell span={4} stack>
              <WhatTheyPlayTable
                byTheirFighter={profile.byTheirFighter}
                belowFloor={profile.byTheirFighterBelowFloor}
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
            </GridCell>
          </PageGrid>
          <RecentEncounters
            matches={profile.recent}
            tournamentLinkForMatch={tournamentLinkForMatch}
            onSeeAllInMatchList={scrollToList}
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
              resolveClaim={resolveClaimForTerminus}
              claimSummary={hubClaimSummary}
              eventKeyForMatch={eventKeyForMatch}
              onClearFilters={() => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.delete(DRILL_DOWN_FIGHTER_PARAM);
                  next.delete(DRILL_DOWN_VS_PARAM);
                  next.delete(DRILL_DOWN_STAGE_PARAM);
                  next.delete(DRILL_DOWN_EVENT_PARAM);
                  next.delete(DRILL_DOWN_CLAIM_PARAM);
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
    </PageShell>
  );
}

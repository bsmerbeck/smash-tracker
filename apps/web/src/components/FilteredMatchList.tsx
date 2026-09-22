import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronDown, Trash2, Video } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DrillableRow } from '@/components/DrillableRow';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { localizedFighterName } from '@/lib/fighterNames';
import { useDeleteMatch } from '@/hooks/useDeleteMatch';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { cn } from '@/lib/utils';
import { describeEventAxisGames } from '@/lib/eventAxisSummary';
import { matchesDrillDown, type DrillDownAxes, type EventKeyResolver } from '@/lib/drillDownParams';

/**
 * Phase 38 (D-07/D-08): the ONE terminus every drill-down in this milestone
 * ends at. Owns no URL and no persisted state — a host reads the drill-down
 * params (`drillDownParams.ts`), resolves them into `axes`, sorts its own
 * array with `sortMatchesNewestFirst`, and hands BOTH the sorted (but NOT
 * yet axis-narrowed) array and the resolved `axes` to this component. This
 * component performs the narrowing itself, via `matchesDrillDown`, memoized
 * by the source array reference and the axes object (D-16) — it never
 * re-sorts, and the host must never narrow a second time upstream (that
 * would just be redundant, but keeping narrowing in exactly one place is
 * what keeps every drill-down consumer's behaviour identical).
 *
 * Row contract (D-08): a match with an attached VOD is a whole-row `<Link>`
 * to the subject-aware `/vod?match=<id>` route; a match without one is a
 * whole-row `<button>` that toggles an inline expansion (single-open
 * accordion) showing the full match facts and, when the host supplies a
 * resolver, a link to the match's tournament. Never both a link and an
 * expander on the same row. The "whole row" click target is implemented as
 * one absolutely-positioned interactive element (`DrillableRow`'s `overlay`
 * shape, D-14) inside the row's first cell (`position: relative` on the
 * containing row) — every other cell/fact in the row stays plain, so the
 * table keeps real per-column semantics instead of collapsing into one
 * giant cell.
 *
 * Phase 38-08 (UI-SPEC E4): this component owns a SECOND, mutually
 * exclusive layout — a narrow/stacked list — selected by the same two-part
 * responsive mechanism `MatrixHeat.tsx` established in 38-03: a module-scope
 * `matchMedia` query constant, a read-once `useIsNarrowViewport()` hook, and
 * an explicit `layout` override prop that bypasses the media check entirely
 * (the host/test affordance that makes both branches reachable under
 * jsdom, whose `window.matchMedia` is unimplemented and always resolves the
 * un-stubbed default to the table branch). Exactly one of the two layout
 * roots (`data-slot="filtered-match-table"` / `data-slot="filtered-match-stack"`)
 * mounts per render — never the paired `sm:hidden`/`hidden sm:` idiom, which
 * would double every row-count assertion. The single `matchesDrillDown`
 * narrowing owner stays in the parent; both renderers consume its output
 * array only. One shared per-match fact builder (`buildMatchRowFacts`) and
 * one shared row-overlay element (`MatchRowOverlay`) feed BOTH renderers —
 * the stacked layout is a layout change only, never a second content or
 * behaviour definition.
 */

/** The ONE shared predicate for "does this match have an attached VOD?" — every row branch reads through this, never an inline `match.vodUrl != null` check. */
export function matchHasAttachedVideo(match: Match): boolean {
  return match.vodUrl != null;
}

export type FilteredMatchListLayout = 'table' | 'stack';

/**
 * UIX-02 bound (plan 39.1-28, owner decision 2026-09-22: "conform to spec" —
 * UI-SPEC §6.4, "<= 100 rows per DOM pass + 'Show 50 more'"). Phase 38's
 * narrow drill-down axes (one event/opponent/stage) never mounted more than
 * a handful of rows, so the terminus mounted every narrowed match with no
 * bound; Phase 39.1's account-scoped insight doors (`settingGap`,
 * `rosterCore`, the full-history roster reads) can narrow to thousands of
 * rows on a real account. This caps what MOUNTS on first render, never what
 * is PRINTED — the active-filter summary and `data-total-rows` always state
 * the full narrowed count. Plan 39.1-23 originally shipped this bound at 200
 * rows with a one-step "Show all" reveal; the owner rejected that as
 * over-spec relative to REQUIREMENTS.md's "no list renders more than 100
 * rows in one pass" and UI-SPEC §6.4's literal text, so this plan lowers the
 * cap to 100 and replaces the one-step reveal with `FILTERED_MATCH_LIST_PAGE_SIZE`-row
 * paging below.
 */
export const FILTERED_MATCH_LIST_ROW_CAP = 100;

/**
 * UIX-02 bound (plan 39.1-28): the number of additional rows one activation
 * of the "Show N more" paging control mounts. See `FILTERED_MATCH_LIST_ROW_CAP`
 * above for the first-pass bound this pairs with.
 */
export const FILTERED_MATCH_LIST_PAGE_SIZE = 50;

/** Tailwind's `sm` breakpoint (640px) — matches the UI-SPEC's "Mobile (<640px)" clause and `MatrixHeat.tsx`'s own constant. */
const NARROW_LAYOUT_QUERY = '(max-width: 639px)';

/**
 * Read-once `matchMedia` check, the same shape `MatrixHeat.tsx` uses:
 * guard-before-use, default to the wide/table layout when the API is
 * unavailable. No change listener — a read-once value keeps both branches
 * deterministic under test. `apps/web/src/test/setup.ts` does not stub
 * `window.matchMedia`, so under jsdom this always resolves to `false`
 * (the table layout) unless a test installs its own stub.
 */
function useIsNarrowViewport(): boolean {
  const [isNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(NARROW_LAYOUT_QUERY).matches
      : false,
  );
  return isNarrow;
}

export interface FilteredMatchListProps {
  /** The already newest-first-sorted (via `sortMatchesNewestFirst`) but NOT yet axis-narrowed match array — this component narrows it internally through `matchesDrillDown`. Never re-sorted here. */
  matches: Match[];
  /** The resolved drill-down axes to narrow `matches` by — also drives the summary bar, the clear-filters affordance and pinned-column omission. */
  axes: DrillDownAxes;
  /**
   * Plan 39.1-19 (DD-09): resolves `axes.claimId` (an `Insight.id`) to the
   * predicate the host's own insight engine computation actually counted —
   * supplied by the host, which is the only party that has the `Insight[]`
   * an id can be looked up against (this component owns no insight-engine
   * import, per D-05/D-07's "one contract, one terminus"). Applied IN
   * ADDITION to the six existing axes below (an intersection, never a
   * replacement); when omitted, or when it returns `undefined` for a
   * stale/unknown id, the list falls back to whatever the remaining axes
   * alone narrow to — never a throw, never a not-found state.
   */
  resolveClaim?: (claimId: string, matches: Match[]) => Match[] | undefined;
  /**
   * The insight's label-and-statement head (e.g. "vs Terry · last 30
   * games") shown in the active-filter summary line when `axes.claimId` is
   * present — supplied by the host for the same reason as `resolveClaim`
   * above (no insight-engine import here). Ignored when `axes.claimId` is
   * absent.
   */
  claimSummary?: string;
  /** Resolves a per-match event key (or every key the match is anchored under) for the `eventKey` axis (mirrors the resolver the host's own predicate would use) — required only when a host narrows by event. */
  eventKeyForMatch?: EventKeyResolver;
  /** Renders a human-readable label for a match's event, for the Event column. Falls back to the match's own tournament/event name field. */
  eventLabelForMatch?: (match: Match) => string | undefined;
  /** Renders a tournament-detail link for a match's inline expansion, when the host can resolve one. Omitted entirely (no tournament line) when not supplied. */
  tournamentLinkForMatch?: (match: Match) => { href: string; label: string } | undefined;
  /** Invoked by the "Clear filters" button — the host owns what "clear" means, because the host owns the URL. Omitting this hides the button but not the summary line itself. */
  onClearFilters?: () => void;
  /** Replaces the WHOLE component with the existing muted loading line — never an empty table shell underneath it. Set only by a host that fetches independently of its parent. */
  loading?: boolean;
  /** Renders the existing delete-match affordance (Matchups-local behaviour, preserved verbatim). Hosts that never had delete must leave this unset. */
  showDelete?: boolean;
  /** Test/host affordance forcing which of the two layout forms renders, bypassing the `matchMedia` check above (phase 38-08). */
  layout?: FilteredMatchListLayout;
}

function hasActiveAxis(axes: DrillDownAxes): boolean {
  return (
    axes.fighterId != null ||
    axes.vsFighterId != null ||
    axes.stageId != null ||
    axes.eventKey != null ||
    axes.from != null ||
    axes.to != null ||
    axes.claimId != null
  );
}

/**
 * Joins the human-readable description of every active axis with " · " (UI-SPEC's filter-summary join). `claimSummary` (the insight's label-and-statement head) leads when a claim axis is present (plan 39.1-19).
 *
 * WR-03 (39.1-REVIEW): the `event` axis is an opaque host key (a set id, `game:<matchId>`, an anchor or period key) and is never printed — `eventGames` (the games the list resolved to) are described in words instead (`describeEventAxisGames`).
 */
function buildFilterSummaryText(
  axes: DrillDownAxes,
  t: TFunction,
  eventGames: Match[],
  claimSummary?: string,
): string {
  const parts: string[] = [];
  if (axes.claimId != null && claimSummary) {
    parts.push(claimSummary);
  }
  const fighterName = axes.fighterId != null ? localizedFighterName(axes.fighterId, t) : null;
  const vsFighterName = axes.vsFighterId != null ? localizedFighterName(axes.vsFighterId, t) : null;
  if (fighterName && vsFighterName) {
    parts.push(`${fighterName} vs ${vsFighterName}`);
  } else if (fighterName) {
    parts.push(fighterName);
  } else if (vsFighterName) {
    parts.push(vsFighterName);
  }
  if (axes.stageId != null) {
    parts.push(stagesById.get(axes.stageId)?.name ?? t('common.unknown'));
  }
  if (axes.eventKey != null) {
    parts.push(describeEventAxisGames(eventGames, t) ?? t('common.unknown'));
  }
  if (axes.from != null || axes.to != null) {
    const from = axes.from != null ? new Date(axes.from).toLocaleDateString() : null;
    const to = axes.to != null ? new Date(axes.to).toLocaleDateString() : null;
    parts.push(from && to && from !== to ? `${from} – ${to}` : (from ?? to ?? ''));
  }
  return parts.filter(Boolean).join(' · ');
}

interface MatchRowFacts {
  fighterSprite: ReturnType<typeof getFighterById>;
  opponentSprite: ReturnType<typeof getFighterById>;
  stageName: string;
  eventLabel: string;
  opponentTag: string;
  resultText: string;
  hasVideo: boolean;
  tournamentLink: { href: string; label: string } | undefined;
}

/**
 * ONE shared per-match fact builder (phase 38-08) — both the table renderer
 * and the stack renderer read every derived fact through this function,
 * never a second inline computation.
 */
function buildMatchRowFacts(
  match: Match,
  t: TFunction,
  eventLabelForMatch?: (match: Match) => string | undefined,
  tournamentLinkForMatch?: (match: Match) => { href: string; label: string } | undefined,
): MatchRowFacts {
  const fighterSprite = getFighterById(match.fighter_id);
  const opponentSprite = getFighterById(match.opponent_id);
  const stageId = match.map?.id ?? 0;
  const stageName =
    stageId !== 0
      ? (stagesById.get(stageId)?.name ?? match.map?.name ?? t('common.unknown'))
      : t('common.unknown');
  const eventLabel = eventLabelForMatch?.(match) ?? match.tournamentName ?? match.eventName ?? '';
  const opponentTag = match.opponent || t('common.unknown');
  const resultText = match.win ? t('common.win') : t('common.loss');
  const hasVideo = matchHasAttachedVideo(match);
  const tournamentLink = tournamentLinkForMatch?.(match);
  return {
    fighterSprite,
    opponentSprite,
    stageName,
    eventLabel,
    opponentTag,
    resultText,
    hasVideo,
    tournamentLink,
  };
}

/**
 * ONE shared row-overlay element (phase 38-08) — both the table row's first
 * cell and the stacked row render this exact element. Reuses `DrillableRow`
 * in its `overlay` shape (D-14): DOM-equivalent to the hand-rolled overlay
 * this component used before 38-08, so no behaviour or accessible-name
 * change accompanies the layout split.
 */
function MatchRowOverlay({
  matchId,
  facts,
  isExpanded,
  onToggleExpand,
  subjectPath,
  t,
}: {
  matchId: string;
  facts: MatchRowFacts;
  isExpanded: boolean;
  onToggleExpand: () => void;
  subjectPath: (path: string) => string;
  t: TFunction;
}) {
  const ariaLabel = facts.hasVideo
    ? t('shared.filteredMatchList.rowVod', {
        opponent: facts.opponentTag,
        stage: facts.stageName,
        result: facts.resultText,
      })
    : t('shared.filteredMatchList.rowExpand', {
        opponent: facts.opponentTag,
        stage: facts.stageName,
        result: facts.resultText,
      });

  if (facts.hasVideo) {
    return (
      <DrillableRow as="overlay" to={subjectPath(`/vod?match=${matchId}`)} ariaLabel={ariaLabel} />
    );
  }
  return (
    <DrillableRow
      as="overlay"
      onActivate={onToggleExpand}
      expanded={isExpanded}
      ariaLabel={ariaLabel}
    />
  );
}

export function FilteredMatchList({
  matches,
  axes,
  resolveClaim,
  claimSummary,
  eventKeyForMatch,
  eventLabelForMatch,
  tournamentLinkForMatch,
  onClearFilters,
  loading = false,
  showDelete = false,
  layout,
}: FilteredMatchListProps) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const deleteMatch = useDeleteMatch();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Match | null>(null);
  // Hook order stays unconditional: called above the loading early return.
  const isNarrowViewport = useIsNarrowViewport();
  const resolvedLayout: FilteredMatchListLayout = layout ?? (isNarrowViewport ? 'stack' : 'table');

  // D-16: memoized by the source array reference and the axes object — the
  // host is responsible for handing a stable `axes` reference (e.g. via its
  // own `useMemo`) when it wants this to actually skip recomputation.
  //
  // Plan 39.1-19 (DD-09): the claim axis is applied IN ADDITION to the six
  // existing axes above, via the host-supplied `resolveClaim` resolver —
  // never inside `matchesDrillDown` itself (that stays a Phase 38 module
  // touching no insight-engine concern). A resolver that returns `undefined`
  // (no resolver supplied, or the id is stale/unknown) leaves the list
  // showing whatever the remaining axes alone narrow to.
  // WR-B02 (39.1-REVIEW.md): `claimResolvedOk` is threaded out of this SAME
  // computation (never a second `resolveClaim` call) so the summary bar
  // below can tell "the claim resolved, `claimSummary` describes what's
  // shown" apart from "a stale/unknown claim id fell back to the remaining
  // axes" — in the fallback case `claimSummary` still describes the ORIGINAL
  // claim, not the narrower set actually rendered, so it must not be shown.
  const { narrowedMatches, claimResolvedOk } = useMemo(() => {
    const axisNarrowed = matches.filter((match) => matchesDrillDown(match, axes, eventKeyForMatch));
    if (axes.claimId == null || !resolveClaim) {
      return { narrowedMatches: axisNarrowed, claimResolvedOk: true };
    }
    const claimResolved = resolveClaim(axes.claimId, matches);
    if (claimResolved == null) {
      return { narrowedMatches: axisNarrowed, claimResolvedOk: false };
    }
    const claimedIds = new Set(claimResolved.map((match) => match.id));
    return {
      narrowedMatches: axisNarrowed.filter((match) => claimedIds.has(match.id)),
      claimResolvedOk: true,
    };
  }, [matches, axes, eventKeyForMatch, resolveClaim]);

  // Plan 39.1-28 (UIX-02, owner decision 2026-09-22): the paging ladder.
  // `rootId` names whichever layout root actually mounts (table or stack are
  // mutually exclusive) so the paging control's `aria-controls` always
  // points at a real element. `visibleCount` replaces plan 39.1-23's
  // one-step `expanded` boolean — the first pass mounts
  // `FILTERED_MATCH_LIST_ROW_CAP` rows, and each activation of the paging
  // control mounts up to `FILTERED_MATCH_LIST_PAGE_SIZE` more.
  const [visibleCount, setVisibleCount] = useState(FILTERED_MATCH_LIST_ROW_CAP);
  const rootId = useId();

  // A re-narrowing must not keep stale paging progress. WR-07 (39.1-REVIEW):
  // "re-narrowing" means an axis VALUE changed — keyed on the axes' own
  // values, never on the `narrowedMatches` array reference, which also
  // changes on a refetch, a deleted row, or a host's claim resolver being
  // rebuilt (a rail card dismissed) while the narrowing itself is the same;
  // those used to snap the list back to the cap. A shrunken list needs no
  // reset: `slice` below clamps to whatever remains. "Adjusting state when a
  // prop changes" (reset during render, not an Effect — mirrors
  // `TimestampRow.tsx`'s `trackedIsEditing` pattern, and this codebase's own
  // react-compiler lint rule flags the equivalent
  // `useEffect(() => setState(...), [dep])` form as a
  // synchronous-setState-in-an-effect cascading-render risk).
  const narrowingKey = JSON.stringify([
    axes.fighterId ?? null,
    axes.vsFighterId ?? null,
    axes.stageId ?? null,
    axes.eventKey ?? null,
    axes.from ?? null,
    axes.to ?? null,
    axes.claimId ?? null,
  ]);
  const [trackedNarrowingKey, setTrackedNarrowingKey] = useState(narrowingKey);
  if (narrowingKey !== trackedNarrowingKey) {
    setTrackedNarrowingKey(narrowingKey);
    setVisibleCount(FILTERED_MATCH_LIST_ROW_CAP);
  }

  const mountedMatches = narrowedMatches.slice(0, visibleCount);
  const remaining = narrowedMatches.length - mountedMatches.length;
  const nextPageSize = Math.min(FILTERED_MATCH_LIST_PAGE_SIZE, remaining);
  const pagingControlVisible = remaining > 0;
  // Shown whenever the FULL narrowed count exceeds the cap — including once
  // the final page is revealed (`remaining === 0`) — so paging progress
  // stays announced to assistive technology throughout, not just mid-page.
  const progressVisible = narrowedMatches.length > FILTERED_MATCH_LIST_ROW_CAP;

  // The paging control unmounts itself once the activation that reveals the
  // final page fires; move focus to the (now-larger) list root at exactly
  // that point so it never falls back to <body>. Earlier activations leave
  // focus on the control itself — it stays mounted (pages remain), so the
  // browser keeps native post-click focus there with no extra handling.
  // `shouldFocusRootRef` is set directly at the click that will exhaust the
  // list (never inferred from a before/after `remaining` comparison), so a
  // re-narrowing that happens to land exactly on a full final page never
  // gets misread as "the paging control's own final activation". A ref
  // (mutated, not `setState`) sidesteps the react-compiler lint rule that
  // flags a synchronous `setState` inside an effect as a cascading-render
  // risk — this effect runs after every commit but only ever ACTS on the
  // one commit right after the exhausting click.
  const shouldFocusRootRef = useRef(false);
  useEffect(() => {
    if (shouldFocusRootRef.current) {
      shouldFocusRootRef.current = false;
      document.getElementById(rootId)?.focus();
    }
  });

  function handleShowMore() {
    const next = visibleCount + FILTERED_MATCH_LIST_PAGE_SIZE;
    setVisibleCount(next);
    if (next >= narrowedMatches.length) {
      shouldFocusRootRef.current = true;
    }
  }

  if (loading) {
    return <div className="text-muted-foreground">{t('shared.filteredMatchList.loading')}</div>;
  }

  const activeAxes = hasActiveAxis(axes);
  const hideMyCharacterColumn = axes.fighterId != null;
  const hideTheirCharacterColumn = axes.vsFighterId != null;
  const hideStageColumn = axes.stageId != null;
  const columnCount =
    4 +
    (hideMyCharacterColumn ? 0 : 1) +
    (hideTheirCharacterColumn ? 0 : 1) +
    (hideStageColumn ? 0 : 1) +
    (showDelete ? 1 : 0);

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      await deleteMatch.mutateAsync(pendingDelete.id);
      toast.success(t('shared.matchDelete.deleted'));
    } catch {
      toast.error(t('shared.matchDelete.deleteFailed'));
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {activeAxes && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/50 p-3">
          <p className="text-sm text-muted-foreground">
            {t('shared.filteredMatchList.summary', {
              count: narrowedMatches.length,
              filters: buildFilterSummaryText(
                axes,
                t,
                narrowedMatches,
                claimResolvedOk ? claimSummary : undefined,
              ),
            })}
          </p>
          {onClearFilters && (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              {t('shared.filteredMatchList.clear')}
            </Button>
          )}
        </div>
      )}

      {narrowedMatches.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/50 px-4 py-3 text-sm">
          <span className="text-muted-foreground">{t('shared.filteredMatchList.empty')}</span>
        </div>
      ) : (
        <>
          <div className="max-h-[500px] overflow-y-auto">
            {resolvedLayout === 'stack' ? (
              <ul
                id={rootId}
                tabIndex={-1}
                data-total-rows={narrowedMatches.length}
                className="flex flex-col gap-2"
                data-slot="filtered-match-stack"
              >
                {mountedMatches.map((match) => {
                  const facts = buildMatchRowFacts(
                    match,
                    t,
                    eventLabelForMatch,
                    tournamentLinkForMatch,
                  );
                  const isExpanded = expandedId === match.id;

                  return (
                    <Fragment key={match.id}>
                      <li className="relative flex flex-wrap items-center justify-between gap-3 rounded-md border p-2 hover:bg-accent">
                        <MatchRowOverlay
                          matchId={match.id}
                          facts={facts}
                          isExpanded={isExpanded}
                          onToggleExpand={() => setExpandedId(isExpanded ? null : match.id)}
                          subjectPath={subjectPath}
                          t={t}
                        />
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-sm text-muted-foreground">
                            {new Date(match.time).toLocaleDateString(i18n.language)}
                          </span>
                          <span className="text-sm">{facts.opponentTag}</span>
                          {(!hideMyCharacterColumn || !hideTheirCharacterColumn) && (
                            <span className="flex items-center gap-1 text-sm">
                              {!hideMyCharacterColumn && (
                                <>
                                  {facts.fighterSprite?.url && (
                                    <img
                                      src={facts.fighterSprite.url}
                                      alt=""
                                      className="size-5 object-contain"
                                    />
                                  )}
                                  {facts.fighterSprite
                                    ? localizedFighterName(match.fighter_id, t)
                                    : '—'}
                                </>
                              )}
                              {!hideMyCharacterColumn && !hideTheirCharacterColumn && (
                                <span className="text-xs text-muted-foreground">
                                  {t('matchups.vs')}
                                </span>
                              )}
                              {!hideTheirCharacterColumn && (
                                <>
                                  {facts.opponentSprite?.url && (
                                    <img
                                      src={facts.opponentSprite.url}
                                      alt=""
                                      className="size-5 object-contain"
                                    />
                                  )}
                                  {facts.opponentSprite
                                    ? localizedFighterName(match.opponent_id, t)
                                    : '—'}
                                </>
                              )}
                            </span>
                          )}
                          {!hideStageColumn && <span className="text-sm">{facts.stageName}</span>}
                          {facts.eventLabel && (
                            <span className="text-xs text-muted-foreground">
                              {facts.eventLabel}
                            </span>
                          )}
                        </div>
                        <span className="flex items-center gap-2">
                          <Badge variant={match.win ? 'success' : 'destructive'}>
                            {facts.resultText}
                          </Badge>
                          {facts.hasVideo ? (
                            <Video className="size-3.5 text-muted-foreground" aria-hidden="true" />
                          ) : (
                            <ChevronDown
                              className={cn(
                                'size-4 shrink-0 text-muted-foreground transition-transform',
                                isExpanded && 'rotate-180',
                              )}
                              aria-hidden="true"
                            />
                          )}
                          {showDelete && (
                            <span className="relative">
                              <Button
                                variant="outline"
                                size="icon-sm"
                                aria-label={t('shared.matchDelete.aria')}
                                onClick={() => setPendingDelete(match)}
                              >
                                <Trash2 />
                              </Button>
                            </span>
                          )}
                        </span>
                      </li>
                      {isExpanded && !facts.hasVideo && (
                        <li className="flex flex-col gap-1 rounded-md border border-dashed p-2 text-sm text-muted-foreground">
                          <p>
                            {facts.fighterSprite
                              ? localizedFighterName(match.fighter_id, t)
                              : t('common.unknown')}{' '}
                            {t('matchups.vs')}{' '}
                            {facts.opponentSprite
                              ? localizedFighterName(match.opponent_id, t)
                              : t('common.unknown')}
                          </p>
                          <p>{facts.stageName}</p>
                          <p>{new Date(match.time).toLocaleString(i18n.language)}</p>
                          {facts.tournamentLink && (
                            <Link
                              to={facts.tournamentLink.href}
                              className="text-primary hover:underline"
                            >
                              {facts.tournamentLink.label}
                            </Link>
                          )}
                        </li>
                      )}
                    </Fragment>
                  );
                })}
              </ul>
            ) : (
              <div data-slot="filtered-match-table">
                <Table id={rootId} tabIndex={-1} data-total-rows={narrowedMatches.length}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('matchups.table.date')}</TableHead>
                      <TableHead>{t('matchups.opponent')}</TableHead>
                      {!hideMyCharacterColumn && (
                        <TableHead>{t('shared.filteredMatchList.columnMyCharacter')}</TableHead>
                      )}
                      {!hideTheirCharacterColumn && (
                        <TableHead>{t('shared.filteredMatchList.columnTheirCharacter')}</TableHead>
                      )}
                      {!hideStageColumn && <TableHead>{t('matchups.stageTable.stage')}</TableHead>}
                      <TableHead>{t('shared.filteredMatchList.columnEvent')}</TableHead>
                      <TableHead>{t('matchups.table.result')}</TableHead>
                      {showDelete && (
                        <TableHead className="text-right">{t('matchups.table.manage')}</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mountedMatches.map((match) => {
                      const facts = buildMatchRowFacts(
                        match,
                        t,
                        eventLabelForMatch,
                        tournamentLinkForMatch,
                      );
                      const isExpanded = expandedId === match.id;

                      return (
                        <Fragment key={match.id}>
                          <TableRow className="relative hover:bg-accent">
                            <TableCell className="text-sm text-muted-foreground">
                              <MatchRowOverlay
                                matchId={match.id}
                                facts={facts}
                                isExpanded={isExpanded}
                                onToggleExpand={() => setExpandedId(isExpanded ? null : match.id)}
                                subjectPath={subjectPath}
                                t={t}
                              />
                              {new Date(match.time).toLocaleDateString(i18n.language)}
                            </TableCell>
                            <TableCell className="text-sm">{facts.opponentTag}</TableCell>
                            {!hideMyCharacterColumn && (
                              <TableCell>
                                <span className="flex items-center gap-1 text-sm">
                                  {facts.fighterSprite?.url && (
                                    <img
                                      src={facts.fighterSprite.url}
                                      alt=""
                                      className="size-5 object-contain"
                                    />
                                  )}
                                  {facts.fighterSprite
                                    ? localizedFighterName(match.fighter_id, t)
                                    : '—'}
                                </span>
                              </TableCell>
                            )}
                            {!hideTheirCharacterColumn && (
                              <TableCell>
                                <span className="flex items-center gap-1 text-sm">
                                  {facts.opponentSprite?.url && (
                                    <img
                                      src={facts.opponentSprite.url}
                                      alt=""
                                      className="size-5 object-contain"
                                    />
                                  )}
                                  {facts.opponentSprite
                                    ? localizedFighterName(match.opponent_id, t)
                                    : '—'}
                                </span>
                              </TableCell>
                            )}
                            {!hideStageColumn && (
                              <TableCell className="text-sm">{facts.stageName}</TableCell>
                            )}
                            <TableCell className="text-sm text-muted-foreground">
                              {facts.eventLabel}
                            </TableCell>
                            <TableCell>
                              <span className="flex items-center gap-2">
                                <Badge variant={match.win ? 'success' : 'destructive'}>
                                  {facts.resultText}
                                </Badge>
                                {facts.hasVideo ? (
                                  <Video
                                    className="size-3.5 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <ChevronDown
                                    className={cn(
                                      'size-4 shrink-0 text-muted-foreground transition-transform',
                                      isExpanded && 'rotate-180',
                                    )}
                                    aria-hidden="true"
                                  />
                                )}
                              </span>
                            </TableCell>
                            {showDelete && (
                              <TableCell className="relative text-right">
                                <Button
                                  variant="outline"
                                  size="icon-sm"
                                  aria-label={t('shared.matchDelete.aria')}
                                  onClick={() => setPendingDelete(match)}
                                >
                                  <Trash2 />
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                          {isExpanded && !facts.hasVideo && (
                            <TableRow>
                              <TableCell colSpan={columnCount}>
                                <div className="flex flex-col gap-1 py-2 text-sm text-muted-foreground">
                                  <p>
                                    {facts.fighterSprite
                                      ? localizedFighterName(match.fighter_id, t)
                                      : t('common.unknown')}{' '}
                                    {t('matchups.vs')}{' '}
                                    {facts.opponentSprite
                                      ? localizedFighterName(match.opponent_id, t)
                                      : t('common.unknown')}
                                  </p>
                                  <p>{facts.stageName}</p>
                                  <p>{new Date(match.time).toLocaleString(i18n.language)}</p>
                                  {facts.tournamentLink && (
                                    <Link
                                      to={facts.tournamentLink.href}
                                      className="text-primary hover:underline"
                                    >
                                      {facts.tournamentLink.label}
                                    </Link>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
          {(pagingControlVisible || progressVisible) && (
            <div className="flex flex-wrap items-center gap-3">
              {pagingControlVisible && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  aria-controls={rootId}
                  onClick={handleShowMore}
                >
                  {t('shared.filteredMatchList.showMore', { count: nextPageSize })}
                </Button>
              )}
              {progressVisible && (
                <p aria-live="polite" className="text-sm text-muted-foreground">
                  {t('shared.filteredMatchList.showingOf', {
                    shown: mountedMatches.length,
                    count: narrowedMatches.length,
                  })}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {showDelete && (
        <AlertDialog
          open={pendingDelete != null}
          onOpenChange={(open) => !open && setPendingDelete(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('shared.matchDelete.confirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('common.cannotBeUndone')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDelete}>{t('common.delete')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

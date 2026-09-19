import { Fragment, useMemo, useState } from 'react';
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
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { localizedFighterName } from '@/lib/fighterNames';
import { useDeleteMatch } from '@/hooks/useDeleteMatch';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { cn } from '@/lib/utils';
import { matchesDrillDown, type DrillDownAxes } from '@/lib/drillDownParams';

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
 * one absolutely-positioned interactive element inside the row's first
 * cell (`position: relative` on the `<TableRow>`) — every other cell in the
 * row stays a plain `<TableCell>`, so the table keeps real per-column
 * semantics instead of collapsing into one giant cell.
 */

/** The ONE shared predicate for "does this match have an attached VOD?" — every row branch reads through this, never an inline `match.vodUrl != null` check. */
export function matchHasAttachedVideo(match: Match): boolean {
  return match.vodUrl != null;
}

export interface FilteredMatchListProps {
  /** The already newest-first-sorted (via `sortMatchesNewestFirst`) but NOT yet axis-narrowed match array — this component narrows it internally through `matchesDrillDown`. Never re-sorted here. */
  matches: Match[];
  /** The resolved drill-down axes to narrow `matches` by — also drives the summary bar, the clear-filters affordance and pinned-column omission. */
  axes: DrillDownAxes;
  /** Resolves a per-match event key for the `eventKey` axis (mirrors the resolver the host's own predicate would use) — required only when a host narrows by event. */
  eventKeyForMatch?: (match: Match) => string | undefined;
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
}

function hasActiveAxis(axes: DrillDownAxes): boolean {
  return (
    axes.fighterId != null ||
    axes.vsFighterId != null ||
    axes.stageId != null ||
    axes.eventKey != null ||
    axes.from != null ||
    axes.to != null
  );
}

/** Joins the human-readable description of every active axis with " · " (UI-SPEC's filter-summary join). */
function buildFilterSummaryText(axes: DrillDownAxes, t: TFunction): string {
  const parts: string[] = [];
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
    parts.push(axes.eventKey);
  }
  if (axes.from != null || axes.to != null) {
    const from = axes.from != null ? new Date(axes.from).toLocaleDateString() : null;
    const to = axes.to != null ? new Date(axes.to).toLocaleDateString() : null;
    parts.push(from && to && from !== to ? `${from} – ${to}` : (from ?? to ?? ''));
  }
  return parts.filter(Boolean).join(' · ');
}

export function FilteredMatchList({
  matches,
  axes,
  eventKeyForMatch,
  eventLabelForMatch,
  tournamentLinkForMatch,
  onClearFilters,
  loading = false,
  showDelete = false,
}: FilteredMatchListProps) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const deleteMatch = useDeleteMatch();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Match | null>(null);

  // D-16: memoized by the source array reference and the axes object — the
  // host is responsible for handing a stable `axes` reference (e.g. via its
  // own `useMemo`) when it wants this to actually skip recomputation.
  const narrowedMatches = useMemo(
    () => matches.filter((match) => matchesDrillDown(match, axes, eventKeyForMatch)),
    [matches, axes, eventKeyForMatch],
  );

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
              filters: buildFilterSummaryText(axes, t),
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
        <div className="max-h-[500px] overflow-y-auto">
          <Table>
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
              {narrowedMatches.map((match) => {
                const fighterSprite = getFighterById(match.fighter_id);
                const opponentSprite = getFighterById(match.opponent_id);
                const stageId = match.map?.id ?? 0;
                const stageName =
                  stageId !== 0
                    ? (stagesById.get(stageId)?.name ?? match.map?.name ?? t('common.unknown'))
                    : t('common.unknown');
                const eventLabel =
                  eventLabelForMatch?.(match) ?? match.tournamentName ?? match.eventName ?? '';
                const opponentTag = match.opponent || t('common.unknown');
                const resultText = match.win ? t('common.win') : t('common.loss');
                const hasVideo = matchHasAttachedVideo(match);
                const isExpanded = expandedId === match.id;
                const tournamentLink = tournamentLinkForMatch?.(match);

                const rowInteractive = hasVideo ? (
                  <Link
                    to={subjectPath(`/vod?match=${match.id}`)}
                    aria-label={t('shared.filteredMatchList.rowVod', {
                      opponent: opponentTag,
                      stage: stageName,
                      result: resultText,
                    })}
                    className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  />
                ) : (
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-label={t('shared.filteredMatchList.rowExpand', {
                      opponent: opponentTag,
                      stage: stageName,
                      result: resultText,
                    })}
                    onClick={() => setExpandedId(isExpanded ? null : match.id)}
                    className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  />
                );

                return (
                  <Fragment key={match.id}>
                    <TableRow className="relative hover:bg-accent">
                      <TableCell className="text-sm text-muted-foreground">
                        {rowInteractive}
                        {new Date(match.time).toLocaleDateString(i18n.language)}
                      </TableCell>
                      <TableCell className="text-sm">{opponentTag}</TableCell>
                      {!hideMyCharacterColumn && (
                        <TableCell>
                          <span className="flex items-center gap-1 text-sm">
                            {fighterSprite?.url && (
                              <img
                                src={fighterSprite.url}
                                alt=""
                                className="size-5 object-contain"
                              />
                            )}
                            {fighterSprite ? localizedFighterName(match.fighter_id, t) : '—'}
                          </span>
                        </TableCell>
                      )}
                      {!hideTheirCharacterColumn && (
                        <TableCell>
                          <span className="flex items-center gap-1 text-sm">
                            {opponentSprite?.url && (
                              <img
                                src={opponentSprite.url}
                                alt=""
                                className="size-5 object-contain"
                              />
                            )}
                            {opponentSprite ? localizedFighterName(match.opponent_id, t) : '—'}
                          </span>
                        </TableCell>
                      )}
                      {!hideStageColumn && <TableCell className="text-sm">{stageName}</TableCell>}
                      <TableCell className="text-sm text-muted-foreground">{eventLabel}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <Badge variant={match.win ? 'success' : 'destructive'}>
                            {resultText}
                          </Badge>
                          {hasVideo ? (
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
                    {isExpanded && !hasVideo && (
                      <TableRow>
                        <TableCell colSpan={columnCount}>
                          <div className="flex flex-col gap-1 py-2 text-sm text-muted-foreground">
                            <p>
                              {fighterSprite
                                ? localizedFighterName(match.fighter_id, t)
                                : t('common.unknown')}{' '}
                              {t('matchups.vs')}{' '}
                              {opponentSprite
                                ? localizedFighterName(match.opponent_id, t)
                                : t('common.unknown')}
                            </p>
                            <p>{stageName}</p>
                            <p>{new Date(match.time).toLocaleString(i18n.language)}</p>
                            {tournamentLink && (
                              <Link
                                to={tournamentLink.href}
                                className="text-primary hover:underline"
                              >
                                {tournamentLink.label}
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

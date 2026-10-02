import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { resolveWindow, type HorizonKey, type Match } from '@smash-tracker/shared';
import { toast } from 'sonner';
import { stagesById } from '@/data/stages';
import { localizedFighterName } from '@/lib/fighterNames';
import {
  buildDrillDownSearch,
  matchesDrillDown,
  sortMatchesNewestFirst,
} from '@/lib/drillDownParams';
import { useDeleteMatch } from '@/hooks/useDeleteMatch';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { BoundedList, LIST_CAP_RAIL } from '@/components/analytics/BoundedList';
import {
  TILE_CARD_CLASS,
  TILE_CONTENT_CLASS,
  TILE_HEADER_CLASS,
} from '@/components/analytics/cardDensity';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { useDashboardContext } from '../DashboardContext';

/**
 * Ports legacy/src/screens/Dashboard/components/PreviousMatches.
 *
 * Plan 39.1-50 (OOS-12b; UI-SPEC §10.4 "never a per-chart control", §6.4,
 * §4.3 rules 2 and 7): no card-level Limit select. The list is the selected
 * fighter's games inside the page horizon's window, newest first — the Form
 * Curve's window (`resolveWindow({ scoped: false })`) — on the kit
 * BoundedList (8 rows, "Show all N" inline to 25, then a terminus to Fighter
 * Analysis' `#games` list). The terminus's N is `matchesDrillDown` over the
 * SAME matches and axes the link applies, so the label equals the list it
 * opens by construction (ties at the window's oldest edge included).
 */
export function PreviousMatches({ matches, horizon }: { matches: Match[]; horizon: HorizonKey }) {
  const { t, i18n } = useTranslation();
  const { fighter } = useDashboardContext();
  const subjectPath = useSubjectPath();
  // React Compiler forbids a bare `Date.now()` in render; a lazy initializer
  // fixes the window's "now" for the page's life (LastMatchesChart's pattern).
  const [nowMs] = useState(() => Date.now());
  const [pendingDelete, setPendingDelete] = useState<Match | null>(null);
  const deleteMatch = useDeleteMatch();

  const fighterMatches = fighter ? matches.filter((m) => m.fighter_id === fighter.id) : [];
  const windowed = sortMatchesNewestFirst(
    resolveWindow({ matches: fighterMatches, horizon, scoped: false, nowMs }).matches,
  );
  const newest = windowed[0];
  const oldest = windowed[windowed.length - 1];
  const axes =
    fighter && newest && oldest
      ? { fighterId: fighter.id, from: oldest.time, to: newest.time }
      : null;
  const terminusCount = axes ? matches.filter((m) => matchesDrillDown(m, axes)).length : 0;
  const terminusHref = axes
    ? subjectPath(`/fighter-analysis?${buildDrillDownSearch(axes).toString()}#games`)
    : undefined;
  const dateFormat: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };

  const rows = windowed.map((match) => {
    const pairing = t('matchups.pairingHeading', {
      fighter: localizedFighterName(match.fighter_id, t),
      opponent: localizedFighterName(match.opponent_id, t),
    });
    const stageId = match.map?.id ?? 0;
    const stageName = stageId !== 0 ? (stagesById.get(stageId)?.name ?? match.map?.name) : null;
    return (
      <li
        key={match.id}
        className="flex flex-col gap-0.5 py-1.5"
        data-slot="previous-match-row"
        data-match-id={match.id}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            data-slot="previous-match-mark"
            className="inline-block size-1.5 shrink-0 rounded-sm"
            style={{ backgroundColor: match.win ? CHART_TOKENS.win : CHART_TOKENS.loss }}
          />
          <span data-slot="previous-match-result" className="shrink-0 text-sm font-medium">
            {match.win ? t('common.win') : t('common.loss')}
          </span>
          <span
            data-slot="previous-match-pairing"
            className="min-w-0 flex-1 truncate text-sm"
            title={pairing}
          >
            {pairing}
          </span>
          {/* Synced matches can't be deleted (the next sync would just
              re-create them; the API 409s it) — manage them on the Match
              Data page instead. */}
          {!match.source && (
            <Button
              variant="outline"
              size="icon-sm"
              // A 32 px button in a 20 px text line: the negative block
              // margin keeps manual and synced rows the same height.
              className="-my-1.5 shrink-0"
              aria-label={t('shared.matchDelete.aria')}
              onClick={() => setPendingDelete(match)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
        <p
          data-slot="previous-match-meta"
          className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs leading-4 text-muted-foreground tabular-nums"
        >
          {stageName && <span>{stageName}</span>}
          <span>{new Date(match.time).toLocaleDateString(i18n.language, dateFormat)}</span>
        </p>
      </li>
    );
  });

  const empty = (
    <p className="text-sm text-muted-foreground">
      {fighterMatches.length === 0 || horizon === 'last30'
        ? t('dashboard.previous.empty')
        : t(`dashboard.previous.windowEmpty.${horizon}`)}
    </p>
  );

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
    <Card className={TILE_CARD_CLASS}>
      <CardHeader className={TILE_HEADER_CLASS}>
        <CardTitle>{t('dashboard.previous.title')}</CardTitle>
      </CardHeader>
      <CardContent className={TILE_CONTENT_CLASS}>
        {/* Quick 261002-leg (DESIGN §4): a 6-span list paired beside a
            CHART_H_DEFAULT plot uses the 5-row rail cap (amends UI-SPEC §6.4). */}
        <BoundedList
          cap={LIST_CAP_RAIL}
          rows={rows}
          labels={{
            showAll: t('analytics.list.showAll', { count: rows.length }),
            showFewer: t('analytics.list.showFewer'),
            showMore: t('analytics.list.showMore50'),
            terminus: t('analytics.list.allGames', { count: terminusCount }),
          }}
          empty={empty}
          terminusHref={terminusHref}
        />
      </CardContent>

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
    </Card>
  );
}

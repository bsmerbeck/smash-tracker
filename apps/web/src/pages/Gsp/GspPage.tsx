import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Fighter, GspEntry, GspReading, Match } from '@smash-tracker/shared';
import { getGspEntries, getGspGainStats, gspSeriesFromEntries } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
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
import { EditMatchForm } from '@/components/match-form/EditMatchForm';
import { RatingModelNote } from '@/components/RatingModelNote';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { useMatches } from '@/hooks/useMatches';
import { useFighters } from '@/hooks/useFighters';
import { useGspSettings } from '@/hooks/useGspSettings';
import { useDeleteMatch } from '@/hooks/useDeleteMatch';
import { useDeleteGspReading, useGspReadings } from '@/hooks/useGspReadings';
import { useFighterNameResolver, useSortedFighters } from '@/hooks/useFighterName';
import { getFighterById } from '@/data/sprites';
import { computeRatingHistory } from '@/lib/glicko';
import { cn } from '@/lib/utils';
import { getGspFighterOptions } from './lib/gspFighters';
import { GspFighterSelect } from './components/GspFighterSelect';
import { GspHero } from './components/GspHero';
import { GspCurve } from './components/GspCurve';
import { GspMatchLog } from './components/GspMatchLog';
import { EditGspReadingDialog } from './components/EditGspReadingDialog';
import { QuickLogger } from './components/QuickLogger';
import { GainsAnalysis } from './components/GainsAnalysis';
import { GspTiers } from './components/GspTiers';
import { GspVsGlicko } from './components/GspVsGlicko';
import { shouldShowGspVsGlicko } from './lib/gspVsGlicko';

/**
 * Plan 41-05 (D3, DD-41-11, UI-SPEC 6.2): the last row pairs the vs-Glicko card (8 cols, left) with the
 * Rating-model note (4 cols, right) from `lg`. The DOM keeps the note BEFORE the card (RESEARCH correction
 * 14: the note reads immediately above the first rating-bearing region, and `GspPage.test.tsx` pins that
 * order), so the desktop composition is restored by explicit placement utilities - never a CSS `order`
 * utility. Below `lg` every cell spans 12 in DOM order. Both cells name the same row (5: hero, curve +
 * logger, gains + tiers, log, this row) so they sit side by side.
 */
const GSP_VS_GLICKO_PLACEMENT = 'lg:col-start-1 lg:row-start-5';
const GSP_RATING_NOTE_PLACEMENT = 'lg:col-start-9 lg:row-start-5';

/**
 * V10: GSP (Global Smash Power) tracker for online quickplay. GSP is
 * per-character (see packages/shared/src/gsp.ts), so — unlike Trends —
 * everything on this page below the fighter selector is scoped to whichever
 * sprite is currently selected. Design language mirrors Fighter
 * Analysis/Trends: a hero stat row followed by a responsive card grid.
 *
 * GSP data comes from two record types, merged chronologically into
 * `GspEntry`s (shared/gsp.ts): regular matches carrying an optional `gsp`
 * field (the same `POST /api/matches` path as everything else, with
 * `matchType: 'quickplay'`), plus V17's standalone calibration readings
 * ("set GSP without a match", `gspReadings/{uid}`) which re-baseline the
 * series without polluting win/loss statistics.
 *
 * V14: readings are correctable in place — the GspMatchLog rows and the
 * curve's click-to-edit both open the shared EditMatchForm (matches) or
 * EditGspReadingDialog (calibration readings) / delete confirmation owned
 * here, so a flubbed digit doesn't require a round-trip through Match Data.
 */
export function GspPage() {
  const { t } = useTranslation();
  const {
    data: matches = [],
    isLoading: matchesLoading,
    isFetching: matchesFetching,
  } = useMatches();
  const { data: readings = [], isLoading: readingsLoading } = useGspReadings();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { data: gspSettings, isLoading: settingsLoading } = useGspSettings();
  const deleteMatch = useDeleteMatch();
  const deleteReading = useDeleteGspReading();

  const [editingMatch, setEditingMatch] = useState<Match | null>(null);
  const [editingReading, setEditingReading] = useState<GspReading | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GspEntry | null>(null);
  // DD-41-12 (A2): a coarser-grain curve close click selects the log rows it summarises (indices into
  // `entries`) - never a URL axis. Held until the next selection replaces it, and tied to the `entries`
  // array it was taken from: an edit, a delete or a fighter switch builds a new array, so a stale index
  // can never mark the wrong row.
  const [logSelection, setLogSelection] = useState<{
    entries: GspEntry[];
    indexes: number[];
  } | null>(null);

  const localizedName = useFighterNameResolver();
  const fighterOptions = useMemo(
    () =>
      getGspFighterOptions(
        matches,
        fighterSelection?.primary ?? [],
        fighterSelection?.secondary ?? [],
        localizedName,
      ),
    [matches, fighterSelection, localizedName],
  );

  // EditMatchForm's "Your Fighter" picker offers the primary+secondary
  // selections, exactly like MatchDataPage builds them.
  const rawEditFighterSprites = useMemo<Fighter[]>(() => {
    const ids = [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])];
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [fighterSelection]);
  const editFighterSprites = useSortedFighters(rawEditFighterSprites);

  const [selectedFighterId, setSelectedFighterId] = useState<number | undefined>(undefined);
  const fighter: Fighter | undefined =
    fighterOptions.find((f) => f.id === selectedFighterId) ?? fighterOptions[0] ?? undefined;

  // Index-parity: entries[i] is the record behind series[i] (the series is derived from it in shared/gsp.ts),
  // which is what makes the curve's point-index -> entry resolution safe (plan 41-06, T-41-16). Memoised so the
  // curve's value-series memos hold across unrelated re-renders.
  const fighterId = fighter?.id;
  const entries = useMemo(
    () => (fighterId === undefined ? [] : getGspEntries(matches, readings, fighterId)),
    [matches, readings, fighterId],
  );
  const series = useMemo(() => gspSeriesFromEntries(entries), [entries]);

  // The vs-Glicko card's hidden-state gate needs the account's rating periods; counted once here (a hook, so
  // before the early returns) and read through the same `shouldShowGspVsGlicko` helper the card itself uses, so
  // the Rating-model note spans the whole row exactly when the card is not drawn.
  const ratingPeriodCount = useMemo(() => computeRatingHistory(matches).periods.length, [matches]);

  const isLoading = matchesLoading || readingsLoading || fightersLoading || settingsLoading;

  if (isLoading) {
    return <div className="text-muted-foreground">{t('gsp.loading')}</div>;
  }

  if (fighterOptions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('gsp.empty.title')}</h1>
        <p className="max-w-md text-muted-foreground">{t('gsp.empty.body')}</p>
        <Button asChild className="mt-2">
          <Link to="/dashboard">{t('gsp.empty.cta')}</Link>
        </Button>
      </div>
    );
  }

  if (!fighter || !gspSettings) {
    return <div className="text-muted-foreground">{t('gsp.loading')}</div>;
  }

  const logHighlightIndexes = logSelection?.entries === entries ? logSelection.indexes : undefined;
  // WR-06: a FRESH array per selection. The log keys its expand-and-focus on the array's identity, and a
  // close's `memberIndexes` is memoised, so re-clicking the same close must not hand it the same array.
  const selectLogRows = (indexes: number[]) => setLogSelection({ entries, indexes: [...indexes] });
  const gainStats = getGspGainStats(series);
  const lastPoint = series.length > 0 ? series[series.length - 1]! : null;

  function editEntry(entry: GspEntry | null) {
    if (!entry) return;
    if (entry.kind === 'match') {
      setEditingMatch(entry.match);
    } else {
      setEditingReading(entry.reading);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      if (pendingDelete.kind === 'match') {
        await deleteMatch.mutateAsync(pendingDelete.match.id);
      } else {
        await deleteReading.mutateAsync(pendingDelete.reading.id);
      }
      toast.success(t('gsp.deleteConfirm.deleted'));
    } catch {
      toast.error(t('gsp.deleteConfirm.deleteFailed'));
    } finally {
      setPendingDelete(null);
    }
  }

  // Plan 41-05: a background refetch (data already loaded once) holds the previous frame at reduced
  // opacity instead of flashing the loading line (the Trends / Dashboard precedent).
  const isRefetching = matchesFetching && !matchesLoading;
  const showVsGlicko = shouldShowGspVsGlicko(series.length, ratingPeriodCount);

  // data-slot="gsp-body" (plan 39.1-39): a `display: contents` marker that exists only once every data hook
  // has settled and a fighter is resolved - the layout oracle's and capture tool's page-loaded marker.
  // Layout-neutral (the Dashboard precedent). The dialogs stay at the page root, outside the shell.
  return (
    <>
      <PageShell>
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t('gsp.header.title')}</h1>
          <p className="max-w-lg text-sm text-muted-foreground">{t('gsp.header.subtitle')}</p>
          <GspFighterSelect
            fighter={fighter}
            fighterOptions={fighterOptions}
            onChange={(next) => setSelectedFighterId(next.id)}
          />
        </div>

        <div className="contents" data-slot="gsp-body">
          <PageGrid
            className={cn(
              isRefetching &&
                'opacity-60 transition-opacity duration-150 motion-reduce:transition-none',
            )}
          >
            <GridCell span={12}>
              <GspHero series={series} settings={gspSettings} />
            </GridCell>

            <GridCell span={8}>
              <GspCurve
                series={series}
                settings={gspSettings}
                onSelectReading={(index) => editEntry(entries[index] ?? null)}
                onSelectPeriod={selectLogRows}
              />
            </GridCell>
            <GridCell span={4}>
              <QuickLogger fighter={fighter} lastPoint={lastPoint} settings={gspSettings} />
            </GridCell>

            <GridCell span={6}>
              <GainsAnalysis stats={gainStats} />
            </GridCell>
            <GridCell span={6}>
              <GspTiers series={series} settings={gspSettings} />
            </GridCell>

            <GridCell span={12}>
              <GspMatchLog
                entries={entries}
                onEdit={editEntry}
                onDelete={setPendingDelete}
                highlightedIndexes={logHighlightIndexes}
                forceShowAll={logHighlightIndexes !== undefined}
              />
            </GridCell>

            <GridCell
              span={showVsGlicko ? 4 : 12}
              slot="gsp-rating-note"
              className={showVsGlicko ? GSP_RATING_NOTE_PLACEMENT : undefined}
            >
              <RatingModelNote />
            </GridCell>
            {showVsGlicko && (
              <GridCell span={8} slot="gsp-vs-glicko" className={GSP_VS_GLICKO_PLACEMENT}>
                <GspVsGlicko
                  gspSeries={series}
                  allMatches={matches}
                  settings={gspSettings}
                  onSelectReading={(index) => editEntry(entries[index] ?? null)}
                  onSelectPeriod={selectLogRows}
                />
              </GridCell>
            )}
          </PageGrid>
        </div>
      </PageShell>

      {editingMatch && (
        <EditMatchForm
          match={editingMatch}
          fighterSprites={editFighterSprites}
          open={editingMatch != null}
          onOpenChange={(open) => !open && setEditingMatch(null)}
          // Curve clicks land here directly, so the dialog must offer the
          // delete path too — hand off to the shared confirmation below.
          onDelete={(match) => {
            setEditingMatch(null);
            setPendingDelete({
              kind: 'match',
              time: match.time,
              gsp: match.gsp ?? 0,
              win: match.win,
              match,
            });
          }}
        />
      )}

      {editingReading && (
        <EditGspReadingDialog
          reading={editingReading}
          open={editingReading != null}
          onOpenChange={(open) => !open && setEditingReading(null)}
          onDelete={(reading) => {
            setEditingReading(null);
            setPendingDelete({ kind: 'reading', time: reading.time, gsp: reading.gsp, reading });
          }}
        />
      )}

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('gsp.deleteConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('gsp.deleteConfirm.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

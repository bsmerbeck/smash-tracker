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
import { useMatches } from '@/hooks/useMatches';
import { useFighters } from '@/hooks/useFighters';
import { useGspSettings } from '@/hooks/useGspSettings';
import { useDeleteMatch } from '@/hooks/useDeleteMatch';
import { useDeleteGspReading, useGspReadings } from '@/hooks/useGspReadings';
import { getFighterById } from '@/data/sprites';
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
  const { data: matches = [], isLoading: matchesLoading } = useMatches();
  const { data: readings = [], isLoading: readingsLoading } = useGspReadings();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { data: gspSettings, isLoading: settingsLoading } = useGspSettings();
  const deleteMatch = useDeleteMatch();
  const deleteReading = useDeleteGspReading();

  const [editingMatch, setEditingMatch] = useState<Match | null>(null);
  const [editingReading, setEditingReading] = useState<GspReading | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GspEntry | null>(null);

  const fighterOptions = useMemo(
    () =>
      getGspFighterOptions(
        matches,
        fighterSelection?.primary ?? [],
        fighterSelection?.secondary ?? [],
      ),
    [matches, fighterSelection],
  );

  // EditMatchForm's "Your Fighter" picker offers the primary+secondary
  // selections, exactly like MatchDataPage builds them.
  const editFighterSprites = useMemo<Fighter[]>(() => {
    const ids = [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])];
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [fighterSelection]);

  const [selectedFighterId, setSelectedFighterId] = useState<number | undefined>(undefined);
  const fighter: Fighter | undefined =
    fighterOptions.find((f) => f.id === selectedFighterId) ?? fighterOptions[0] ?? undefined;

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

  // Index-parity: entries[i] is the record behind series[i] (the series is
  // derived from it in shared/gsp.ts), which is what makes the curve's
  // point-index → entry resolution safe.
  const entries = getGspEntries(matches, readings, fighter.id);
  const series = gspSeriesFromEntries(entries);
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('gsp.header.title')}</h1>
        <p className="max-w-lg text-sm text-muted-foreground">{t('gsp.header.subtitle')}</p>
        <GspFighterSelect
          fighter={fighter}
          fighterOptions={fighterOptions}
          onChange={(next) => setSelectedFighterId(next.id)}
        />
      </div>

      <GspHero series={series} settings={gspSettings} />

      <GspCurve
        series={series}
        settings={gspSettings}
        onPointClick={(index) => editEntry(entries[index] ?? null)}
      />

      <QuickLogger fighter={fighter} lastPoint={lastPoint} settings={gspSettings} />

      <GspMatchLog entries={entries} onEdit={editEntry} onDelete={setPendingDelete} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GainsAnalysis stats={gainStats} />
        <GspTiers series={series} settings={gspSettings} />
      </div>

      <GspVsGlicko gspSeries={series} allMatches={matches} settings={gspSettings} />

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
    </div>
  );
}

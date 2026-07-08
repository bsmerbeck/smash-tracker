import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { Fighter, Match } from '@smash-tracker/shared';
import { getGspGainStats, getGspMatches, getGspSeries } from '@smash-tracker/shared';
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
import { getFighterById } from '@/data/sprites';
import { getGspFighterOptions } from './lib/gspFighters';
import { GspFighterSelect } from './components/GspFighterSelect';
import { GspHero } from './components/GspHero';
import { GspCurve } from './components/GspCurve';
import { GspMatchLog } from './components/GspMatchLog';
import { QuickLogger } from './components/QuickLogger';
import { GainsAnalysis } from './components/GainsAnalysis';
import { RoadToElite } from './components/RoadToElite';
import { GspVsGlicko } from './components/GspVsGlicko';

/**
 * V10: GSP (Global Smash Power) tracker for online quickplay. GSP is
 * per-character (see packages/shared/src/gsp.ts), so — unlike Trends —
 * everything on this page below the fighter selector is scoped to whichever
 * sprite is currently selected. Design language mirrors Fighter
 * Analysis/Trends: a hero stat row followed by a responsive card grid.
 *
 * All GSP data is just regular matches carrying an optional `gsp` field
 * (logged via the same `POST /api/matches` path as everything else, with
 * `matchType: 'quickplay'`) — there is no separate GSP-only record type.
 *
 * V14: readings are correctable in place — the GspMatchLog rows and the
 * curve's click-to-edit both open the shared EditMatchForm / delete
 * confirmation owned here, so a flubbed digit doesn't require a round-trip
 * through Match Data.
 */
export function GspPage() {
  const { data: matches = [], isLoading: matchesLoading } = useMatches();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { data: gspSettings, isLoading: settingsLoading } = useGspSettings();
  const deleteMatch = useDeleteMatch();

  const [editingMatch, setEditingMatch] = useState<Match | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Match | null>(null);

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

  const isLoading = matchesLoading || fightersLoading || settingsLoading;

  if (isLoading) {
    return <div className="text-muted-foreground">Loading GSP tracker...</div>;
  }

  if (fighterOptions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Track your GSP climb</h1>
        <p className="max-w-md text-muted-foreground">
          GSP (Global Smash Power) is Smash Ultimate&apos;s online quickplay ranking, tracked
          per-character. Log a quickplay match with the GSP shown on the results screen and this
          page will chart your climb, break down your win/loss gains, and estimate how far you are
          from Elite Smash.
        </p>
        <Button asChild className="mt-2">
          <Link to="/dashboard">Log a match on the Dashboard</Link>
        </Button>
      </div>
    );
  }

  if (!fighter || !gspSettings) {
    return <div className="text-muted-foreground">Loading GSP tracker...</div>;
  }

  // Index-parity: gspMatches[i] is the match behind series[i] (the series is
  // derived from it in shared/gsp.ts), which is what makes the curve's
  // point-index → match resolution safe.
  const gspMatches = getGspMatches(matches, fighter.id);
  const series = getGspSeries(matches, fighter.id);
  const gainStats = getGspGainStats(series);
  const lastPoint = series.length > 0 ? series[series.length - 1]! : null;

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      await deleteMatch.mutateAsync(pendingDelete.id);
      toast.success('GSP entry deleted!');
    } catch {
      toast.error('Failed to delete the entry. Please try again.');
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">GSP Tracker</h1>
        <p className="max-w-lg text-sm text-muted-foreground">
          Global Smash Power is per-character and its exact formula is never published by Nintendo —
          everything below is an estimate built from your own logged matches and a
          community-reverse-engineered model of the hidden MMR behind GSP.
        </p>
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
        onPointClick={(index) => setEditingMatch(gspMatches[index] ?? null)}
      />

      <QuickLogger fighter={fighter} lastPoint={lastPoint} settings={gspSettings} />

      <GspMatchLog gspMatches={gspMatches} onEdit={setEditingMatch} onDelete={setPendingDelete} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GainsAnalysis stats={gainStats} />
        <RoadToElite series={series} settings={gspSettings} />
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
            setPendingDelete(match);
          }}
        />
      )}

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this GSP entry?</AlertDialogTitle>
            <AlertDialogDescription>
              The match and its GSP reading are removed together — this action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

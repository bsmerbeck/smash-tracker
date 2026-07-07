import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { Fighter } from '@smash-tracker/shared';
import { getGspGainStats, getGspSeries } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { useMatches } from '@/hooks/useMatches';
import { useFighters } from '@/hooks/useFighters';
import { useGspSettings } from '@/hooks/useGspSettings';
import { getGspFighterOptions } from './lib/gspFighters';
import { GspFighterSelect } from './components/GspFighterSelect';
import { GspHero } from './components/GspHero';
import { GspCurve } from './components/GspCurve';
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
 */
export function GspPage() {
  const { data: matches = [], isLoading: matchesLoading } = useMatches();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { data: gspSettings, isLoading: settingsLoading } = useGspSettings();

  const fighterOptions = useMemo(
    () =>
      getGspFighterOptions(
        matches,
        fighterSelection?.primary ?? [],
        fighterSelection?.secondary ?? [],
      ),
    [matches, fighterSelection],
  );

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

  const series = getGspSeries(matches, fighter.id);
  const gainStats = getGspGainStats(series);
  const lastPoint = series.length > 0 ? series[series.length - 1]! : null;

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

      <GspCurve series={series} settings={gspSettings} />

      <QuickLogger fighter={fighter} lastPoint={lastPoint} settings={gspSettings} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GainsAnalysis stats={gainStats} />
        <RoadToElite series={series} settings={gspSettings} />
      </div>

      <GspVsGlicko gspSeries={series} allMatches={matches} settings={gspSettings} />
    </div>
  );
}

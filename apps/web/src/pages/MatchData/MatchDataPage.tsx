import { useMemo } from 'react';
import { Link } from 'react-router';
import type { Fighter } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { getFighterById } from '@/data/sprites';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { MatchTable } from './components/MatchTable';
import { FighterPieChart } from './components/FighterPieChart';
import { StageBreakdown } from './components/StageBreakdown';

/** Ports legacy/src/screens/MatchData; the source/time filter is now global (see the topbar's AnalyticsFilterControls), not a per-page control. */
export function MatchDataPage() {
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { matches, allMatches, isLoading: matchesLoading, filterActive } = useFilteredMatches();

  const fighterSprites = useMemo<Fighter[]>(() => {
    const ids = [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])];
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [fighterSelection]);

  if (fightersLoading || matchesLoading) {
    return <div className="text-muted-foreground">Loading match data...</div>;
  }

  if (fighterSprites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          You haven&apos;t picked any fighters yet!
        </h1>
        <p className="max-w-md text-muted-foreground">
          Choose your primary and secondary fighters to start tracking matches.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to="/choose-primary">Choose Primary Fighters</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/choose-secondary">Choose Secondary Fighters</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          You have no matches, report a match and check back here to view match data!
        </h2>
        <Button asChild className="mt-2">
          <Link to="/dashboard">Go to Dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <Card>
        <CardHeader>
          <CardTitle>Match History</CardTitle>
        </CardHeader>
        <CardContent>
          <MatchTable matches={matches} fighterSprites={fighterSprites} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StageBreakdown matches={matches} usageMatches={allMatches} />
        <FighterPieChart matches={matches} fighterSprites={fighterSprites} />
      </div>
    </div>
  );
}

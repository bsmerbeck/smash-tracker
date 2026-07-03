import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { MonthlyPerformance } from './components/MonthlyPerformance';
import { SessionsAndTilt } from './components/SessionsAndTilt';
import { SettingComparison } from './components/SettingComparison';
import { Tournaments } from './components/Tournaments';
import { MatchTypeMix } from './components/MatchTypeMix';

/**
 * V3 Phase F (docs/analytics-vision.md): monthly performance, sessions/tilt,
 * online-vs-offline comparison, per-tournament results, and match-type mix
 * over time. Account-wide (not per-fighter), honoring the global
 * source/time-range filter like the other analytics pages.
 */
export function TrendsPage() {
  const { matches, allMatches, isLoading, filterActive } = useFilteredMatches();

  if (isLoading) {
    return <div className="text-muted-foreground">Loading trends...</div>;
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          You have no matches, report a match and check back here to view trends!
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

      <MonthlyPerformance matches={matches} />
      <SessionsAndTilt matches={matches} />
      <SettingComparison matches={matches} />
      <Tournaments matches={matches} />
      <MatchTypeMix matches={matches} />
    </div>
  );
}

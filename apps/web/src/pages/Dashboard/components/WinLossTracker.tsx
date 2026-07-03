import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { filterByFighter, getWinLossRecord } from '@/lib/stats';
import type { Match } from '@smash-tracker/shared';
import { useDashboardContext } from '../DashboardContext';

/** Ports legacy/src/screens/Dashboard/components/WinLossTracker. */
export function WinLossTracker({ matches }: { matches: Match[] }) {
  const { fighter } = useDashboardContext();

  const fighterMatches = fighter ? filterByFighter(matches, fighter.id) : [];
  const hasMatches = fighterMatches.length > 0;
  const { wins, losses, winRate } = getWinLossRecord(fighterMatches);

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-center">Overall Record</CardTitle>
      </CardHeader>
      <CardContent className="flex justify-evenly">
        <Stat label="Wins" value={hasMatches ? wins : 'n/a'} />
        {hasMatches && <Stat label="Rate" value={`${winRate}%`} />}
        <Stat label="Losses" value={hasMatches ? losses : 'n/a'} />
      </CardContent>
      {!hasMatches && (
        <p className="pb-4 text-center text-sm text-muted-foreground">
          No match data to report yet.
        </p>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-lg font-medium">{value}</span>
    </div>
  );
}

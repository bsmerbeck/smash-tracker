import { Card, CardContent } from '@/components/ui/card';
import { getWinLossRecord } from '@/lib/stats';
import type { Match } from '@smash-tracker/shared';

/** Ports legacy/src/screens/Matchups/components/MatchWinLossCard — record for the specific fighter-vs-opponent matchup. */
export function MatchWinLossCard({ matchupMatches }: { matchupMatches: Match[] }) {
  if (matchupMatches.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">No reported matches against this fighter</p>
        </CardContent>
      </Card>
    );
  }

  const { wins, losses, total } = getWinLossRecord(matchupMatches);

  return (
    <Card>
      <CardContent className="flex justify-evenly pt-6">
        <Stat label="Wins" value={wins} />
        <Stat label="Total Matches" value={total} />
        <Stat label="Losses" value={losses} />
      </CardContent>
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

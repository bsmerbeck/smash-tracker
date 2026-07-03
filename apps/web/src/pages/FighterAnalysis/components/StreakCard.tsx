import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Match } from '@smash-tracker/shared';
import { getStreakSummary } from '@/lib/stats';

/** Ports legacy/src/screens/FighterAnalysis/components/StreakCard — current/longest streaks for the selected fighter. */
export function StreakCard({ fighterMatches }: { fighterMatches: Match[] }) {
  const { bestWinStreak, worstLossStreak, currentStreak, currentStreakIsWin } =
    getStreakSummary(fighterMatches);

  return (
    <Card className="flex-1">
      <CardHeader>
        <CardTitle>Streaks</CardTitle>
      </CardHeader>
      <CardContent className="flex justify-evenly">
        <Stat
          label="Current"
          value={currentStreak}
          sublabel={currentStreakIsWin ? 'Wins' : 'Losses'}
        />
        <Stat label="Best" value={bestWinStreak} sublabel="Wins" />
        <Stat label="Worst" value={worstLossStreak} sublabel="Losses" />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sublabel }: { label: string; value: number; sublabel: string }) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold">{value}</span>
      <span className="text-sm text-muted-foreground">{sublabel}</span>
    </div>
  );
}

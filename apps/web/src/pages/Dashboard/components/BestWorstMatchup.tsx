import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Match } from '@smash-tracker/shared';
import { getBestWorstMatchup, type MatchupStats } from '@/lib/stats';
import { getFighterById } from '@/data/sprites';
import { useDashboardContext } from '../DashboardContext';

const THRESHOLD_OPTIONS = [3, 5, 10, 25, 50, 100];

/** Ports legacy/src/screens/Dashboard/components/BestWorstMatchup. */
export function BestWorstMatchup({ matches }: { matches: Match[] }) {
  const { fighter } = useDashboardContext();
  const [threshold, setThreshold] = useState(5);

  if (!fighter || matches.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-medium">No matches reported</h2>
        </CardContent>
      </Card>
    );
  }

  const matchupMatches = matches.filter((m) => m.fighter_id === fighter.id);
  const { best, worst } = getBestWorstMatchup(matchupMatches, threshold);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Matchup Statistics</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Minimum Match Threshold</span>
          <Select value={String(threshold)} onValueChange={(v) => setThreshold(Number(v))}>
            <SelectTrigger className="w-[80px]" aria-label="Minimum match threshold">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THRESHOLD_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MatchupList title="Best Matchup" entries={best} />
        <MatchupList title="Worst Matchup" entries={worst} />
      </CardContent>
    </Card>
  );
}

function MatchupList({ title, entries }: { title: string; entries: MatchupStats[] }) {
  return (
    <div>
      <h3 className="mb-2 text-sm text-muted-foreground">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm">Not enough reported matches to calculate</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => {
            const sprite = getFighterById(entry.opponentFighterId);
            return (
              <li key={entry.opponentFighterId} className="flex items-center gap-2">
                {sprite && <img src={sprite.url} alt="" className="size-10 object-contain" />}
                <div>
                  <div className="font-medium">{sprite?.name ?? 'Unknown'}</div>
                  <div className="text-sm text-muted-foreground">
                    {entry.ratio}% ( {entry.wins}:{entry.losses} )
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

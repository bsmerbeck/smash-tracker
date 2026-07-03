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

const THRESHOLD_OPTIONS = [1, 3, 5, 10];

function MatchupList({ entries, emptyText }: { entries: MatchupStats[]; emptyText: string }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => {
        const sprite = getFighterById(entry.opponentFighterId);
        return (
          <li key={entry.opponentFighterId} className="flex items-center gap-3">
            {sprite && <img src={sprite.url} alt="" className="size-8 object-contain" />}
            <span className="flex-1">{sprite?.name ?? 'Unknown'}</span>
            <span className="text-sm text-muted-foreground">
              {entry.wins}-{entry.losses}
            </span>
            <span className="w-12 text-right font-medium">{entry.ratio}%</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Overall best and worst matchups for the selected fighter, qualified by a
 * user-adjustable minimum match threshold (same split semantics as the
 * Dashboard's BestWorstMatchup, here with the threshold exposed).
 */
export function BestWorstMatchupCards({ fighterMatches }: { fighterMatches: Match[] }) {
  const [threshold, setThreshold] = useState(5);
  const { best, worst } = getBestWorstMatchup(fighterMatches, threshold);

  return (
    <Card className="flex-1">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Best &amp; Worst Matchups</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Min matches</span>
          <Select value={String(threshold)} onValueChange={(v) => setThreshold(Number(v))}>
            <SelectTrigger className="w-[72px]" aria-label="Minimum matches per matchup">
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
      <CardContent className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-medium text-emerald-500">Best Matchups</h3>
          <MatchupList entries={best} emptyText="No matchups meet the threshold yet." />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium text-destructive">Worst Matchups</h3>
          <MatchupList entries={worst} emptyText="No matchups meet the threshold yet." />
        </div>
      </CardContent>
    </Card>
  );
}

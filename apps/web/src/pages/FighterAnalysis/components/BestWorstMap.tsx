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
import { stagesById } from '@/data/stages';

const stageList = [...stagesById.values()];
const THRESHOLD_OPTIONS = [3, 5, 10, 20];

interface MapStat {
  name: string;
  wins: number;
  losses: number;
  ratio: number;
}

/**
 * Best stage for the selected fighter, ported from legacy BestWorstMap.js
 * `bestMap`: a stage only qualifies once its win count meets `threshold`;
 * among qualifying stages the best win ratio wins (ties broken by array
 * order after a descending sort, same as legacy).
 */
function bestMap(matches: Match[], threshold: number): MapStat | undefined {
  const stats: MapStat[] = stageList.map((stage) => {
    const stageMatches = matches.filter((m) => m.map?.id === stage.id);
    const wins = stageMatches.filter((m) => m.win);
    const losses = stageMatches.length - wins.length;
    const ratio =
      wins.length && wins.length >= threshold
        ? Math.round((wins.length / stageMatches.length) * 100)
        : 0;
    return { name: stage.name, wins: wins.length, losses, ratio };
  });
  const sorted = [...stats].sort((a, b) => b.ratio - a.ratio);
  const qualifying = sorted.filter((m) => m.wins + m.losses !== 0 && m.wins >= threshold);
  return qualifying[0];
}

/**
 * Worst stage for the selected fighter, ported from legacy BestWorstMap.js
 * `worstMap`: a stage only qualifies once its LOSS count meets `threshold`;
 * among qualifying stages the WORST (lowest) win ratio is picked by taking
 * the tail of a descending sort, same as legacy.
 */
function worstMap(matches: Match[], threshold: number): MapStat | undefined {
  const stats: MapStat[] = stageList.map((stage) => {
    const stageMatches = matches.filter((m) => m.map?.id === stage.id);
    const wins = stageMatches.filter((m) => m.win);
    const losses = stageMatches.length - wins.length;
    const ratio =
      wins.length && stageMatches.length >= threshold
        ? Math.round((wins.length / stageMatches.length) * 100)
        : 0;
    return { name: stage.name, wins: wins.length, losses, ratio };
  });
  const sorted = [...stats].sort((a, b) => b.ratio - a.ratio);
  const qualifying = sorted.filter((m) => m.wins + m.losses !== 0 && m.losses >= threshold);
  return qualifying[qualifying.length - 1];
}

/** Ports legacy/src/screens/FighterAnalysis/components/BestWorstMap — best/worst stages for the selected fighter, with a minimum-match threshold selector. */
export function BestWorstMap({ fighterMatches }: { fighterMatches: Match[] }) {
  const [threshold, setThreshold] = useState(5);

  const best = bestMap(fighterMatches, threshold);
  const worst = worstMap(fighterMatches, threshold);

  return (
    <Card className="flex-1">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Best/Worst Stage</CardTitle>
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
        <MapStatBlock title="Best Stage" stat={best} />
        <MapStatBlock title="Worst Stage" stat={worst} />
      </CardContent>
    </Card>
  );
}

function MapStatBlock({ title, stat }: { title: string; stat: MapStat | undefined }) {
  return (
    <div className="flex flex-col items-center text-center">
      <h3 className="mb-1 text-sm text-muted-foreground">{title}</h3>
      {!stat ? (
        <p className="text-sm">not enough matches</p>
      ) : (
        <>
          <h4 className="text-lg font-medium">{stat.name}</h4>
          <p className="text-sm text-muted-foreground">{stat.ratio}%</p>
          <p className="text-sm text-muted-foreground">
            {stat.wins} wins | {stat.losses} losses
          </p>
        </>
      )}
    </div>
  );
}

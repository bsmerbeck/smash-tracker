import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import type { Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { stagesById } from '@/data/stages';

const stageList = [...stagesById.values()];

/**
 * Best stage (by win ratio) among the given opponent-fighter matches, ported
 * from legacy RosterBreakdown.js `bestMap`: a stage only "counts" once it
 * has more than 3 matches recorded AND at least one win there; ties broken
 * by whichever stage sorts first after a descending sort. Returns an empty
 * name when no stage qualifies (legacy's `{ id: -1, name: "" }` sentinel).
 */
function bestStageName(matches: Match[]): string {
  const ratios = stageList.map((stage) => {
    const stageMatches = matches.filter((m) => m.map?.id === stage.id);
    const wins = stageMatches.filter((m) => m.win);
    const ratio =
      wins.length && stageMatches.length > 3 ? (wins.length / stageMatches.length) * 100 : 0;
    return { name: stage.name, ratio };
  });
  const sorted = [...ratios].sort((a, b) => b.ratio - a.ratio);
  return sorted[0] && sorted[0].ratio !== 0 ? sorted[0].name : '';
}

/**
 * Worst stage (by loss ratio) among the given opponent-fighter matches,
 * ported from legacy RosterBreakdown.js `worstMap`: a stage only "counts"
 * once it has more than 3 losses recorded there. Among qualifying stages,
 * legacy picks the one with the LOWEST loss ratio after a descending sort
 * (i.e. the last surviving entry) — preserved verbatim, quirks included.
 */
function worstStageName(matches: Match[]): string {
  const ratios = stageList.map((stage) => {
    const stageMatches = matches.filter((m) => m.map?.id === stage.id);
    const losses = stageMatches.filter((m) => m.win === false);
    const ratio =
      losses.length && losses.length > 3
        ? Math.round((losses.length / stageMatches.length) * 100)
        : -1;
    return { name: stage.name, ratio };
  });
  const qualifying = ratios.filter((r) => r.ratio !== -1);
  if (qualifying.length === 0) {
    return '';
  }
  const sorted = qualifying.sort((a, b) => b.ratio - a.ratio);
  const last = sorted[sorted.length - 1];
  return last && last.ratio !== 0 ? last.name : '';
}

interface RosterRow {
  id: number;
  name: string;
  url: string;
  matchesCount: number;
  winRate: number;
  winsCount: number;
  lossesCount: number;
  bestStage: string;
  worstStage: string;
}

/**
 * Ports legacy/src/screens/FighterAnalysis/components/RosterBreakdown —
 * records vs. every fighter in the roster (all 85, not just ones faced),
 * with best/worst stage per matchup.
 */
export function RosterBreakdown({ fighterMatches }: { fighterMatches: Match[] }) {
  const [filter, setFilter] = useState('');

  const rows: RosterRow[] = SpriteList.map((sprite) => {
    const opponentMatches = fighterMatches.filter((m) => m.opponent_id === sprite.id);
    const wins = opponentMatches.filter((m) => m.win);
    const losses = opponentMatches.filter((m) => !m.win);
    const matchesCount = wins.length + losses.length;
    const winRate = matchesCount > 0 ? Math.round((wins.length / matchesCount) * 100) : 0;
    return {
      id: sprite.id,
      name: sprite.name,
      url: sprite.url,
      matchesCount,
      winRate,
      winsCount: wins.length,
      lossesCount: losses.length,
      bestStage: bestStageName(opponentMatches),
      worstStage: worstStageName(opponentMatches),
    };
  }).filter((row) => row.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Card className="flex-1">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Roster Breakdown</CardTitle>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by fighter..."
          className="max-w-xs"
          aria-label="Filter roster"
        />
      </CardHeader>
      <CardContent>
        <div className="max-h-[600px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fighter</TableHead>
                <TableHead>Win Rate</TableHead>
                <TableHead>Matches</TableHead>
                <TableHead>Wins</TableHead>
                <TableHead>Losses</TableHead>
                <TableHead>Best Stage</TableHead>
                <TableHead>Worst Stage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <img src={row.url} alt="" className="size-6 object-contain" />
                      <span>{row.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>{row.winRate}%</TableCell>
                  <TableCell>{row.matchesCount}</TableCell>
                  <TableCell>{row.winsCount}</TableCell>
                  <TableCell>{row.lossesCount}</TableCell>
                  <TableCell>{row.bestStage || '—'}</TableCell>
                  <TableCell>{row.worstStage || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

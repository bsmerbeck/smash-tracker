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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Match } from '@smash-tracker/shared';
import { getMatchupStageGuide, type StageRecord } from '@/lib/stats';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';

const THRESHOLD_OPTIONS = [1, 2, 3, 5, 10];

function stageCell(record: StageRecord | null) {
  if (!record) {
    return <span className="text-muted-foreground">—</span>;
  }
  const name = stagesById.get(record.stageId)?.name ?? 'Unknown';
  return (
    <span>
      {name}{' '}
      <span className="text-muted-foreground">
        ({record.winRate}% over {record.total})
      </span>
    </span>
  );
}

/**
 * The v2 matchup guide (replaces the legacy-quirk RosterBreakdown): for every
 * opponent fighter actually faced, the record for that matchup plus the best
 * and worst stage to take them to, qualified by a user-adjustable per-stage
 * minimum match threshold. Rows sort by sample size so the most-informed
 * matchups lead.
 */
export function MatchupStageGuide({ fighterMatches }: { fighterMatches: Match[] }) {
  const [threshold, setThreshold] = useState(3);
  const rows = getMatchupStageGuide(fighterMatches, threshold);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Matchup Stage Guide</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Min matches per stage</span>
          <Select value={String(threshold)} onValueChange={(v) => setThreshold(Number(v))}>
            <SelectTrigger className="w-[72px]" aria-label="Minimum matches per stage">
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
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No matchup data yet — report matches with this fighter to build the guide.
          </p>
        ) : (
          <div className="max-h-[600px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Opponent</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead>Win Rate</TableHead>
                  <TableHead>Best Stage</TableHead>
                  <TableHead>Worst Stage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const sprite = getFighterById(row.opponentFighterId);
                  return (
                    <TableRow key={row.opponentFighterId}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {sprite && (
                            <img src={sprite.url} alt="" className="size-6 object-contain" />
                          )}
                          <span>{sprite?.name ?? 'Unknown'}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.record.wins}-{row.record.losses}
                      </TableCell>
                      <TableCell>{row.record.winRate}%</TableCell>
                      <TableCell>{stageCell(row.bestStage)}</TableCell>
                      <TableCell>{stageCell(row.worstStage)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

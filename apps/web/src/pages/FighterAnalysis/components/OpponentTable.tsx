import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Match } from '@smash-tracker/shared';
import { getOpponentRecords } from '@/lib/stats';

/** Ports legacy/src/screens/FighterAnalysis/components/OpponentTable — per-human-opponent records for the selected fighter. */
export function OpponentTable({ fighterMatches }: { fighterMatches: Match[] }) {
  const records = getOpponentRecords(fighterMatches).sort((a, b) => b.total - a.total);

  return (
    <Card className="flex-1">
      <CardHeader>
        <CardTitle>Opponents</CardTitle>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">No named opponents recorded yet.</p>
        ) : (
          <div className="max-h-[400px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Opponent</TableHead>
                  <TableHead>Win Rate</TableHead>
                  <TableHead>Matches</TableHead>
                  <TableHead>Wins</TableHead>
                  <TableHead>Losses</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.opponent}>
                    <TableCell className="capitalize">{record.opponent}</TableCell>
                    <TableCell>{record.winRate}%</TableCell>
                    <TableCell>{record.total}</TableCell>
                    <TableCell>{record.wins}</TableCell>
                    <TableCell>{record.losses}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

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
import { getMatchTypeRecords } from '@/lib/stats';
import { WinLossPips } from '@/components/WinLossPips';

/**
 * v2 analytics: recent form (last 10 results) plus the win/loss record split
 * by match type, for the selected fighter.
 */
export function PerformanceSnapshot({ fighterMatches }: { fighterMatches: Match[] }) {
  const typeRecords = getMatchTypeRecords(fighterMatches);

  return (
    <Card className="flex-1">
      <CardHeader>
        <CardTitle>Performance Snapshot</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            Recent Form (newest first)
          </h3>
          <WinLossPips matches={fighterMatches} limit={10} />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">By Match Type</h3>
          {typeRecords.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matches yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead>Win Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {typeRecords.map((record) => (
                  <TableRow key={record.matchType}>
                    <TableCell>{record.matchType}</TableCell>
                    <TableCell>
                      {record.wins}-{record.losses}
                    </TableCell>
                    <TableCell>{record.winRate}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

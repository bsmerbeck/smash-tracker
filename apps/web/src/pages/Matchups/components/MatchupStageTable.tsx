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
import { getStageRecords } from '@/lib/stats';
import { stagesById, UNKNOWN_STAGE } from '@/data/stages';
import { StageOption } from '@/components/StageOption';

/**
 * Per-stage records for the selected matchup, sorted by sample size. The
 * unknown-stage sentinel (id 0) is shown last as "unknown" so older records
 * still count somewhere visible.
 */
export function MatchupStageTable({ matchupMatches }: { matchupMatches: Match[] }) {
  const records = getStageRecords(matchupMatches).sort((a, b) => {
    if (a.stageId === 0) return 1;
    if (b.stageId === 0) return -1;
    return b.total - a.total;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stage Breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches recorded for this matchup yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                <TableHead>Record</TableHead>
                <TableHead>Win Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={record.stageId}>
                  <TableCell>
                    <StageOption
                      stage={
                        record.stageId === 0
                          ? { ...UNKNOWN_STAGE, url: '' }
                          : (stagesById.get(record.stageId) ?? {
                              id: record.stageId,
                              name: 'Unknown',
                              url: '',
                            })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {record.wins}-{record.losses}
                  </TableCell>
                  <TableCell>{record.winRate}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

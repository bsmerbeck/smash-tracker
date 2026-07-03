import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { StageRecord } from '@/lib/stats';
import { stagesById } from '@/data/stages';

const MAX_STAGES = 6;

/** Stages this opponent takes you to most, sorted by sample size, top 6. */
export function ScoutingStagesCard({ byStage }: { byStage: StageRecord[] }) {
  const top = byStage.slice(0, MAX_STAGES);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stages</CardTitle>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stage data recorded yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                <TableHead>Record</TableHead>
                <TableHead className="text-right">Win Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.map((record) => (
                <TableRow key={record.stageId}>
                  <TableCell>
                    {record.stageId === 0
                      ? 'unknown'
                      : (stagesById.get(record.stageId)?.name ?? 'Unknown')}
                  </TableCell>
                  <TableCell>
                    {record.wins}-{record.losses}
                  </TableCell>
                  <TableCell className="text-right">{record.winRate}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

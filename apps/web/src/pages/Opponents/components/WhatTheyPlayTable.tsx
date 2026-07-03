import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { RankedMatchup } from '@/lib/stats';
import { getFighterById } from '@/data/sprites';

/**
 * "What they play" — the opponent's characters against you, your record per
 * character, evidence-ranked (Wilson lower bound) so the matchups you most
 * reliably win sit at the top.
 */
export function WhatTheyPlayTable({ byTheirFighter }: { byTheirFighter: RankedMatchup[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What They Play</CardTitle>
        <CardDescription>Ordered by how reliably you beat it.</CardDescription>
      </CardHeader>
      <CardContent>
        {byTheirFighter.length === 0 ? (
          <p className="text-sm text-muted-foreground">No characters recorded yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Character</TableHead>
                <TableHead>Record</TableHead>
                <TableHead>Win Rate</TableHead>
                <TableHead className="text-right">Games</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byTheirFighter.map((row) => {
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
                      {row.wins}-{row.losses}
                    </TableCell>
                    <TableCell>{row.ratio}%</TableCell>
                    <TableCell className="text-right">{row.totalMatches}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

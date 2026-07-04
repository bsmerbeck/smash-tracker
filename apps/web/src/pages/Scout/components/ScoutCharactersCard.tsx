import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ScoutCharacterUsage } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';

const MAX_ROWS = 8;

/** The scouted player's most-used characters (sprite + games + win rate). */
export function ScoutCharactersCard({ characters }: { characters: ScoutCharacterUsage[] }) {
  const top = characters.slice(0, MAX_ROWS);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Character Usage</CardTitle>
        <CardDescription>What they play, most-used first.</CardDescription>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sampled games yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Character</TableHead>
                <TableHead className="text-right">Win Rate</TableHead>
                <TableHead className="text-right">Games</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.map((row) => {
                const sprite = row.fighterId === 0 ? null : getFighterById(row.fighterId);
                const winRate = Math.round((row.wins / row.games) * 100);
                return (
                  <TableRow key={row.fighterId}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {sprite ? (
                          <img src={sprite.url} alt="" className="size-6 object-contain" />
                        ) : (
                          <span className="flex size-6 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">
                            ?
                          </span>
                        )}
                        <span>{sprite?.name ?? 'Unknown'}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{winRate}%</TableCell>
                    <TableCell className="text-right">{row.games}</TableCell>
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

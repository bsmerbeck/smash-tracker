import { ExternalLink, Trophy } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { buildEventResultRows, type EventResultRow } from '../lib/eventResults';

function ProfileLink({ row }: { row: EventResultRow }) {
  if (!row.profileUrl) {
    return null;
  }
  return (
    <a
      href={row.profileUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`View ${row.displayName} on start.gg`}
      className="inline-flex text-muted-foreground hover:text-foreground"
    >
      <ExternalLink className="size-3.5" />
    </a>
  );
}

function ResultRow({ row }: { row: EventResultRow }) {
  const nameCell = (
    <span className="inline-flex items-center gap-2">
      {row.standing.placement === 1 && <Trophy className="size-4 text-amber-500" />}
      <span>
        {row.displayName}
        {row.subLabel && (
          <span className="ml-1 text-xs text-muted-foreground">({row.subLabel})</span>
        )}
      </span>
      <ProfileLink row={row} />
    </span>
  );

  return (
    <TableRow className={cn(row.playedAtEvent && 'bg-primary/5')}>
      <TableCell className="font-medium">{row.standing.placement}</TableCell>
      <TableCell>
        {row.playedAtEvent ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default underline decoration-dotted underline-offset-4">
                {nameCell}
              </span>
            </TooltipTrigger>
            <TooltipContent>You played them at this event</TooltipContent>
          </Tooltip>
        ) : (
          nameCell
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Winner callout + top-8 standings table, sourced from
 * `entry.topStandings` (populated post-sync, capped to ~8 by the API — see
 * `packages/shared/src/startgg.ts`). Rows whose name/gamerTag match an
 * opponent the user actually played at this event (via `entryMatches`) get a
 * subtle tint + tooltip; rows with a `userSlug` link out to the entrant's
 * start.gg profile. Renders a resync hint instead of an empty table when
 * `topStandings` hasn't synced yet (pre-Phase-A data, or synced before this
 * field existed).
 */
export function EventResults({
  entry,
  entryMatches,
}: {
  entry: TournamentEntry;
  entryMatches: Match[];
}) {
  const rows = buildEventResultRows(entry, entryMatches);
  const winner = rows.find((row) => row.standing.placement === 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Event Results</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Full results attach on your next start.gg sync.
          </p>
        ) : (
          <>
            {winner && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <Trophy className="size-5 text-amber-500" />
                <span className="text-sm font-medium">{winner.displayName} won this event</span>
                <ProfileLink row={winner} />
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Place</TableHead>
                  <TableHead>Entrant</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <ResultRow key={row.standing.placement} row={row} />
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

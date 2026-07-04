import { Trophy } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ScoutRecentEvent } from '@smash-tracker/shared';

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** The scouted player's most recent events (placement/entrants), most recent first. */
export function ScoutRecentEventsCard({ events }: { events: ScoutRecentEvent[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Events</CardTitle>
        <CardDescription>Most recent activity first.</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent events sampled.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Placement</TableHead>
                <TableHead className="text-right">Entrants</TableHead>
                <TableHead className="text-right">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={`${event.eventName}-${event.lastSetAt}`}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{event.eventName}</span>
                      {event.tournamentName && (
                        <span className="text-xs text-muted-foreground">
                          {event.tournamentName}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {event.placement ? (
                      <span className="inline-flex items-center gap-1">
                        {event.placement === 1 && <Trophy className="size-3.5 text-amber-500" />}
                        {ordinal(event.placement)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{event.numEntrants ?? '—'}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {new Date(event.lastSetAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

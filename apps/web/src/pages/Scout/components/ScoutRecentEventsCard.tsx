import { ExternalLink, Trophy } from 'lucide-react';
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

/**
 * Builds the public event URL for an event with a `slug`, or `null` when the
 * event can't be deep-linked. start.gg event slugs already carry the full
 * path (e.g. "tournament/the-big-house-9/event/ultimate-singles"), so the
 * link is simply `https://www.start.gg/{slug}` (V9-B Feature 2, verified
 * against start.gg's own URL convention).
 *
 * parry.gg events are deliberately NOT linked here even when a slug is
 * present in principle: unlike start.gg, this app has not empirically
 * verified a working parry.gg EVENT page URL (only the PROFILE URL shape,
 * `https://parry.gg/profile/{uuid}`, was confirmed live — see
 * apps/api/src/parrygg/scout.ts). Rather than guess at a URL shape that
 * might 404, parry.gg-sourced events render as plain text until that shape
 * is verified.
 */
function eventUrl(event: ScoutRecentEvent): string | null {
  if (!event.slug) {
    return null;
  }
  if (event.source === 'parrygg') {
    return null;
  }
  return `https://www.start.gg/${event.slug}`;
}

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
              {events.map((event) => {
                const url = eventUrl(event);
                return (
                  <TableRow key={`${event.eventName}-${event.lastSetAt}`}>
                    <TableCell>
                      <div className="flex flex-col">
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                          >
                            {event.eventName}
                            <ExternalLink className="size-3" />
                          </a>
                        ) : (
                          <span className="font-medium">{event.eventName}</span>
                        )}
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
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

import { useTranslation } from 'react-i18next';
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
import { useRowLayout, type RowLayout } from '@/hooks/useRowLayout';

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

/** The event cell — one rendering definition for the table and the stacked row (plan 39.1-49). */
function EventCell({ event }: { event: ScoutRecentEvent }) {
  const url = eventUrl(event);
  return (
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
        <span className="text-xs text-muted-foreground">{event.tournamentName}</span>
      )}
    </div>
  );
}

/** The placement cell — shared by both layouts. */
function PlacementCell({ event }: { event: ScoutRecentEvent }) {
  return event.placement ? (
    <span className="inline-flex items-center gap-1">
      {event.placement === 1 && <Trophy className="size-3.5 text-amber-500" />}
      {ordinal(event.placement)}
    </span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

/** The scouted player's most recent events (placement/entrants), most recent first. */
export function ScoutRecentEventsCard({
  events,
  layout: layoutOverride,
}: {
  events: ScoutRecentEvent[];
  /** Plan 39.1-49: forces one layout (tests); otherwise read once from the viewport (below 640px: stacked rows). */
  layout?: RowLayout;
}) {
  const { t, i18n } = useTranslation();
  // Plan 39.1-49 (UI-SPEC §6.6): exactly one root mounts per render.
  const layout = useRowLayout(layoutOverride);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('scout.events.title')}</CardTitle>
        <CardDescription>{t('scout.events.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('scout.events.empty')}</p>
        ) : layout === 'stack' ? (
          // Plan 39.1-49 (UI-SPEC §6.6 / §6.5 rules 1-2): one stacked row per
          // event — line 1 the event (its external link unchanged) and
          // tournament, wrapping whole; line 2 placement, entrants and date
          // as whole tokens with their column labels.
          <ul data-slot="scout-recent-events" className="flex flex-col divide-y">
            {events.map((event) => (
              <li
                key={`${event.eventName}-${event.lastSetAt}`}
                data-slot="scout-recent-event"
                className="flex min-w-0 flex-col gap-1 py-2 text-sm"
              >
                <div className="min-w-0 break-words">
                  <EventCell event={event} />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground tabular-nums">
                  <span className="whitespace-nowrap">
                    <span className="sr-only">{t('scout.events.placement')} </span>
                    <PlacementCell event={event} />
                  </span>
                  <span className="whitespace-nowrap">
                    {event.numEntrants ?? '—'} {t('scout.events.entrants')}
                  </span>
                  <span className="whitespace-nowrap">
                    <span className="sr-only">{t('trends.sessions.date')} </span>
                    {new Date(event.lastSetAt).toLocaleDateString(i18n.language)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Table data-slot="scout-recent-events">
            <TableHeader>
              <TableRow>
                <TableHead>{t('trends.tournaments.event')}</TableHead>
                <TableHead>{t('scout.events.placement')}</TableHead>
                <TableHead className="text-right">{t('scout.events.entrants')}</TableHead>
                <TableHead className="text-right">{t('trends.sessions.date')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => {
                return (
                  <TableRow key={`${event.eventName}-${event.lastSetAt}`}>
                    <TableCell>
                      <EventCell event={event} />
                    </TableCell>
                    <TableCell>
                      <PlacementCell event={event} />
                    </TableCell>
                    <TableCell className="text-right">{event.numEntrants ?? '—'}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {new Date(event.lastSetAt).toLocaleDateString(i18n.language)}
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

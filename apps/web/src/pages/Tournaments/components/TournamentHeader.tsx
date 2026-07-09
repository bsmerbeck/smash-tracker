import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { TournamentEntry } from '@smash-tracker/shared';
import { buildEventStartggUrl } from '../lib/startggLinks';

function formatDate(time: number, locale: string): string {
  return new Date(time).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateRange(entry: TournamentEntry, locale: string): string {
  const start = formatDate(entry.firstSetAt, locale);
  const end = formatDate(entry.lastSetAt, locale);
  return start === end ? start : `${start} – ${end}`;
}

export interface SeedPlacementBadge {
  tone: 'success' | 'destructive' | 'secondary';
  label: string;
}

/**
 * Seed -> placement badge, when both fields are present on the entry: a
 * lower placement number than seed means the player outperformed their
 * seed (success-toned), a higher placement means they underperformed
 * (destructive-toned), and an exact match is neutral. Returns `null` when
 * either field is absent — callers must omit the badge cleanly.
 */
export function buildSeedPlacementBadge(
  entry: TournamentEntry,
  t: TFunction,
): SeedPlacementBadge | null {
  if (entry.seed == null || entry.placement == null) {
    return null;
  }
  const { seed, placement } = entry;
  if (placement < seed) {
    return { tone: 'success', label: t('tournaments.header.outperformed', { seed, placement }) };
  }
  if (placement > seed) {
    return {
      tone: 'destructive',
      label: t('tournaments.header.underperformed', { seed, placement }),
    };
  }
  return { tone: 'secondary', label: t('tournaments.header.matched', { seed, placement }) };
}

/**
 * Tournament detail header: tournament name (falling back to the event name
 * when start.gg didn't provide one), the event name sub-line, date range,
 * entrant count, the seed->placement badge when both are known, and an
 * outbound "View on start.gg" button when `eventSlug`/`slug` has synced
 * (falls back to the tournament slug when the event slug isn't available
 * yet; hidden entirely when neither is present).
 */
export function TournamentHeader({ entry }: { entry: TournamentEntry }) {
  const { t, i18n } = useTranslation();
  const title = entry.tournamentName ?? entry.eventName;
  const showEventSubline = entry.tournamentName != null && entry.tournamentName !== entry.eventName;
  const badge = buildSeedPlacementBadge(entry, t);
  const startggUrl = buildEventStartggUrl(entry);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle className="text-2xl">{title}</CardTitle>
          {showEventSubline && (
            <p className="mt-1 text-sm text-muted-foreground">{entry.eventName}</p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDateRange(entry, i18n.language)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 text-right">
          {entry.numEntrants != null && (
            <p className="text-sm text-muted-foreground">
              {t('tournaments.header.entrants', { count: entry.numEntrants })}
            </p>
          )}
          {badge && (
            <Badge variant={badge.tone === 'secondary' ? 'secondary' : badge.tone}>
              {badge.label}
            </Badge>
          )}
          {startggUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={startggUrl} target="_blank" rel="noreferrer">
                {t('shared.startgg.view')}
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {t('tournaments.header.setsPlayed', { count: entry.setsPlayed })}
        </p>
      </CardContent>
    </Card>
  );
}

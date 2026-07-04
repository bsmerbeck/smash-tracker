import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { TournamentEntry } from '@smash-tracker/shared';

function formatDate(time: number): string {
  return new Date(time).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateRange(entry: TournamentEntry): string {
  const start = formatDate(entry.firstSetAt);
  const end = formatDate(entry.lastSetAt);
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
export function buildSeedPlacementBadge(entry: TournamentEntry): SeedPlacementBadge | null {
  if (entry.seed == null || entry.placement == null) {
    return null;
  }
  const { seed, placement } = entry;
  if (placement < seed) {
    return { tone: 'success', label: `Outperformed seed: ${seed} → ${placement}` };
  }
  if (placement > seed) {
    return { tone: 'destructive', label: `Underperformed seed: ${seed} → ${placement}` };
  }
  return { tone: 'secondary', label: `Matched seed: ${seed} → ${placement}` };
}

/**
 * Tournament detail header: tournament name (falling back to the event name
 * when start.gg didn't provide one), the event name sub-line, date range,
 * entrant count, and the seed->placement badge when both are known.
 */
export function TournamentHeader({ entry }: { entry: TournamentEntry }) {
  const title = entry.tournamentName ?? entry.eventName;
  const showEventSubline = entry.tournamentName != null && entry.tournamentName !== entry.eventName;
  const badge = buildSeedPlacementBadge(entry);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle className="text-2xl">{title}</CardTitle>
          {showEventSubline && (
            <p className="mt-1 text-sm text-muted-foreground">{entry.eventName}</p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">{formatDateRange(entry)}</p>
        </div>
        <div className="flex flex-col items-end gap-2 text-right">
          {entry.numEntrants != null && (
            <p className="text-sm text-muted-foreground">{entry.numEntrants} entrants</p>
          )}
          {badge && (
            <Badge variant={badge.tone === 'secondary' ? 'secondary' : badge.tone}>
              {badge.label}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{entry.setsPlayed} sets played</p>
      </CardContent>
    </Card>
  );
}

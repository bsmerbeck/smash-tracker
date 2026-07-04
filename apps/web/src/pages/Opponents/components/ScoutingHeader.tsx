import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WinLossPips } from '@/components/WinLossPips';
import type { OpponentProfile } from '@/lib/stats';
import type { EncounterContext } from '../tournamentHistory';

function formatEncounterContext(context: EncounterContext): string | null {
  if (context.tournamentCount === 0 || !context.span) {
    return null;
  }
  const count = context.tournamentCount;
  const start = new Date(context.span.start).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
  const end = new Date(context.span.end).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
  const tournamentWord = count === 1 ? 'tournament' : 'tournaments';
  const span = start === end ? start : `${start} and ${end}`;
  return `Met at ${count} ${tournamentWord} between ${span}`;
}

/**
 * Scouting report header: opponent tag, overall H2H record + rate + sample
 * size, first/last played dates, last-10 form pips vs this opponent, and (when
 * tournament-tagged encounters exist) an encounter context line summarizing
 * how many tournaments and over what date span you've met them.
 */
export function ScoutingHeader({
  profile,
  encounterContext,
}: {
  profile: OpponentProfile;
  encounterContext: EncounterContext;
}) {
  const { record } = profile;
  const encounterLine = formatEncounterContext(encounterContext);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
        <div>
          <CardTitle className="text-2xl">{profile.opponent}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            First played {new Date(profile.firstPlayedAt).toLocaleDateString()} · Last played{' '}
            {new Date(profile.lastPlayedAt).toLocaleDateString()}
          </p>
          {encounterLine && <p className="mt-1 text-sm text-muted-foreground">{encounterLine}</p>}
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold">
            {record.wins}-{record.losses}
          </p>
          <p className="text-sm text-muted-foreground">
            {record.winRate}% over {record.total} game{record.total === 1 ? '' : 's'}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">Last 10 (newest first)</h3>
        <WinLossPips matches={profile.recent} limit={10} />
      </CardContent>
    </Card>
  );
}

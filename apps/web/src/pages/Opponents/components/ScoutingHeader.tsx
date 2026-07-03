import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WinLossPips } from '@/components/WinLossPips';
import type { OpponentProfile } from '@/lib/stats';

/**
 * Scouting report header: opponent tag, overall H2H record + rate + sample
 * size, first/last played dates, and last-10 form pips vs this opponent.
 */
export function ScoutingHeader({ profile }: { profile: OpponentProfile }) {
  const { record } = profile;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
        <div>
          <CardTitle className="text-2xl">{profile.opponent}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            First played {new Date(profile.firstPlayedAt).toLocaleDateString()} · Last played{' '}
            {new Date(profile.lastPlayedAt).toLocaleDateString()}
          </p>
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

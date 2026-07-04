import { Link } from 'react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { WinLossPips } from '@/components/WinLossPips';
import type { OpponentProfile } from '@/lib/stats';

/**
 * "Your history vs them": shown only when the scouted player's gamer tag
 * matches an opponent tag already in the caller's own match history (see
 * `ScoutPage`'s case-insensitive match against `getOpponentProfile`).
 * Reuses the same head-to-head profile the Scouting page (`/opponents`)
 * builds, so the record here can never disagree with that report — this is
 * just a compact pointer to it.
 */
export function YourHistoryStrip({ profile }: { profile: OpponentProfile }) {
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader>
        <CardTitle>Your History vs Them</CardTitle>
        <CardDescription>
          You've played {profile.opponent} before — {profile.record.total} game
          {profile.record.total === 1 ? '' : 's'} recorded in your own match history.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-lg font-semibold">
            {profile.record.wins}-{profile.record.losses}{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({profile.record.winRate}% win rate)
            </span>
          </span>
          <WinLossPips matches={profile.recent} />
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/opponents">Full scouting report</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

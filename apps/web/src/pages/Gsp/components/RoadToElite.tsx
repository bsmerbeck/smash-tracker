import { PartyPopper } from 'lucide-react';
import type { GspPoint } from '@smash-tracker/shared';
import { projectMatchesToElite } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getRecentGspWinRate } from './GspHero';

/**
 * The GSP page's projection card — "how many more matches at my current win
 * rate until I hit Elite Smash". Built entirely on `projectMatchesToElite`
 * (packages/shared/src/gsp.ts), which fits an exponential decay of per-win
 * GSP gain from the player's own history (falling back to a cruder flat
 * average with too little data). Always shown alongside the model's
 * `assumptions` and a reminder that GSP's real formula isn't public — this is
 * a simulation, not a guarantee.
 */
export function RoadToElite({
  series,
  eliteThreshold,
}: {
  series: GspPoint[];
  eliteThreshold: number;
}) {
  const currentGsp = series.length > 0 ? series[series.length - 1]!.gsp : null;
  const winRate = getRecentGspWinRate(series) ?? 0;
  const isElite = currentGsp !== null && currentGsp >= eliteThreshold;

  const projection =
    currentGsp === null || isElite ? null : projectMatchesToElite(series, eliteThreshold, winRate);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Road to Elite</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {currentGsp === null ? (
          <p className="text-sm text-muted-foreground">
            Log a match with a GSP reading for this fighter to see a projection.
          </p>
        ) : isElite ? (
          <div className="flex items-center gap-2 text-emerald-500">
            <PartyPopper className="size-6" />
            <p className="text-lg font-semibold">You&apos;re already in Elite Smash!</p>
          </div>
        ) : projection ? (
          <>
            <p className="text-2xl font-bold">
              ~{projection.matchesNeededLabel} more match
              {projection.matchesNeededLabel === '1' ? '' : 'es'}
            </p>
            <p className="text-sm text-muted-foreground">
              at your current {Math.round(winRate * 100)}% win rate (estimate)
            </p>
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {projection.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not enough win/loss history with GSP readings yet to project a path to Elite. Keep
            logging matches — this needs a handful of wins to fit a trend.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

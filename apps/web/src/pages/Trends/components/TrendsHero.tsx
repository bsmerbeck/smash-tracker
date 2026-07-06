import type { ReactNode } from 'react';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMonthLabel } from './MonthlyPerformance';
import { BEST_MONTH_MIN_GAMES, CURRENT_FORM_WINDOW, buildTrendsHero } from '../lib/trendsHero';

/**
 * Trends hero stat row (V9-C): current rating ±RD, peak rating, best month,
 * and current form — mirroring Fighter Analysis's hero-stat treatment so
 * Trends opens with the same "at a glance" summary instead of jumping
 * straight into cards. Computed entirely from `buildTrendsHero`, itself
 * derived from data the rest of the page already has (no new API calls).
 */
export function TrendsHero({ matches }: { matches: Match[] }) {
  const hero = buildTrendsHero(matches);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <HeroCard label="Current Rating">
        {hero.currentRating ? (
          <>
            <span className="text-3xl font-bold">
              {hero.currentRating.rating}{' '}
              <span className="text-lg font-normal">&plusmn;{hero.currentRating.rd}</span>
            </span>
            <p className="text-sm text-muted-foreground">Glicko-2 rating</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Not enough games yet</p>
        )}
      </HeroCard>

      <HeroCard label="Peak Rating">
        {hero.peakRating != null ? (
          <>
            <span className="text-3xl font-bold">{hero.peakRating}</span>
            <p className="text-sm text-muted-foreground">Best session rating</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Not enough games yet</p>
        )}
      </HeroCard>

      <HeroCard label="Best Month">
        {hero.bestMonth ? (
          <>
            <span className="text-3xl font-bold">{hero.bestMonth.winRate}%</span>
            <p className="text-sm text-muted-foreground">
              {formatMonthLabel(hero.bestMonth.month)} &middot; {hero.bestMonth.wins}-
              {hero.bestMonth.losses} ({hero.bestMonth.total} games)
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Needs a month with {BEST_MONTH_MIN_GAMES}+ games
          </p>
        )}
      </HeroCard>

      <HeroCard label="Current Form">
        {hero.currentFormGames > 0 ? (
          <>
            <span className="text-3xl font-bold">{hero.currentFormWinRate}%</span>
            <p className="text-sm text-muted-foreground">
              Last {hero.currentFormGames} of {CURRENT_FORM_WINDOW} games
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No match data to report yet.</p>
        )}
      </HeroCard>
    </div>
  );
}

function HeroCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">{children}</CardContent>
    </Card>
  );
}

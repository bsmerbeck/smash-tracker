import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t, i18n } = useTranslation();
  const hero = buildTrendsHero(matches);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <HeroCard label={t('trends.hero.currentRating')}>
        {hero.currentRating ? (
          <>
            <span className="text-3xl font-bold">
              {hero.currentRating.rating}{' '}
              <span className="text-lg font-normal">&plusmn;{hero.currentRating.rd}</span>
            </span>
            <p className="text-sm text-muted-foreground">{t('trends.hero.glickoRating')}</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('trends.hero.notEnoughGames')}</p>
        )}
      </HeroCard>

      <HeroCard label={t('trends.hero.peakRating')}>
        {hero.peakRating != null ? (
          <>
            <span className="text-3xl font-bold">{hero.peakRating}</span>
            <p className="text-sm text-muted-foreground">{t('trends.hero.bestSessionRating')}</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('trends.hero.notEnoughGames')}</p>
        )}
      </HeroCard>

      <HeroCard label={t('trends.hero.bestMonth')}>
        {hero.bestMonth ? (
          <>
            <span className="text-3xl font-bold">{hero.bestMonth.winRate}%</span>
            <p className="text-sm text-muted-foreground">
              {t('trends.hero.bestMonthCaption', {
                month: formatMonthLabel(hero.bestMonth.month, i18n.language),
                wins: hero.bestMonth.wins,
                losses: hero.bestMonth.losses,
                count: hero.bestMonth.total,
              })}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('trends.hero.bestMonthNeeds', { count: BEST_MONTH_MIN_GAMES })}
          </p>
        )}
      </HeroCard>

      <HeroCard label={t('trends.hero.currentForm')}>
        {hero.currentFormGames > 0 ? (
          <>
            <span className="text-3xl font-bold">{hero.currentFormWinRate}%</span>
            <p className="text-sm text-muted-foreground">
              {t('trends.hero.formCaption', {
                played: hero.currentFormGames,
                window: CURRENT_FORM_WINDOW,
              })}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>
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

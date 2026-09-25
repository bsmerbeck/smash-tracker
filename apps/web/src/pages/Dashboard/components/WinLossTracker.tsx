import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { filterByFighter, getWinLossRecord } from '@/lib/stats';
import type { Match } from '@smash-tracker/shared';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { useDashboardContext } from '../DashboardContext';

/**
 * Ports legacy/src/screens/Dashboard/components/WinLossTracker.
 *
 * Plan 39.1-17 (UIX-04): the banned flex-distribution collision (owner's
 * "garbage spacing" note) and the page-local `Stat` component are gone —
 * wins/rate/losses now go through the ONE stat idiom (`StatRow`/
 * `StatFigure`), the last page-local stat component on this surface.
 */
export function WinLossTracker({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const { fighter } = useDashboardContext();

  const fighterMatches = fighter ? filterByFighter(matches, fighter.id) : [];
  const hasMatches = fighterMatches.length > 0;
  const { wins, losses, winRate } = getWinLossRecord(fighterMatches);

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-center">{t('dashboard.hero.overallRecord')}</CardTitle>
      </CardHeader>
      <CardContent>
        {hasMatches ? (
          <StatRow
            figures={[
              <StatFigure key="wins" label={t('common.wins')} value={wins} />,
              <StatFigure key="rate" label={t('common.rate')} value={`${winRate}%`} />,
              <StatFigure key="losses" label={t('common.losses')} value={losses} />,
            ]}
          />
        ) : (
          <p className="text-center text-sm text-muted-foreground">{t('common.noMatchData')}</p>
        )}
      </CardContent>
    </Card>
  );
}

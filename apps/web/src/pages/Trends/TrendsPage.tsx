import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { TrendsHero } from './components/TrendsHero';
import { MonthlyPerformance } from './components/MonthlyPerformance';
import { SessionsAndTilt } from './components/SessionsAndTilt';
import { SettingComparison } from './components/SettingComparison';
import { Tournaments } from './components/Tournaments';
import { MatchTypeMix } from './components/MatchTypeMix';
import { RatingCurve } from './components/RatingCurve';

/**
 * V3 Phase F (docs/analytics-vision.md): monthly performance, sessions/tilt,
 * online-vs-offline comparison, per-tournament results, and match-type mix
 * over time. V6-W2 adds the session-based Glicko-2 rating curve. Account-wide
 * (not per-fighter), honoring the global source/time-range filter like the
 * other analytics pages.
 */
export function TrendsPage() {
  const { t } = useTranslation();
  const { matches, allMatches, isLoading, filterActive } = useFilteredMatches();

  if (isLoading) {
    return <div className="text-muted-foreground">{t('trends.loading')}</div>;
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">{t('trends.noMatches')}</h2>
        <Button asChild className="mt-2">
          <Link to="/dashboard">{t('common.goToDashboard')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <TrendsHero matches={matches} />

      <MonthlyPerformance matches={matches} />

      <RatingCurve matches={matches} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SessionsAndTilt matches={matches} />
        <SettingComparison matches={matches} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Tournaments matches={matches} />
        <MatchTypeMix matches={matches} />
      </div>
    </div>
  );
}

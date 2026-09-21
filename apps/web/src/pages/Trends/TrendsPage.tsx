import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useHorizon } from '@/hooks/useHorizon';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { TrendsHero } from './components/TrendsHero';
import { TrendsReadsRail } from './components/TrendsReadsRail';
import { MonthlyPerformance } from './components/MonthlyPerformance';
import { SessionsAndTilt } from './components/SessionsAndTilt';
import { SettingComparison } from './components/SettingComparison';
import { Tournaments } from './components/Tournaments';
import { MatchTypeMix } from './components/MatchTypeMix';
import { RatingCurve } from './components/RatingCurve';

/**
 * Trends, recomposed onto the insight-first Pro-desk grid contract (UI-SPEC
 * §8.2, TRND-02, INS-05): `PageShell` -> one filter row (title + `HorizonSwitch`)
 * -> `PageGrid` rows. Own-account only (38 D-04) — every link this page
 * builds is an own-account link, never branched on coach state.
 *
 * Row 1 is the five-figure `StatRow` hero. Row 2 (the interim career-timeline
 * slot: the existing `RatingCurve`/`MonthlyPerformance` charts at 6+6) lands
 * in plan 39.1-15's Task 3 (`CareerTimelineSlot`) — this task mounts them
 * directly as a placeholder. Row 3 is the three 4-col rails: left (Sessions &
 * Tilt — Recent events is added by Task 2), centre (`TrendsReadsRail`, the
 * engine-backed reads), right (Setting comparison, Match-type mix).
 *
 * The page-level `RatingModelNote` banner is REMOVED here (UI-SPEC §8.2): it
 * is demoted to a secondary door on `TrendsReadsRail`'s rating-move card.
 */
export function TrendsPage() {
  const { t } = useTranslation();
  const { matches, allMatches, isLoading, filterActive } = useFilteredMatches();
  const { horizon } = useHorizon();

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

  const filterRow = (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-6 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('trends.title')}</h1>
        <HorizonSwitch />
      </CardContent>
    </Card>
  );

  return (
    <PageShell filterRow={filterRow}>
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <PageGrid>
        <GridCell span={12}>
          <TrendsHero matches={matches} horizon={horizon} />
        </GridCell>

        {/* Interim career-timeline slot (Task 3 wraps these in
            `CareerTimelineSlot`; this task mounts them directly). */}
        <GridCell span={6}>
          <RatingCurve matches={matches} />
        </GridCell>
        <GridCell span={6}>
          <MonthlyPerformance matches={matches} />
        </GridCell>

        <GridCell span={4} stack>
          <SessionsAndTilt matches={matches} />
          <Tournaments matches={matches} />
        </GridCell>

        <GridCell span={4}>
          <TrendsReadsRail matches={matches} horizon={horizon} />
        </GridCell>

        <GridCell span={4} stack>
          <SettingComparison matches={matches} />
          <MatchTypeMix matches={matches} />
        </GridCell>
      </PageGrid>
    </PageShell>
  );
}

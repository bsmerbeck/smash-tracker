import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildCareerTimeline, type HorizonKey, type Match } from '@smash-tracker/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { CareerTimeline, type CareerTimelineLabels } from '@/components/charts/CareerTimeline';
import { GlickoExplainer } from '@/components/GlickoExplainer';

export interface CareerTimelineCardProps {
  /** The page's filtered, own-account matches (38 D-04) — never a coach subject. */
  matches: Match[];
  /** The page's ONE persisted horizon — the recent-window band follows it. */
  horizon: HorizonKey;
}

/**
 * Trends Row 2 (plan 39.1-34, owner decision 2026-09-25 — supersedes D-02
 * for the timeline; D-13, UI-SPEC §12.1, sketch 002-C): ONE 12-col career
 * timeline card replacing the chart.js Rating Curve and Monthly Performance
 * pair. The engine bins (memoised by the matches array reference); this host
 * only localises and frames — the kit chart never localises.
 */
export function CareerTimelineCard({ matches, horizon }: CareerTimelineCardProps) {
  const { t } = useTranslation();
  // React Compiler forbids a bare `Date.now()` in render — the lazy
  // `useState` initializer is the established one-time read (TrendsHero).
  const [nowMs] = useState(() => Date.now());
  const timeline = useMemo(
    () => buildCareerTimeline({ matches, horizon, nowMs }),
    [matches, horizon, nowMs],
  );

  const current = timeline.rating.current;
  const pointCount = timeline.rating.points.length;
  const labels: CareerTimelineLabels = useMemo(
    () => ({
      rate: t('analytics.timeline.strip.rate'),
      games: t('analytics.timeline.strip.games'),
      aria: t('analytics.timeline.aria', {
        count: pointCount,
        rating: current?.rating ?? 0,
        rd: current?.rd ?? 0,
      }),
      locked: t('shared.evidence.abstained', { count: timeline.gamesNeeded }),
    }),
    [t, pointCount, current, timeline.gamesNeeded],
  );

  return (
    <ChartCard
      title={t('analytics.timeline.title')}
      density="compact"
      headerRight={<GlickoExplainer />}
    >
      <CareerTimeline timeline={timeline} labels={labels} />
    </ChartCard>
  );
}

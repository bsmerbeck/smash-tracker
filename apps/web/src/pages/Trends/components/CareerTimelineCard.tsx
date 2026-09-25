import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TREND_MIN_RECENT_GAMES,
  buildCareerTimeline,
  type CareerRatingGrain,
  type HorizonKey,
  type Match,
} from '@smash-tracker/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { CareerTimeline, type CareerTimelineLabels } from '@/components/charts/CareerTimeline';
import { GlickoExplainer } from '@/components/GlickoExplainer';

export interface CareerTimelineCardProps {
  /** The page's filtered, own-account matches (38 D-04) — never a coach subject. */
  matches: Match[];
  /** The page's ONE persisted horizon — the recent-window band follows it. */
  horizon: HorizonKey;
  /**
   * D-04 test affordance: an explicit chart width in px, passed straight to
   * the kit's `width` (Recharts renders 0x0 under jsdom's
   * ResponsiveContainer). Omitted at runtime — the chart measures itself.
   */
  chartWidth?: number;
}

/** The grain one rung finer than each calendar grain — the one the caption says would not fit. */
const FINER_GRAIN: Record<Exclude<CareerRatingGrain, 'session'>, CareerRatingGrain> = {
  week: 'session',
  month: 'week',
  quarter: 'month',
  year: 'quarter',
};

/**
 * Every caption item but the last ends with a CSS middot separator — never JSX
 * text between two t() calls. Trailing (not leading), so a wrapped line never
 * starts with a separator.
 */
const CAPTION_ITEM_CLASSES =
  "[&:not(:last-child)]:after:mx-1.5 [&:not(:last-child)]:after:content-['·']";

/**
 * Trends Row 2 (plan 39.1-34, owner decision 2026-09-25 — supersedes D-02
 * for the timeline; D-13, UI-SPEC §12.1, sketch 002-C `RatingCard`): ONE
 * 12-col career timeline card replacing the chart.js Rating Curve and Monthly
 * Performance pair. The engine bins (memoised by the matches array
 * reference); this host only localises and frames — the kit chart never
 * localises. Header: title, the grain meta (≥1280px, like the sketch's
 * `hide-lap`) and the GlickoExplainer; footer: the grain, the sessions, the
 * ladder, the strip legend and the model, each its own whole key.
 */
export function CareerTimelineCard({ matches, horizon, chartWidth }: CareerTimelineCardProps) {
  const { t } = useTranslation();
  // React Compiler forbids a bare `Date.now()` in render — the lazy
  // `useState` initializer is the established one-time read (TrendsHero).
  const [nowMs] = useState(() => Date.now());
  const timeline = useMemo(
    () => buildCareerTimeline({ matches, horizon, nowMs }),
    [matches, horizon, nowMs],
  );

  const { rating } = timeline;
  const current = rating.current;
  const labels: CareerTimelineLabels = useMemo(
    () => ({
      rate: t('analytics.timeline.strip.rate'),
      games: t('analytics.timeline.strip.games'),
      aria: t('analytics.timeline.aria', {
        count: rating.points.length,
        rating: current?.rating ?? 0,
        rd: current?.rd ?? 0,
      }),
      locked: t('shared.evidence.abstained', { count: timeline.gamesNeeded }),
      value: (value: number) => t('analytics.timeline.label.value', { rating: value }),
      rd: (rd: number) => t('analytics.timeline.label.rd', { rd }),
      peakClose: (value: number) => t('analytics.timeline.label.peakClose', { rating: value }),
      lowClose: (value: number) => t('analytics.timeline.label.lowClose', { rating: value }),
      peak: (value: number) => t('analytics.timeline.label.peak', { rating: value }),
      low: (value: number) => t('analytics.timeline.label.low', { rating: value }),
      band: t(`insights.horizon.${horizon}`),
    }),
    [t, rating.points.length, current, timeline.gamesNeeded, horizon],
  );

  const unlocked = timeline.state !== 'locked' && rating.points.length > 0;
  const captionItems: { key: string; text: string }[] = [];
  if (unlocked) {
    captionItems.push({
      key: 'closes',
      text: t(`analytics.timeline.caption.closes.${rating.grain}`, {
        count: rating.points.length,
      }),
    });
    captionItems.push({
      key: 'sessions',
      text: t('analytics.timeline.caption.sessions', { count: rating.sessionCount }),
    });
    if (rating.grain !== 'session' && rating.finerGrainPointCount !== null) {
      captionItems.push({
        key: 'ladder',
        text: t(`analytics.timeline.caption.ladder.${FINER_GRAIN[rating.grain]}`, {
          count: rating.finerGrainPointCount,
        }),
      });
    }
    if (timeline.state === 'full') {
      captionItems.push({
        key: 'strips',
        text: t('analytics.timeline.caption.strips', {
          baseline: `${Math.round(timeline.baseline.rate * 100)}%`,
          floor: TREND_MIN_RECENT_GAMES,
        }),
      });
    }
    captionItems.push({ key: 'model', text: t('analytics.timeline.caption.model') });
  }

  return (
    <ChartCard
      title={t('analytics.timeline.title')}
      density="compact"
      headerRight={
        <div className="flex items-center gap-2">
          {unlocked && (
            <span className="hidden text-xs leading-4 text-muted-foreground xl:inline">
              {t(`analytics.timeline.meta.${rating.grain}`)}
            </span>
          )}
          <GlickoExplainer />
        </div>
      }
      footer={
        captionItems.length > 0 ? (
          <p
            className="mt-4 flex flex-wrap text-xs leading-4 text-muted-foreground tabular-nums"
            data-slot="career-timeline-caption"
          >
            {captionItems.map((item) => (
              <span
                key={item.key}
                data-slot="career-timeline-caption-item"
                className={CAPTION_ITEM_CLASSES}
              >
                {item.text}
              </span>
            ))}
          </p>
        ) : undefined
      }
    >
      <CareerTimeline timeline={timeline} labels={labels} width={chartWidth} />
    </ChartCard>
  );
}

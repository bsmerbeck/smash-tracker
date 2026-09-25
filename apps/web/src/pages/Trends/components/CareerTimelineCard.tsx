import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SUGGESTION_MIN_GAMES,
  TREND_MIN_RECENT_GAMES,
  buildCareerTimeline,
  type CareerRatingGrain,
  type CareerRatingPoint,
  type HorizonKey,
  type Match,
} from '@smash-tracker/shared';
import type { TFunction } from 'i18next';
import { ChartCard } from '@/components/charts/ChartCard';
import {
  CareerTimeline,
  type CareerTimelineLabels,
  type CareerTimelineReadout,
  type CareerTimelineReadoutTarget,
  type CareerTimelineSelection,
} from '@/components/charts/CareerTimeline';
import { GlickoExplainer } from '@/components/GlickoExplainer';
import { formatPercent } from '@/lib/formatPercent';

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
  /** A period / month was clicked, Entered or tapped twice — the page writes it as the `from` / `to` drill (UI-SPEC §10.3). */
  onSelectPeriod?: (selection: CareerTimelineSelection) => void;
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

/** Below this many points away from the all-time rate a period reads "level" (plan 39.1-35 planner decision 1). */
const LEVEL_DELTA_POINTS = 0.5;

/** `week:2024-W31` -> year and ISO week number. */
const ISO_WEEK_LABEL = /^(\d{4})-W(\d{1,2})$/;

/**
 * A period's title from its engine key and start (UI-SPEC §10.2 "Title —
 * entity or period"): calendar grains in UTC (the engine's one calendar
 * rule), a session by its LOCAL date (WR-02).
 */
function periodTitle(input: {
  key: string;
  startMs: number;
  t: TFunction;
  locale: string;
}): string {
  const { key, startMs, t, locale } = input;
  const colon = key.indexOf(':');
  const grain = colon >= 0 ? key.slice(0, colon) : key;
  const label = colon >= 0 ? key.slice(colon + 1) : key;
  const start = new Date(startMs);
  switch (grain) {
    case 'session':
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(start);
    case 'week': {
      const match = ISO_WEEK_LABEL.exec(label);
      return match
        ? t('analytics.timeline.period.week', { year: match[1], week: Number(match[2]) })
        : label;
    }
    case 'month':
      return new Intl.DateTimeFormat(locale, {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(start);
    case 'quarter':
      return t('analytics.timeline.period.quarter', {
        year: start.getUTCFullYear(),
        quarter: Math.floor(start.getUTCMonth() / 3) + 1,
      });
    case 'year':
      return new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }).format(start);
    default:
      return label;
  }
}

/**
 * The one readout (plan 39.1-35 planner decision 1, UI-SPEC §10.2 value
 * leads): title; the rating (or, on a strip cell, the rating in force at its
 * period's close); the record; then the points vs the account's own all-time
 * rate — or, under the medium tier's 8 games, the honest reason instead (no
 * direction is asserted, D-07); a capped cell adds its cap. Every line is one
 * whole-sentence key.
 */
function buildReadout(input: {
  target: CareerTimelineReadoutTarget;
  t: TFunction;
  locale: string;
  baselineRate: number;
  pointsByKey: ReadonlyMap<string, CareerRatingPoint>;
}): CareerTimelineReadout {
  const { target, t, locale, baselineRate, pointsByKey } = input;
  const baseline = formatPercent(baselineRate, locale);
  const pointsFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const record = (wins: number, losses: number, total: number) =>
    t('analytics.timeline.readout.record', {
      count: total,
      wins,
      losses,
      rate: formatPercent(total > 0 ? wins / total : 0, locale),
    });
  const delta = (deltaPoints: number) => {
    if (Math.abs(deltaPoints) < LEVEL_DELTA_POINTS) {
      return t('analytics.timeline.readout.delta.level', { baseline });
    }
    const points = pointsFormat.format(Math.abs(deltaPoints));
    return deltaPoints > 0
      ? t('analytics.timeline.readout.delta.above', { points, baseline })
      : t('analytics.timeline.readout.delta.below', { points, baseline });
  };
  const noStep = (total: number) =>
    t('analytics.timeline.readout.noStep', { count: total, floor: TREND_MIN_RECENT_GAMES });

  if (target.kind === 'point') {
    const { point } = target;
    const lines = [
      t('analytics.timeline.readout.rating', { rating: point.rating, rd: point.rd }),
      record(point.wins, point.losses, point.total),
    ];
    if (point.total < TREND_MIN_RECENT_GAMES) {
      lines.push(noStep(point.total));
    } else {
      const rate = point.wins / point.total;
      lines.push(delta(Math.round((rate - baselineRate) * 1000) / 10));
    }
    return { title: periodTitle({ key: point.key, startMs: point.startMs, t, locale }), lines };
  }

  const { cell } = target;
  const lines: string[] = [];
  const inForce = cell.ratingAtClose;
  if (inForce) {
    const closePoint = pointsByKey.get(inForce.key);
    const period = closePoint
      ? periodTitle({ key: closePoint.key, startMs: closePoint.startMs, t, locale })
      : inForce.label;
    lines.push(
      t('analytics.timeline.readout.ratingAtClose', {
        period,
        rating: inForce.rating,
        rd: inForce.rd,
      }),
    );
  }
  lines.push(record(cell.wins, cell.losses, cell.total));
  if (cell.rateStepReason === 'belowFloor') {
    lines.push(noStep(cell.total));
  } else {
    lines.push(delta(cell.deltaPoints));
    if (cell.rateStepReason === 'capped') {
      lines.push(t('analytics.timeline.readout.capped', { cap: SUGGESTION_MIN_GAMES }));
    }
  }
  return { title: periodTitle({ key: cell.key, startMs: cell.startMs, t, locale }), lines };
}

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
export function CareerTimelineCard({
  matches,
  horizon,
  chartWidth,
  onSelectPeriod,
}: CareerTimelineCardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  // React Compiler forbids a bare `Date.now()` in render — the lazy
  // `useState` initializer is the established one-time read (TrendsHero).
  const [nowMs] = useState(() => Date.now());
  const timeline = useMemo(
    () => buildCareerTimeline({ matches, horizon, nowMs }),
    [matches, horizon, nowMs],
  );

  const { rating } = timeline;
  const current = rating.current;
  const pointsByKey = useMemo(
    () => new Map(rating.points.map((point) => [point.key, point])),
    [rating.points],
  );
  const baselineRate = timeline.baseline.rate;
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
      readout: (target: CareerTimelineReadoutTarget) =>
        buildReadout({ target, t, locale, baselineRate, pointsByKey }),
    }),
    [
      t,
      rating.points.length,
      current,
      timeline.gamesNeeded,
      horizon,
      locale,
      baselineRate,
      pointsByKey,
    ],
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
      <CareerTimeline
        timeline={timeline}
        labels={labels}
        width={chartWidth}
        onSelectPeriod={onSelectPeriod}
      />
    </ChartCard>
  );
}

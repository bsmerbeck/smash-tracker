import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CAREER_TIMELINE_MIN_GAMES,
  SUGGESTION_MIN_GAMES,
  TIER_LEVEL,
  TREND_MIN_RECENT_GAMES,
  buildCareerTimeline,
  calendarBucketBounds,
  resolveWindow,
  selectTimelineEventMarkers,
  type CareerRatingGrain,
  type CareerRatingPoint,
  type HorizonKey,
  type Match,
  type ResolvedTierEntry,
  type TimelineEventCandidate,
  type TournamentEntry,
} from '@smash-tracker/shared';
import type { TFunction } from 'i18next';
import { ChartCard } from '@/components/charts/ChartCard';
import {
  CareerTimeline,
  type CareerTimelineEventMarker,
  type CareerTimelineLabels,
  type CareerTimelineMonthRecord,
  type CareerTimelineReadout,
  type CareerTimelineReadoutTarget,
  type CareerTimelineSelection,
} from '@/components/charts/CareerTimeline';
import { FormStrip } from '@/components/charts/FormStrip';
import { GlickoExplainer } from '@/components/GlickoExplainer';
import { tierProvenanceKey } from '@/components/analytics/tier/tierProvenance';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { entryDisplayDateRange } from '@/lib/historicalTournament';
import { formatPercent } from '@/lib/formatPercent';
import {
  FORM_STRIP_EMPTY_WINDOW,
  buildFormStripEvents,
  formStripLabels,
} from '@/lib/formStripEvents';

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
  /**
   * Plan 39.1-42 test affordance (the kit's `availableWidthPx`): an explicit
   * thin-strip width in px, so the strip's width fit runs under jsdom.
   * Omitted at runtime — the strip measures itself.
   */
  stripWidthPx?: number;
  /** A period / month was clicked, Entered or tapped twice — the page writes it as the `from` / `to` drill (UI-SPEC §10.3). */
  onSelectPeriod?: (selection: CareerTimelineSelection) => void;
  /** A thin account's form-strip set was clicked — the page writes it as the `event` drill axis. */
  onSelectSet?: (setKey: string) => void;
  /**
   * Plan 41-04 (B2): the page's ONE `resolveEntryTiers(allEntries, allOwnAccountMatches)` result
   * (the 39.2 resolve-once rule — never a filtered subset). Omitted -> no diamonds.
   */
  resolvedEntries?: ResolvedTierEntry[];
  /** An event diamond was clicked or activated — the page writes `event=<entryKey>`. */
  onSelectEventMarker?: (entryKey: string) => void;
}

const NO_RESOLVED_ENTRIES: ResolvedTierEntry[] = [];

/** Plan 41-04 (DD-41-08): only events at or above a major are marked on the career timeline. */
const EVENT_MARKER_MIN_LEVEL = TIER_LEVEL.major;

/**
 * Plan 41-04 (B2, DD-41-08): the career timeline's diamonds are views of the page's resolved tier
 * entries. A marker's x is the entry's display end (else its latest assigned match; an entry with
 * neither is skipped); markers outside the timeline's domain are dropped; `ratingAfter` is the
 * first plotted rating point at or after the event, so the readout equals a visible point.
 *
 * 41-REVIEW CR-01 (door/terminus same-n): a diamond is a door to the `#games` list, which lists the
 * page's filtered games only. So an entry is marked only when at least one of its assigned games is
 * in `visibleMatches` (the page's range- and source-filtered set), and its W-L counts exactly those
 * games — the readout's n is the list's n.
 */
function buildEventCandidates(input: {
  resolvedEntries: readonly ResolvedTierEntry[];
  visibleMatches: readonly Match[];
  timeline: ReturnType<typeof buildCareerTimeline>;
}): TimelineEventCandidate[] {
  const { resolvedEntries, visibleMatches, timeline } = input;
  const visibleIds = new Set(visibleMatches.map((match) => match.id));
  const { domain } = timeline;
  if (!domain) {
    return [];
  }
  const candidates: TimelineEventCandidate[] = [];
  for (const resolved of resolvedEntries) {
    const { tier } = resolved.resolution;
    if (tier === 'unknown') {
      continue;
    }
    const own = resolved.matches.filter((match) => visibleIds.has(match.id));
    if (own.length === 0) {
      // No listable games behind it: the door would open an empty `#games` list.
      continue;
    }
    // The resolved entry is the registry row at runtime (`resolveEntryTiers` maps the page's entries).
    const range = entryDisplayDateRange(resolved.entry as TournamentEntry);
    const latestMatchMs = own.reduce((max, match) => Math.max(max, match.time), 0);
    const atMs = range?.endMs ?? (latestMatchMs > 0 ? latestMatchMs : null);
    if (atMs === null || atMs < domain.startMs || atMs > domain.endMs) {
      continue;
    }
    const wins = own.filter((match) => match.win).length;
    const ratingPoint = timeline.rating.points.find((point) => point.closeMs >= atMs);
    candidates.push({
      key: resolved.entryKey,
      label: resolved.entry.tournamentName ?? resolved.entry.eventName,
      atMs,
      wins,
      losses: own.length - wins,
      tier,
      basis: resolved.resolution.basis,
      level: TIER_LEVEL[tier],
      entrants: resolved.resolution.entrants,
      ratingAfter: ratingPoint ? ratingPoint.rating : null,
    });
  }
  return candidates;
}

/** Sketch 002-C legend swatch: an 11px diamond, filled or hollow like the drawn marker. */
function DiamondSwatch({ hollow }: { hollow: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="11"
      height="11"
      viewBox="0 0 11 11"
      className="mr-1 inline-block align-[-1px]"
      data-slot="career-timeline-legend-swatch"
      data-hollow={hollow ? 'true' : 'false'}
    >
      <path
        d="M5.5 0.75 10.25 5.5 5.5 10.25 0.75 5.5Z"
        fill={hollow ? CHART_TOKENS.surface : CHART_TOKENS.deemphasis}
        stroke={hollow ? CHART_TOKENS.deemphasis : CHART_TOKENS.surface}
        strokeWidth="1.5"
      />
    </svg>
  );
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

/** UI-SPEC §7.10: the thin account's per-game strip draws at most this many games. */
const THIN_STRIP_LIMIT = 60;

/**
 * The table twin's year x month records, binned by the engine's ONE UTC
 * calendar rule (`calendarBucketBounds`) — the kit chart never bins.
 */
function monthRecordsOf(matches: Match[]): CareerTimelineMonthRecord[] {
  const byStart = new Map<number, CareerTimelineMonthRecord>();
  for (const match of matches) {
    const { startMs } = calendarBucketBounds('month', match.time);
    let record = byStart.get(startMs);
    if (!record) {
      const start = new Date(startMs);
      record = {
        year: start.getUTCFullYear(),
        month: start.getUTCMonth(),
        wins: 0,
        losses: 0,
        total: 0,
      };
      byStart.set(startMs, record);
    }
    if (match.win) record.wins += 1;
    else record.losses += 1;
    record.total += 1;
  }
  return [...byStart.values()];
}

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
  /** Plan 41-04: each event marker's already-localised provenance sentence (null when it has none). */
  eventProvenance: ReadonlyMap<string, string | null>;
}): CareerTimelineReadout {
  const { target, t, locale, baselineRate, pointsByKey, eventProvenance } = input;
  const baseline = formatPercent(baselineRate, locale);
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
    // Sketch 002-C precision: whole points, one decimal only below 1 pt.
    const points = new Intl.NumberFormat(locale, {
      maximumFractionDigits: Math.abs(deltaPoints) < 1 ? 1 : 0,
    }).format(Math.abs(deltaPoints));
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

  if (target.kind === 'event') {
    // Parent §10.2 order: name (title) · tier line · rating after (omitted when none) · W-L · estimate caveat.
    const { marker } = target;
    const tier = t(`tiers.label.${marker.tier}`);
    const basis = eventProvenance.get(marker.key);
    const lines = [basis ? t('analytics.timeline.event.tierLine', { tier, basis }) : tier];
    if (marker.ratingAfter !== null) {
      lines.push(t('analytics.timeline.event.ratingAfter', { rating: marker.ratingAfter }));
    }
    lines.push(record(marker.wins, marker.losses, marker.wins + marker.losses));
    if (marker.basis === 'estimated') {
      lines.push(t('tiers.tooltip.estimateCaveat'));
    }
    return { title: marker.label, lines };
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
  stripWidthPx,
  onSelectPeriod,
  onSelectSet,
  resolvedEntries = NO_RESOLVED_ENTRIES,
  onSelectEventMarker,
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

  // Plan 41-04 (B2): the diamonds, memoised on the resolved entries and the timeline. The selector caps
  // them (DD-41-09); `total` counts every placeable major+ event, so the caption can say what is thinned.
  // A locked timeline draws no chart, so it marks no event either.
  const eventsDrawable = timeline.state !== 'locked' && rating.points.length > 0;
  const eventSelection = useMemo(
    () =>
      selectTimelineEventMarkers(
        eventsDrawable
          ? buildEventCandidates({ resolvedEntries, visibleMatches: matches, timeline })
          : [],
        { minLevel: EVENT_MARKER_MIN_LEVEL },
      ),
    [eventsDrawable, resolvedEntries, matches, timeline],
  );
  const eventMarkers: CareerTimelineEventMarker[] = useMemo(
    () =>
      eventSelection.markers.map((marker) => ({
        key: marker.key,
        label: marker.label,
        atMs: marker.atMs,
        wins: marker.wins,
        losses: marker.losses,
        tier: marker.tier,
        basis: marker.basis,
        ratingAfter: marker.ratingAfter,
      })),
    [eventSelection.markers],
  );
  const eventProvenance = useMemo(() => {
    const byKey = new Map<string, string | null>();
    const resolvedByKey = new Map(resolvedEntries.map((item) => [item.entryKey, item]));
    for (const marker of eventSelection.markers) {
      const resolved = resolvedByKey.get(marker.key);
      const message = resolved ? tierProvenanceKey(resolved.resolution, locale) : null;
      byKey.set(marker.key, message ? t(message.key, message.values) : null);
    }
    return byKey;
  }, [eventSelection.markers, resolvedEntries, locale, t]);
  const estimatedMarkerCount = eventMarkers.filter((marker) => marker.basis === 'estimated').length;

  const labels: CareerTimelineLabels = useMemo(
    () => ({
      rate: t('analytics.timeline.strip.rate'),
      games: t('analytics.timeline.strip.games'),
      aria: t('analytics.timeline.aria', {
        count: rating.points.length,
        rating: current?.rating ?? 0,
        rd: current?.rd ?? 0,
      }),
      locked: t('analytics.timeline.locked', { count: timeline.gamesNeeded }),
      lockedCount: t('analytics.timeline.lockedCount', {
        have: Math.max(0, CAREER_TIMELINE_MIN_GAMES - timeline.gamesNeeded),
        need: CAREER_TIMELINE_MIN_GAMES,
      }),
      value: (value: number) => t('analytics.timeline.label.value', { rating: value }),
      rd: (rd: number) => t('analytics.timeline.label.rd', { rd }),
      peakClose: (value: number) => t('analytics.timeline.label.peakClose', { rating: value }),
      lowClose: (value: number) => t('analytics.timeline.label.lowClose', { rating: value }),
      peak: (value: number) => t('analytics.timeline.label.peak', { rating: value }),
      low: (value: number) => t('analytics.timeline.label.low', { rating: value }),
      band: t(`insights.horizon.${horizon}`),
      readout: (target: CareerTimelineReadoutTarget) =>
        buildReadout({ target, t, locale, baselineRate, pointsByKey, eventProvenance }),
      eventAria: (marker) => {
        // The estimate wording travels in the aria-label (12.6): a hollow mark is never the only cue.
        const estimated = marker.basis === 'estimated';
        const form = `analytics.timeline.event.${
          estimated
            ? marker.ratingAfter === null
              ? 'ariaEstimatedNoRating'
              : 'ariaEstimated'
            : marker.ratingAfter === null
              ? 'ariaNoRating'
              : 'aria'
        }`;
        return t(form, {
          event: marker.label,
          tier: t(`tiers.label.${marker.tier}`),
          rating: marker.ratingAfter ?? undefined,
          wins: marker.wins,
          losses: marker.losses,
        });
      },
      table: {
        toggle: t('analytics.trend.tableToggle'),
        ratingCaption: t('analytics.timeline.table.ratingCaption'),
        monthCaption: t('analytics.timeline.table.monthCaption'),
        headers: {
          period: t('analytics.timeline.table.headers.period'),
          rating: t('analytics.timeline.table.headers.rating'),
          rd: t('analytics.timeline.table.headers.rd'),
          record: t('analytics.timeline.table.headers.record'),
          rate: t('analytics.timeline.table.headers.rate'),
          games: t('analytics.timeline.table.headers.games'),
          year: t('analytics.timeline.table.headers.year'),
          total: t('analytics.timeline.table.headers.total'),
        },
        months: Array.from({ length: 12 }, (_, month) =>
          new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(
            Date.UTC(2000, month, 1),
          ),
        ),
        period: (point: CareerRatingPoint) =>
          periodTitle({ key: point.key, startMs: point.startMs, t, locale }),
        rd: (rd: number) => t('analytics.timeline.label.rd', { rd }),
        record: (wins: number, losses: number) => `${wins}–${losses}`,
        rate: (rate: number) => formatPercent(rate, locale),
        monthCell: ({ rate, total }: { rate: number; total: number }) =>
          t('analytics.timeline.table.monthCell', {
            rate: formatPercent(rate, locale),
            games: total,
          }),
        yearTotal: ({ wins, losses, rate }: { wins: number; losses: number; rate: number }) =>
          t('analytics.timeline.table.yearTotal', {
            wins,
            losses,
            rate: formatPercent(rate, locale),
          }),
      },
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
      eventProvenance,
    ],
  );

  const monthRecords = useMemo(() => monthRecordsOf(matches), [matches]);
  // D-07 / sketch 002-C: a thin account's per-game grain replaces the month
  // strips — the SAME builder every other FormStrip host uses, with the
  // timeline's own recent window (one source of truth for "recent").
  const recentWindow = timeline.recentWindow;
  // Plan 39.1-42 (UI-SPEC §7.10, sketch 002-C): the timeline has no recent
  // window when the horizon is empty OR collapses — the strip tells them
  // apart: an empty horizon dims every tick and names itself; collapsed
  // horizons dim nothing ("Whole record shown").
  const stripWindow = useMemo(() => {
    if (timeline.state !== 'thin') {
      return null;
    }
    if (recentWindow) {
      return {
        range: { fromMs: recentWindow.fromMs ?? null, toMs: recentWindow.toMs ?? null },
        note: t(`analytics.strip.windowHighlighted.${horizon}`),
      };
    }
    const empty = resolveWindow({ matches, horizon, scoped: false, nowMs }).window.games === 0;
    return empty
      ? { range: FORM_STRIP_EMPTY_WINDOW, note: t(`analytics.strip.windowEmpty.${horizon}`) }
      : { range: { fromMs: null, toMs: null }, note: t('analytics.strip.windowAll') };
  }, [timeline.state, recentWindow, matches, horizon, nowMs, t]);
  const thinEvents = useMemo(
    () => (stripWindow ? buildFormStripEvents(matches, stripWindow.range, t, locale) : []),
    [stripWindow, matches, t, locale],
  );
  const thinStrip =
    timeline.state === 'thin' ? (
      <FormStrip
        events={thinEvents}
        limit={THIN_STRIP_LIMIT}
        labels={{
          ...formStripLabels(t),
          // WR-03: names the games actually DRAWN of the total (kit-computed).
          summary: ({ shown, total }) => t('analytics.strip.aria', { count: total, shown }),
          empty: <span>{t('analytics.strip.empty')}</span>,
          // Planner decision 7 / plan 39.1-42: "All N games" is the kit head's
          // title only when every game is drawn — otherwise no head, and the
          // foot's shown-of-total line says what is.
          title: ({ shown, total }) =>
            shown === total ? t('analytics.timeline.thin.overline', { count: total }) : undefined,
          // The strip dims by the timeline's recent window; the note names it.
          windowNote: stripWindow?.note,
        }}
        availableWidthPx={stripWidthPx}
        onSelectSet={onSelectSet}
      />
    ) : undefined;

  const unlocked = timeline.state !== 'locked' && rating.points.length > 0;
  const captionItems: { key: string; text: string; swatch?: 'filled' | 'hollow' }[] = [];
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
    // Plan 41-04 (DD-41-08/09): the diamonds' legend. Nothing drawn -> no legend item at all (E8 empty).
    if (eventMarkers.length > 0) {
      captionItems.push({
        key: 'events',
        text: t('analytics.timeline.event.legend', { count: eventMarkers.length }),
        swatch: 'filled',
      });
      if (estimatedMarkerCount > 0) {
        captionItems.push({
          key: 'eventsEstimated',
          text: t('analytics.timeline.event.legendEstimated'),
          swatch: 'hollow',
        });
      }
      if (eventSelection.shown < eventSelection.total) {
        captionItems.push({
          key: 'eventsShownOf',
          text: t('analytics.timeline.event.shownOf', {
            shown: eventSelection.shown,
            total: eventSelection.total,
          }),
        });
      }
    }
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
                {item.swatch && <DiamondSwatch hollow={item.swatch === 'hollow'} />}
                {item.text}
              </span>
            ))}
          </p>
        ) : undefined
      }
    >
      {/*
        Major-event diamonds (plan 41-04, B2): the page's resolved tier entries at or above a major,
        capped at 40, estimated tiers hollow. Which events qualify is the 39.2 resolver's call — no
        name-matched list ships (owner decision 2026-09-25).
      */}
      <CareerTimeline
        timeline={timeline}
        labels={labels}
        width={chartWidth}
        onSelectPeriod={onSelectPeriod}
        eventMarkers={eventMarkers}
        onSelectEventMarker={onSelectEventMarker}
        thinStrip={thinStrip}
        monthRecords={monthRecords}
      />
    </ChartCard>
  );
}

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { classify, confidenceTierFor, resolveWindow, toRateValue } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { WinLossPips } from '@/components/WinLossPips';
import { GlickoExplainer } from '@/components/GlickoExplainer';
import {
  getLastNMatches,
  getOnlineOfflineSplit,
  getStreakSummary,
  getWinLossRecord,
  type WinLossRecord,
} from '@/lib/stats';
import { computeRatingHistory } from '@/lib/glicko';
import { filterBySource } from '@/hooks/useFilteredMatches';
import { DEFAULT_HORIZON } from '@/hooks/useHorizon';
import { GridCell } from '@/components/analytics/PageGrid';
import { StatFigure, StatRow } from '@/components/analytics/StatRow';
import { Record } from '@/components/analytics/Record';
import { DeltaChip } from '@/components/analytics/DeltaChip';
import { deltaChipView } from '@/components/analytics/deltaChipView';
import {
  TILE_CARD_CLASS,
  TILE_CONTENT_CLASS,
  TILE_HEADER_CLASS,
} from '@/components/analytics/cardDensity';

/**
 * Dashboard hero tiles: 4-up at xl, 2x2 at lg (3-span tiles are ~170px wide at
 * 1024 — too narrow for a split StatRow). `cn`/twMerge drops `GridCell`'s own
 * `lg:col-span-3`; `data-span` stays `"3"` (the content class is "stat tile").
 */
export const HERO_TILE_CLASS = 'lg:col-span-6 xl:col-span-3';

/** Recent-form pips shown in the Form tile. */
const FORM_PIP_LIMIT = 10;

/**
 * Account-wide hero: overall record, rating, recent form, the selected
 * fighter's record, casual-vs-competitive and online/offline. Unlike the
 * fighter-scoped widgets below it on the dashboard, every card here except
 * the injected `fighterTile` is computed across ALL of the user's fighters
 * (docs/analytics-vision.md Phase C).
 *
 * Plan 39.1-17 (INS-02/DD-03): the overall-record card is a win rate lead
 * with a recent-vs-baseline delta chip under the page's ONE horizon switch,
 * both horizon figures resolved through the engine (`resolveWindow` /
 * `toRateValue` / `classify`), never a component-side window computation.
 *
 * Quick 261002-leg (DESIGN §2): returns a FRAGMENT of FOUR `GridCell
 * span={3}` cells — no wrapping `<div>` grid — so `DashboardPage.tsx`'s single
 * `PageGrid` places them directly. Stack A is Overall Record over Rating;
 * stack B is Form over `fighterTile`; then Casual vs Competitive and Online vs
 * Offline. Each cell carries `HERO_TILE_CLASS`, so the hero is one row of four
 * at xl, a 2x2 at lg (stacks on row 1, split tiles on row 2), and one column
 * below lg. This SUPERSEDES UI-SPEC §8.7's five-tile placement table.
 * `PageGrid`'s hardcoded `items-start` never stretches a tile; stacks are
 * `flex flex-col gap-4`, so nothing in a stack is stretched either.
 */
export function HeroStats({
  matches,
  timeFilteredMatches,
  horizon = DEFAULT_HORIZON,
  fighterTile,
  sourceFilterActive = false,
}: {
  /** Matches with the full global filter (source + time range) applied. */
  matches: Match[];
  /** Matches with only the time-range filter applied — used by the casual/competitive split so it can show both buckets regardless of the active source filter. */
  timeFilteredMatches: Match[];
  /**
   * The page's ONE `HorizonSwitch` value (`useHorizon`). Optional with a
   * `DEFAULT_HORIZON` fallback so this component stays independently
   * renderable/testable before its host page wires a real value through —
   * `DashboardPage.tsx`'s own `useHorizon()` call is the eventual source.
   */
  horizon?: HorizonKey;
  /** The selected fighter's record tile (`WinLossTracker`); rendered under Form in stack B. Absent in unit tests and on surfaces with no fighter context. */
  fighterTile?: ReactNode;
  /** True when the global SOURCE filter is not 'all' — shows the Casual vs Competitive caveat footnote. */
  sourceFilterActive?: boolean;
}) {
  return (
    <>
      <GridCell span={3} stack className={HERO_TILE_CLASS}>
        <OverallRecordCard matches={matches} horizon={horizon} />
        <RatingCard matches={matches} />
      </GridCell>
      <GridCell span={3} stack className={HERO_TILE_CLASS}>
        <FormCard matches={matches} />
        {fighterTile}
      </GridCell>
      <GridCell span={3} className={HERO_TILE_CLASS}>
        <CasualVsCompetitiveCard
          matches={timeFilteredMatches}
          sourceFilterActive={sourceFilterActive}
        />
      </GridCell>
      <GridCell span={3} className={HERO_TILE_CLASS}>
        <OnlineOfflineCard matches={matches} />
      </GridCell>
    </>
  );
}

function OverallRecordCard({ matches, horizon }: { matches: Match[]; horizon: HorizonKey }) {
  const { t } = useTranslation();
  return (
    <HorizonRecordCard
      matches={matches}
      horizon={horizon}
      label={t('dashboard.hero.overallRecord')}
    />
  );
}

/**
 * Plan 39.1-50 (OOS-12a, UI-SPEC §8.7): the Overall Record tile's body,
 * extracted unchanged so the Dashboard's per-fighter record tile renders the
 * SAME horizon figure path (`resolveWindow` / `toRateValue` / `classify` /
 * `deltaChipView`) under its own overline. `children` is a layout-neutral
 * slot inside the card (the fighter tile's hook).
 */
export function HorizonRecordCard({
  matches,
  horizon,
  label,
  children,
}: {
  matches: Match[];
  horizon: HorizonKey;
  label: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch, matching `FighterHero.tsx`'s own convention.
  const [nowMs] = useState(() => Date.now());
  const baseline = useMemo(() => toRateValue(matches), [matches]);
  const hasMatches = baseline.total > 0;
  const recentRate = useMemo(() => {
    const { matches: recentMatches } = resolveWindow({ matches, horizon, scoped: true, nowMs });
    return toRateValue(recentMatches);
  }, [matches, horizon, nowMs]);
  const { state, deltaPoints } = classify({
    recent: recentRate,
    baseline,
    scoped: true,
    hasAction: false,
  });
  // Plan 39.1-36 (INS-04, UI-SPEC §7.5): the one ladder-to-chip mapping. The
  // "Overall Record" overline does not name the horizon, so the chip carries
  // its own ("Steady · last 30", "no games · last 30").
  const chipView = deltaChipView({
    state,
    deltaPoints,
    recentGames: recentRate.total,
    horizon,
    horizonOwnedByParent: false,
    t,
  });
  const allTimeTier = confidenceTierFor(baseline.total);

  return (
    <Card className={TILE_CARD_CLASS}>
      <CardContent className={TILE_CONTENT_CLASS}>
        {children}
        {hasMatches ? (
          <StatFigure
            label={label}
            value={`${Math.round(baseline.rate * 100)}%`}
            lead
            support={
              <Record
                wins={baseline.wins}
                losses={baseline.losses}
                cueLabel={
                  allTimeTier
                    ? t(`shared.evidence.sampleCueGlyph.${allTimeTier}`, { count: baseline.total })
                    : undefined
                }
              />
            }
            delta={
              chipView === null ? null : (
                <DeltaChip
                  {...chipView}
                  ariaLabel={t('analytics.dumbbell.rowAria', {
                    label,
                    recentRecord: `${recentRate.wins}–${recentRate.losses}`,
                    baselineRecord: `${baseline.wins}–${baseline.losses}`,
                  })}
                />
              )
            }
          />
        ) : (
          // Plan 39.1-50: the empty tile still names itself (the kit's
          // StatFigure empty state — overline, em dash, caption), so the
          // Overall and the fighter tiles never read as one untitled line.
          <StatFigure label={label} lead state="empty" emptyCaption={t('common.noMatchData')} />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Quick 261002-leg (DESIGN §3.1): the Form tile is built on the stat idiom
 * (overline / figure / meta) so it is the same tile shape as its stack-mate.
 * The pips are the figure, the streak chip is its delta, and the visible
 * "Last N results" line is the sighted twin of the pips' own aria-label.
 */
function FormCard({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const { currentStreak, currentStreakIsWin } = getStreakSummary(matches);
  const hasMatches = matches.length > 0;
  const recentCount = getLastNMatches(matches, FORM_PIP_LIMIT).length;
  const label = t('dashboard.hero.form');

  return (
    <Card className={TILE_CARD_CLASS}>
      <CardContent className={TILE_CONTENT_CLASS}>
        {hasMatches ? (
          <StatFigure
            label={label}
            value={<WinLossPips matches={matches} limit={FORM_PIP_LIMIT} />}
            support={t('shared.pips.recentResults', { count: recentCount })}
            delta={
              <span
                className={`w-fit rounded-full px-2 py-0.5 text-sm font-semibold ${
                  currentStreakIsWin
                    ? 'bg-emerald-500/15 text-emerald-500'
                    : 'bg-destructive/15 text-destructive'
                }`}
              >
                {currentStreakIsWin
                  ? t('dashboard.hero.streakWin', { count: currentStreak })
                  : t('dashboard.hero.streakLoss', { count: currentStreak })}
              </span>
            }
          />
        ) : (
          <StatFigure label={label} state="empty" emptyCaption={t('shared.pips.empty')} />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Casual (manual) vs competitive (start.gg) win-rate side by side. Computes
 * from `matches` ignoring the global SOURCE filter — callers pass
 * `timeFilteredMatches` so the time range still applies but the source
 * split isn't collapsed by it.
 */
function CasualVsCompetitiveCard({
  matches,
  sourceFilterActive,
}: {
  matches: Match[];
  sourceFilterActive: boolean;
}) {
  const { t } = useTranslation();
  const casual = getWinLossRecord(filterBySource(matches, 'manual'));
  const competitive = getWinLossRecord(filterBySource(matches, 'startgg'));
  const bothHaveData = casual.total > 0 && competitive.total > 0;
  const delta = bothHaveData ? competitive.winRate - casual.winRate : null;

  return (
    <Card className={TILE_CARD_CLASS}>
      <CardHeader className={TILE_HEADER_CLASS}>
        <CardTitle>{t('dashboard.hero.casualVsCompetitive')}</CardTitle>
      </CardHeader>
      <CardContent className={cn(TILE_CONTENT_CLASS, 'flex flex-col gap-2')}>
        {/* Plan 39.1-39 (UI-SPEC §7.3): the one stat idiom — one StatRow,
            never a hand-rolled two-column grid; each record wraps whole. */}
        <StatRow
          figures={[
            <SplitStat key="casual" label={t('common.casual')} record={casual} />,
            <SplitStat key="competitive" label={t('common.competitive')} record={competitive} />,
          ]}
        />
        {bothHaveData && delta != null && (
          <p className="text-sm">
            <span className="text-muted-foreground">{t('dashboard.hero.deltaLabel')} </span>
            <span
              className={`font-semibold ${delta >= 0 ? 'text-emerald-500' : 'text-destructive'}`}
            >
              {t('dashboard.hero.deltaValue', { value: `${delta >= 0 ? '+' : ''}${delta}` })}
            </span>
            <span className="text-muted-foreground"> {t('dashboard.hero.deltaCaption')}</span>
          </p>
        )}
        {/* Quick 261002-leg: the caveat explains why this tile may disagree
            with the active source filter, so it only renders while one is on. */}
        {sourceFilterActive && (
          <p className="text-xs leading-4 text-muted-foreground">
            {t('dashboard.hero.ignoresSourceFilter')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Plan 39.1-17 (UIX-04): the split's label/value/record now go through the
 * ONE stat idiom (`StatFigure`, `overline` role label) rather than a
 * page-local `<h3>` + bare hyphenated string — the record's own W-L segment
 * previously used a plain hyphen (`{wins}-{losses}`); the `Record` primitive
 * renders the one en-dash format everywhere (UIX-04).
 */
function SplitStat({ label, record }: { label: string; record: WinLossRecord }) {
  const { t } = useTranslation();
  if (record.total === 0) {
    return <StatFigure label={label} state="empty" emptyCaption={t('dashboard.hero.noData')} />;
  }
  return (
    <StatFigure
      label={label}
      value={`${record.winRate}%`}
      support={<Record wins={record.wins} losses={record.losses} cue="none" wrap />}
    />
  );
}

function OnlineOfflineCard({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const { online, offline } = getOnlineOfflineSplit(matches);
  const hasAny = online.total > 0 || offline.total > 0;

  return (
    <Card className={TILE_CARD_CLASS}>
      <CardHeader className={TILE_HEADER_CLASS}>
        <CardTitle>{t('dashboard.hero.onlineVsOffline')}</CardTitle>
      </CardHeader>
      <CardContent className={TILE_CONTENT_CLASS}>
        {hasAny ? (
          <StatRow
            figures={[
              <SplitStat key="online" label={t('dashboard.hero.online')} record={online} />,
              <SplitStat key="offline" label={t('dashboard.hero.offline')} record={offline} />,
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Minimum total games (across the filtered set) before the rating card shows a number instead of the locked state. */
const RATING_UNLOCK_THRESHOLD = 5;

/**
 * Session-based Glicko-2 rating card. Computed over the same filtered
 * `matches` the rest of the hero uses, so it stays consistent with the
 * active source/time-range filters — cheap to recompute client-side per
 * render given typical match volumes.
 *
 * Quick 261002-leg (DESIGN §3.1): the same overline / figure / meta tile
 * shape as Overall Record. It composes `StatFigure`'s class literals inline
 * (via `RatingOverline`) because the label row carries the explainer
 * trigger and the locked state needs that row without an em-dash figure.
 */
function RatingCard({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const hasEnoughGames = matches.length >= RATING_UNLOCK_THRESHOLD;
  const { periods, current } = computeRatingHistory(matches);

  return (
    <Card className={TILE_CARD_CLASS}>
      <CardContent className={cn(TILE_CONTENT_CLASS, 'flex min-w-0 flex-col items-start gap-1')}>
        <RatingOverline />
        {hasEnoughGames && current ? (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[1.75rem] leading-8 font-semibold tracking-tight tabular-nums">
                {current.rating}
              </span>
              <span className="text-sm leading-5 font-medium text-muted-foreground">
                &plusmn;{current.rd}
              </span>
              <RatingTrendArrow periods={periods} />
            </div>
            {/* Two separate spans, never a joined string (§13.8). */}
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs leading-4 text-muted-foreground tabular-nums">
              <span>{t('dashboard.hero.gamesSampled', { count: matches.length })}</span>
              <span>{t('dashboard.hero.ratingCaption')}</span>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground">
              {t('dashboard.hero.ratingLocked', { threshold: RATING_UNLOCK_THRESHOLD })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('dashboard.hero.ratingProgress', {
                played: matches.length,
                threshold: RATING_UNLOCK_THRESHOLD,
              })}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The Rating tile's overline row: StatFigure's exact label classes, then the
 * Glicko explainer trigger. The trigger is a 24px `icon-xs` button, so it is
 * pulled out of the row's height with `-my-1` (its hit area is unchanged); the
 * row stays the 16px an overline row is, which is what DESIGN §3.1's tile
 * heights (Rating 114 / 132) assume.
 */
function RatingOverline() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase">
        {t('dashboard.hero.rating')}
      </span>
      <span className="-my-1 flex">
        <GlickoExplainer />
      </span>
    </div>
  );
}

/**
 * Small trend indicator comparing the two most recent rating periods
 * (sessions). Hidden when there's no prior period to compare against (a
 * single session played so far).
 */
function RatingTrendArrow({ periods }: { periods: { rating: number }[] }) {
  const { t } = useTranslation();
  if (periods.length < 2) {
    return null;
  }
  const latest = periods[periods.length - 1];
  const previous = periods[periods.length - 2];
  if (!latest || !previous) {
    return null;
  }
  const delta = latest.rating - previous.rating;
  if (delta === 0) {
    return (
      <span aria-label={t('dashboard.hero.ratingUnchanged')} className="text-muted-foreground">
        &rarr;
      </span>
    );
  }
  const isUp = delta > 0;
  return (
    <span
      aria-label={isUp ? t('dashboard.hero.ratingUp') : t('dashboard.hero.ratingDown')}
      className={isUp ? 'text-emerald-500' : 'text-destructive'}
    >
      {isUp ? '▲' : '▼'} {Math.abs(delta)}
    </span>
  );
}

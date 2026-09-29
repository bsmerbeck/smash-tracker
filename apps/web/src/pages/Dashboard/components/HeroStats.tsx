import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { classify, confidenceTierFor, resolveWindow, toRateValue } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WinLossPips } from '@/components/WinLossPips';
import { GlickoExplainer } from '@/components/GlickoExplainer';
import {
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

/**
 * Account-wide hero row: overall record, recent form, casual-vs-competitive
 * delta, online/offline split, and (session-based) Glicko-2 rating. Unlike
 * the fighter-scoped widgets below it on the dashboard, every card here is
 * computed across ALL of the user's fighters (docs/analytics-vision.md Phase
 * C).
 *
 * Plan 39.1-17 (INS-02/DD-03): the overall-record card is this phase's
 * hero-row scope — a win rate lead with a recent-vs-baseline delta chip
 * under the page's ONE horizon switch, both horizon figures resolved
 * through the engine (`resolveWindow`/`toRateValue`/`classify`), never a
 * component-side window computation.
 *
 * Plan 39.1-17 Task 3 (UI-SPEC §8.7 placement table): returns a FRAGMENT of
 * five `GridCell span={3}` cells — not its own wrapping `<div>` grid — so
 * `DashboardPage.tsx`'s single `PageGrid` places these five cells directly
 * (a fragment contributes no DOM wrapper, so `<HeroStats/>`'s five children
 * become real siblings of every "below the hero row" cell in that one grid).
 * At the widest breakpoint this is four tiles per row with the fifth
 * wrapping to a second row, left-aligned — `PageGrid`'s hardcoded
 * `items-start` never stretches it to a sibling's height. Not in this
 * task's own `<files>` sub-list (only the plan-level `files_modified`) —
 * recorded as a deviation: the fifth-tile-wraps contract Task 3 owns is
 * literally this component's OWN grid shape, unreachable without touching it.
 */
export function HeroStats({
  matches,
  timeFilteredMatches,
  horizon = DEFAULT_HORIZON,
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
}) {
  return (
    <>
      <GridCell span={3}>
        <OverallRecordCard matches={matches} horizon={horizon} />
      </GridCell>
      <GridCell span={3}>
        <FormCard matches={matches} />
      </GridCell>
      <GridCell span={3}>
        <CasualVsCompetitiveCard matches={timeFilteredMatches} />
      </GridCell>
      <GridCell span={3}>
        <OnlineOfflineCard matches={matches} />
      </GridCell>
      <GridCell span={3}>
        <RatingCard matches={matches} />
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
    <Card>
      <CardContent>
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

function FormCard({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const { currentStreak, currentStreakIsWin } = getStreakSummary(matches);
  const hasMatches = matches.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.hero.form')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <WinLossPips matches={matches} limit={10} />
        {hasMatches && (
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
function CasualVsCompetitiveCard({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const casual = getWinLossRecord(filterBySource(matches, 'manual'));
  const competitive = getWinLossRecord(filterBySource(matches, 'startgg'));
  const bothHaveData = casual.total > 0 && competitive.total > 0;
  const delta = bothHaveData ? competitive.winRate - casual.winRate : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.hero.casualVsCompetitive')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{t('dashboard.hero.ignoresSourceFilter')}</p>
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
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.hero.onlineVsOffline')}</CardTitle>
      </CardHeader>
      <CardContent>
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
 * `matches` the rest of the hero row uses, so it stays consistent with the
 * active source/time-range filters — cheap to recompute client-side per
 * render given typical match volumes.
 */
function RatingCard({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const hasEnoughGames = matches.length >= RATING_UNLOCK_THRESHOLD;
  const { periods, current } = computeRatingHistory(matches);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          {t('dashboard.hero.rating')}
          <GlickoExplainer />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {hasEnoughGames && current ? (
          <>
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold">
                {current.rating} <span className="text-lg font-normal">&plusmn;{current.rd}</span>
              </span>
              <RatingTrendArrow periods={periods} />
            </div>
            <p className="text-sm text-muted-foreground">
              {t('dashboard.hero.gamesSampled', { count: matches.length })}
            </p>
            <p className="text-xs text-muted-foreground">{t('dashboard.hero.ratingCaption')}</p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t('dashboard.hero.ratingLocked', { threshold: RATING_UNLOCK_THRESHOLD })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('dashboard.hero.ratingProgress', {
                played: matches.length,
                threshold: RATING_UNLOCK_THRESHOLD,
              })}
            </p>
          </>
        )}
      </CardContent>
    </Card>
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

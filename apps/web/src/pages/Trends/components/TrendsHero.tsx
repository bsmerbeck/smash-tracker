import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  classify,
  resolveWindow,
  toRateValue,
} from '@smash-tracker/shared';
import { Card, CardContent } from '@/components/ui/card';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { DeltaChip } from '@/components/analytics/DeltaChip';
import { deltaChipView } from '@/components/analytics/deltaChipView';
import { buildRatingMoveChipView } from '@/components/analytics/ratingMoveChip';
import { Record } from '@/components/analytics/Record';
import { getSessions } from '@/lib/stats';
import { computeRatingHistory } from '@/lib/glicko';
import { buildSessionsHeadline } from './SessionsAndTilt';
import { BEST_MONTH_MIN_GAMES, buildTrendsHero, formatMonthLabel } from '../lib/trendsHero';

function formatFullDate(timeMs: number, locale: string): string {
  return new Date(timeMs).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export interface TrendsHeroProps {
  matches: Match[];
  /** The page's ONE persisted horizon (`useHorizon`) — the lead win-rate figure and the rating figure's delta both read it. */
  horizon: HorizonKey;
}

/**
 * UI-SPEC §8.2 Row 1: the Pro desk's five-figure stat row — win rate (lead,
 * horizon-bound), rating (± RD, `ratingMove`-bound delta), peak rating (+
 * date), best month, and sessions (+ average games). Replaces the four
 * page-local `HeroCard`s this file used to declare (UIX-04) — the page-local
 * stat-idiom violation `layoutIdioms.test.ts` flags this file for is deleted
 * in the SAME commit as this rebuild.
 */
export function TrendsHero({ matches, horizon }: TrendsHeroProps) {
  const { t, i18n } = useTranslation();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch (see `MatchupChart.tsx`, `useHorizon.ts`).
  const [nowMs] = useState(() => Date.now());

  const hero = useMemo(() => buildTrendsHero(matches), [matches]);
  const { periods } = useMemo(() => computeRatingHistory(matches), [matches]);
  const peakPeriod = useMemo(
    () =>
      periods.length > 0 ? periods.reduce((best, p) => (p.rating > best.rating ? p : best)) : null,
    [periods],
  );
  const sessions = useMemo(() => getSessions(matches), [matches]);
  const headline = useMemo(() => buildSessionsHeadline(sessions), [sessions]);

  const baselineAllTime = useMemo(() => toRateValue(matches), [matches]);
  const { matches: recentMatches } = useMemo(
    () => resolveWindow({ matches, horizon, scoped: false, nowMs }),
    [matches, horizon, nowMs],
  );
  const recentRate = useMemo(() => toRateValue(recentMatches), [recentMatches]);
  const { state: winRateState, deltaPoints: winRateDelta } = useMemo(
    () =>
      classify({ recent: recentRate, baseline: baselineAllTime, scoped: false, hasAction: false }),
    [recentRate, baselineAllTime],
  );

  // `ratingMove` at the whole-account scope (TRND-02/DD-12) through the ONE
  // shared helper the Dashboard Rating tile also uses (plan 35-05, F24), so
  // the two pages can never disagree on a rating direction.
  const { chipView: ratingChipView, ariaLabel: ratingChipAria } = useMemo(
    () => buildRatingMoveChipView({ matches, horizon, nowMs, t }),
    [matches, horizon, nowMs, t],
  );

  // Plan 39.1-36 (audit 2.2, UI-SPEC §7.5): the "Win rate" overline does not
  // name the horizon, so the chip carries its own ("Steady · last 30").
  const winRateChipView = deltaChipView({
    state: winRateState,
    deltaPoints: winRateDelta,
    recentGames: recentRate.total,
    horizon,
    horizonOwnedByParent: false,
    t,
  });
  const winRateChip = winRateChipView ? (
    <DeltaChip
      {...winRateChipView}
      ariaLabel={t('analytics.dumbbell.rowAria', {
        label: t('trends.hero.winRate'),
        recentRecord: `${recentRate.wins}–${recentRate.losses}`,
        baselineRecord: `${baselineAllTime.wins}–${baselineAllTime.losses}`,
      })}
    />
  ) : null;

  let winRateFigure;
  if (winRateState === 'locked' && baselineAllTime.total > 0) {
    // Plan 39.1-36: a sub-floor window on an account that HAS games is a
    // muted em dash plus the honest chip ("no games · last 90 days",
    // "n 2 · no direction"), with the Record only when the window holds a
    // game — never an unlock sentence posing as the figure.
    winRateFigure = (
      <StatFigure
        key="winRate"
        label={t('trends.hero.winRate')}
        lead
        state="none"
        value={<span className="text-muted-foreground">{'—'}</span>}
        support={
          recentRate.total > 0 ? (
            <Record wins={recentRate.wins} losses={recentRate.losses} cue="none" />
          ) : undefined
        }
        delta={winRateChip}
      />
    );
  } else if (winRateState === 'locked') {
    const needed = Math.max(0, ABSTENTION_FLOOR_GAMES - recentRate.total);
    winRateFigure = (
      <StatFigure
        key="winRate"
        label={t('trends.hero.winRate')}
        lead
        state="empty"
        emptyCaption={t('trends.hero.locked', { count: needed })}
      />
    );
  } else if (winRateState === 'collapsed') {
    winRateFigure = (
      <StatFigure
        key="winRate"
        label={t('trends.hero.winRate')}
        lead
        state="collapsed"
        value={t('analytics.stat.collapsedValue')}
        support={t('analytics.stat.collapsedSupport', {
          recent: recentRate.total,
          total: baselineAllTime.total,
        })}
      />
    );
  } else {
    winRateFigure = (
      <StatFigure
        key="winRate"
        label={t('trends.hero.winRate')}
        lead
        value={`${Math.round(recentRate.rate * 100)}%`}
        state={winRateState === 'thin' ? 'thinRecent' : 'populated'}
        support={<Record wins={recentRate.wins} losses={recentRate.losses} cue="none" />}
        delta={winRateChip}
      />
    );
  }

  let ratingFigure;
  if (!hero.currentRating) {
    ratingFigure = (
      <StatFigure
        key="rating"
        label={t('trends.hero.rating')}
        state="empty"
        emptyCaption={t('trends.hero.notEnoughGames')}
      />
    );
  } else {
    // The rating figure keeps its ratingMove-driven state (a rating delta is
    // not a win-rate window); its sample size is the insight's own window.
    // The "Rating" overline does not name the horizon, so the chip does.
    ratingFigure = (
      <StatFigure
        key="rating"
        label={t('trends.hero.rating')}
        value={`${hero.currentRating.rating}`}
        unitSuffix={`±${hero.currentRating.rd}`}
        delta={
          ratingChipView === null ? null : (
            <DeltaChip {...ratingChipView} ariaLabel={ratingChipAria} />
          )
        }
      />
    );
  }

  const peakFigure = !peakPeriod ? (
    <StatFigure
      key="peak"
      label={t('trends.hero.peakRating')}
      state="empty"
      emptyCaption={t('trends.hero.notEnoughGames')}
    />
  ) : (
    <StatFigure
      key="peak"
      label={t('trends.hero.peakRating')}
      value={`${peakPeriod.rating}`}
      support={formatFullDate(peakPeriod.end, i18n.language)}
    />
  );

  const bestMonthFigure = !hero.bestMonth ? (
    <StatFigure
      key="bestMonth"
      label={t('trends.hero.bestMonth')}
      state="empty"
      emptyCaption={t('trends.hero.bestMonthNeeds', { count: BEST_MONTH_MIN_GAMES })}
    />
  ) : (
    <StatFigure
      key="bestMonth"
      label={t('trends.hero.bestMonth')}
      value={`${hero.bestMonth.winRate}%`}
      support={t('trends.hero.bestMonthCaption', {
        month: formatMonthLabel(hero.bestMonth.month, i18n.language),
        wins: hero.bestMonth.wins,
        losses: hero.bestMonth.losses,
        count: hero.bestMonth.total,
      })}
    />
  );

  const sessionsFigure =
    headline.totalSessions === 0 ? (
      <StatFigure
        key="sessions"
        label={t('trends.hero.sessionsLabel')}
        state="empty"
        emptyCaption={t('common.noMatchData')}
      />
    ) : (
      <StatFigure
        key="sessions"
        label={t('trends.hero.sessionsLabel')}
        value={`${headline.totalSessions}`}
        support={t('trends.hero.avgGamesCaption', { count: headline.avgGamesPerSession })}
      />
    );

  return (
    <Card>
      <CardContent className="pt-6" data-slot="trends-hero-body">
        <StatRow
          leadWidth
          // Plan 39.1-38: sketch 002-C `.statrow.kpi .lead{grid-column:1/-1}` —
          // the one StatRow whose lead spans both phone columns.
          leadSpanOnPhone
          figures={[winRateFigure, ratingFigure, peakFigure, bestMonthFigure, sessionsFigure]}
        />
      </CardContent>
    </Card>
  );
}

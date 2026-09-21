import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { HorizonKey, InsightState, Match } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  ACCOUNT_SCOPE,
  INSIGHT_TEMPLATES,
  classify,
  resolveWindow,
  toRateValue,
} from '@smash-tracker/shared';
import { Card, CardContent } from '@/components/ui/card';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { DeltaChip, type DeltaChipState } from '@/components/analytics/DeltaChip';
import { Record } from '@/components/analytics/Record';
import { getSessions } from '@/lib/stats';
import { computeRatingHistory } from '@/lib/glicko';
import { formatMonthLabel } from './MonthlyPerformance';
import { buildSessionsHeadline } from './SessionsAndTilt';
import { BEST_MONTH_MIN_GAMES, buildTrendsHero } from '../lib/trendsHero';

/**
 * `ratingMove` invoked at the whole-account scope (TRND-02/DD-12) — the same
 * template `TrendsReadsRail.tsx` renders as a card, reused here (independent
 * computation, per this codebase's small-helper-duplication convention) so
 * the hero's Rating figure carries the SAME up/down/steady read as the rail's
 * card rather than a bespoke second rating-delta rule.
 */
const RATING_MOVE_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'ratingMove')!;

/** `classify`'s seven-state honesty ladder -> `DeltaChip`'s six-state union (duplicated per this codebase's small-helper-duplication convention — see `FighterHero.tsx`, `PairingOpponents.tsx`). */
function deltaChipStateFor(state: InsightState, deltaPoints: number | null): DeltaChipState {
  if (state === 'trend' || state === 'suggestion') {
    return deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  }
  if (state === 'steady') return 'steady';
  if (state === 'thin' || state === 'thinRecent') return 'thin';
  if (state === 'collapsed') return 'collapsed';
  return 'none';
}

function deltaValueLabel(state: DeltaChipState, deltaPoints: number | null, t: TFunction): string {
  if (state === 'up') return t('analytics.record.deltaUp', { points: Math.abs(deltaPoints ?? 0) });
  if (state === 'down') {
    return t('analytics.record.deltaDown', { points: Math.abs(deltaPoints ?? 0) });
  }
  return t(`insights.chip.${state === 'none' ? 'thin' : state}`);
}

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

  const ratingMoveInsight = useMemo(
    () => RATING_MOVE_TEMPLATE.build({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs })[0] ?? null,
    [matches, horizon, nowMs],
  );

  let winRateFigure;
  if (winRateState === 'locked') {
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
    const chipState = deltaChipStateFor(winRateState, winRateDelta);
    winRateFigure = (
      <StatFigure
        key="winRate"
        label={t('trends.hero.winRate')}
        lead
        value={`${Math.round(recentRate.rate * 100)}%`}
        state={winRateState === 'thin' ? 'thinRecent' : 'populated'}
        support={<Record wins={recentRate.wins} losses={recentRate.losses} cue="none" />}
        delta={
          chipState === 'collapsed' ? null : (
            <DeltaChip
              state={chipState}
              valueLabel={deltaValueLabel(chipState, winRateDelta, t)}
              horizonOwnedByParent
              ariaLabel={t('analytics.dumbbell.rowAria', {
                label: t('trends.hero.winRate'),
                recentRecord: `${recentRate.wins}–${recentRate.losses}`,
                baselineRecord: `${baselineAllTime.wins}–${baselineAllTime.losses}`,
              })}
            />
          )
        }
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
    const rmState = ratingMoveInsight?.state ?? 'locked';
    const rmDelta = ratingMoveInsight?.deltaPoints ?? null;
    const chipState = deltaChipStateFor(rmState, rmDelta);
    ratingFigure = (
      <StatFigure
        key="rating"
        label={t('trends.hero.rating')}
        value={`${hero.currentRating.rating}`}
        unitSuffix={`±${hero.currentRating.rd}`}
        delta={
          chipState === 'collapsed' ? null : (
            <DeltaChip
              state={chipState}
              valueLabel={deltaValueLabel(chipState, rmDelta, t)}
              horizonOwnedByParent
              ariaLabel={t('analytics.dumbbell.rowAria', {
                label: t('trends.hero.rating'),
                recentRecord: `${hero.currentRating.rating}`,
                baselineRecord: `${hero.currentRating.rating}`,
              })}
            />
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
          figures={[winRateFigure, ratingFigure, peakFigure, bestMonthFigure, sessionsFigure]}
        />
      </CardContent>
    </Card>
  );
}

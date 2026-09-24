import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { HorizonKey, InsightState, Match } from '@smash-tracker/shared';
import { classify, resolveWindow, toRateValue } from '@smash-tracker/shared';
import { getWinLossRecord } from '@/lib/stats';
import { ChartCard } from '@/components/charts/ChartCard';
import { RecordBar, MiniStrip } from '@/components/charts/inlineMarks';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { DeltaChip, type DeltaChipState } from '@/components/analytics/DeltaChip';

/** `classify`'s `InsightState` (D-07's seven-state honesty ladder) -> `DeltaChip`'s six-state union (INS-02). `deltaPoints`'s own sign (not the state name) decides `up`/`down` for the two asserting states. */
function deltaChipStateFor(state: InsightState, deltaPoints: number | null): DeltaChipState {
  if (state === 'trend' || state === 'suggestion') {
    return deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  }
  if (state === 'steady') return 'steady';
  if (state === 'thin' || state === 'thinRecent') return 'thin';
  if (state === 'collapsed') return 'collapsed';
  return 'none';
}

/** UI-SPEC §7.5-adjacent: this record card's own delta value label — `+N pts` / `-N pts` (`analytics.record.deltaUp/deltaDown`). Non-directional states (steady/thin/none) reuse the existing `insights.chip.*` words rather than a bare, context-free number. */
function deltaValueLabel(state: DeltaChipState, deltaPoints: number | null, t: TFunction): string {
  if (state === 'up') {
    return t('analytics.record.deltaUp', { points: Math.abs(deltaPoints ?? 0) });
  }
  if (state === 'down') {
    return t('analytics.record.deltaDown', { points: Math.abs(deltaPoints ?? 0) });
  }
  return t(`insights.chip.${state === 'none' ? 'thin' : state}`);
}

/**
 * Ports legacy/src/screens/Matchups/components/MatchWinLossCard. Phase 39.1
 * (UIX-04, owner note 3): the three equal, evenly-distributed-flex numbers —
 * the exact defect this card was named for — become the ONE stat idiom: a lead
 * win-rate figure with a two-horizon `DeltaChip`, a bare record figure, and
 * a games figure (each figure states its own thing once — the games count
 * lives ONLY here, never repeated), then a full-width `RecordBar` and a
 * `MiniStrip` of the last 30 games.
 */
export function MatchWinLossCard({
  matchupMatches,
  horizon,
}: {
  matchupMatches: Match[];
  horizon: HorizonKey;
}) {
  const { t } = useTranslation();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch (see `MatchupChart.tsx`, `useHorizon.ts`).
  const [nowMs] = useState(() => Date.now());

  if (matchupMatches.length === 0) {
    // A 0-0 record is a recorded fact, not a gated recommendation — the
    // abstention sentence would misdescribe it (Phase 36 precedent).
    return (
      <ChartCard title={t('matchups.record.title')} density="compact">
        <p className="text-sm text-muted-foreground">{t('matchups.record.empty')}</p>
      </ChartCard>
    );
  }

  const { wins, losses, total } = getWinLossRecord(matchupMatches);
  const rate = Math.round((wins / total) * 100);

  const baseline = toRateValue(matchupMatches);
  const { matches: recentMatches } = resolveWindow({
    matches: matchupMatches,
    horizon,
    scoped: true,
    nowMs,
  });
  const recent = toRateValue(recentMatches);
  const { state, deltaPoints } = classify({ recent, baseline, scoped: true, hasAction: false });
  // WR-C01: `locked` (below the abstention floor) is a different honesty
  // tier than `thin`/`thinRecent` and has no `DeltaChip` representation —
  // omit the chip entirely rather than let it fall through to
  // `deltaChipStateFor`'s `'none'` default, which reads "Thin".
  const chipState = state === 'locked' ? null : deltaChipStateFor(state, deltaPoints);

  const deltaChip =
    chipState === null || chipState === 'collapsed' ? null : (
      <DeltaChip
        state={chipState}
        valueLabel={deltaValueLabel(chipState, deltaPoints, t)}
        horizonLabel={t(`insights.horizon.short.${horizon}`)}
        ariaLabel={t('analytics.dumbbell.rowAria', {
          label: t('matchups.record.title'),
          recentRecord: `${recent.wins}–${recent.losses}`,
          baselineRecord: `${baseline.wins}–${baseline.losses}`,
        })}
      />
    );

  const last30 = [...matchupMatches]
    .sort((a, b) => a.time - b.time)
    .slice(-30)
    .map((match) => ({ key: match.id, won: match.win }));

  return (
    <ChartCard title={t('matchups.record.title')} density="compact">
      <div className="flex flex-col gap-4">
        <StatRow
          leadWidth
          figures={[
            <StatFigure
              key="rate"
              label={t('matchups.chart.winRate')}
              value={`${rate}%`}
              lead
              delta={deltaChip}
            />,
            <StatFigure
              key="record"
              label={t('matchups.record.title')}
              value={`${wins}–${losses}`}
            />,
            <StatFigure key="games" label={t('matchups.record.totalMatches')} value={total} />,
          ]}
        />
        <RecordBar wins={wins} losses={losses} />
        {/* The same drawn-of-total name the FormStrip hosts use: `shown` is the games
            the mini strip draws (the last ≤30), `count` the card's whole record. */}
        <MiniStrip
          games={last30}
          ariaLabel={t('analytics.strip.aria', { count: total, shown: last30.length })}
        />
      </div>
    </ChartCard>
  );
}

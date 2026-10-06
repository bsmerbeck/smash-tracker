import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import {
  HORIZON_COLLAPSE_RATIO,
  RECENT_GAME_WINDOW,
  classify,
  confidenceTierFor,
  resolveWindow,
  toRateValue,
} from '@smash-tracker/shared';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { DeltaChip } from '@/components/analytics/DeltaChip';
import { deltaChipView } from '@/components/analytics/deltaChipView';
import { Record } from '@/components/analytics/Record';

/**
 * The three recent-window figures rendered as buttons — a SECOND control for
 * the same page-level persisted horizon `useHorizon` owns (D-06). Order is
 * fixed, matching UI-SPEC §8.1's stat row.
 */
const RECENT_HORIZON_KEYS: readonly HorizonKey[] = ['last30', 'lastEvent', 'last90'];

/**
 * Plan 39.1-57 (UAT 39.1-16): the game / day horizons collapse BEFORE the
 * abstention floor — a 2-game window holding 2 of 2 games is "= all games",
 * not "n 2 · no direction". `classify` keeps its order (floor first) for every
 * other caller; last event keeps today's ladder (UI-SPEC §8.1 40-game clause).
 */
const COLLAPSE_BEFORE_FLOOR_KEYS: readonly HorizonKey[] = ['last30', 'last90'];

export interface HorizonStatRowProps {
  /** The hero's scoped base (a fighter's or a pairing's games). */
  matches: Match[];
  /** The page's ONE persisted horizon — the pressed figure. */
  horizon: HorizonKey;
  onSelectHorizon: (next: HorizonKey) => void;
  /** True while the host's match query is in flight — a figure click writes nothing (T-39.1-14-03). */
  disabled: boolean;
  /** The host's one clock (the same one its FormNow insight was built with, D-06 / D-12). */
  nowMs: number;
}

/**
 * Plan 39.1-43 (sketch 003 A "Hero port", brief §1 "one idiom per job";
 * sketch 001-C / 003 `statRow` + `hzFigure`): the hero stat row — the lead
 * "All time" figure (rate + Record with its confidence cue) then the last 30
 * / last event / last 90 figures, each a D-15 SCOPED window (`resolveWindow`)
 * classified against the all-time baseline (`classify`), its chip only via
 * `deltaChipView`. Moved verbatim from the Fighter hero so the pairing hero
 * (plan 39.1-44) renders the same piece.
 */
export function HorizonStatRow({
  matches,
  horizon,
  onSelectHorizon,
  disabled,
  nowMs,
}: HorizonStatRowProps) {
  const { t } = useTranslation();

  const baselineAllTime = useMemo(() => toRateValue(matches), [matches]);
  const allTimeTier = confidenceTierFor(baselineAllTime.total);

  const horizonFigures = useMemo(() => {
    return RECENT_HORIZON_KEYS.map((key) => {
      const { window, matches: recentMatches } = resolveWindow({
        matches,
        horizon: key,
        scoped: true,
        nowMs,
      });
      const recentRate = toRateValue(recentMatches);
      const collapsesBeforeFloor =
        COLLAPSE_BEFORE_FLOOR_KEYS.includes(key) &&
        baselineAllTime.total > 0 &&
        recentRate.total >= HORIZON_COLLAPSE_RATIO * baselineAllTime.total;
      const { state, deltaPoints } = collapsesBeforeFloor
        ? { state: 'collapsed' as const, deltaPoints: null }
        : classify({
            recent: recentRate,
            baseline: baselineAllTime,
            scoped: true,
            hasAction: false,
          });
      return { key, window, recentRate, state, deltaPoints };
    });
  }, [matches, baselineAllTime, nowMs]);

  function handleSelectHorizon(next: HorizonKey): void {
    // T-39.1-14-03: never write a horizon while the match query is loading.
    if (disabled) return;
    onSelectHorizon(next);
  }

  const overallRatePercent = baselineAllTime.rate * 100;
  // Each string is resolved in its own statement (insightCopy guard: two
  // translation calls never meet inside one JSX expression).
  const allTimeLabel = t('analytics.stat.allTime');
  const allTimeCue = allTimeTier
    ? t(`shared.evidence.sampleCueGlyph.${allTimeTier}`, { count: baselineAllTime.total })
    : undefined;

  const allTimeFigure = (
    <StatFigure
      key="all-time"
      label={allTimeLabel}
      value={`${Math.round(overallRatePercent)}%`}
      lead
      support={
        <Record wins={baselineAllTime.wins} losses={baselineAllTime.losses} cueLabel={allTimeCue} />
      }
    />
  );

  const recentFigureNodes = horizonFigures.map(
    ({ key, window, recentRate, state, deltaPoints }) => {
      const isPressed = horizon === key;
      // Plan 39.1-57 (UAT 39.1-28 F7): a last-30 window the D-15 scope trimmed
      // below 30 games states the games it holds ("13 games"), matching the
      // FormNow verdict; the chip's accessible name keeps the full horizon name.
      const statesSample =
        key === 'last30' &&
        state !== 'collapsed' &&
        window.games > 0 &&
        window.games < RECENT_GAME_WINDOW;
      const figureLabel = statesSample
        ? t('insights.horizon.short.lastN', { count: window.games })
        : t(`insights.horizon.short.${key}`);
      // The figure overline ("30 games", "Last event", "90 days") names the
      // horizon, so the chip never repeats it.
      const chipView = deltaChipView({
        state,
        deltaPoints,
        recentGames: recentRate.total,
        horizon: key,
        horizonOwnedByParent: true,
        t,
      });
      const delta = chipView ? (
        <DeltaChip
          {...chipView}
          ariaLabel={t('analytics.dumbbell.rowAria', {
            label: t(`insights.horizon.${key}`),
            recentRecord: `${recentRate.wins}–${recentRate.losses}`,
            baselineRecord: `${baselineAllTime.wins}–${baselineAllTime.losses}`,
          })}
        />
      ) : null;

      if (state === 'locked') {
        // Plan 39.1-36 (audit 1.3): below the floor the figure is a muted em
        // dash plus the honest chip ("no games" / "n N · no direction") — no
        // repeated per-figure unlock sentence. The Record appears only when
        // the window holds a game (Record itself omits the rate below 3).
        return (
          <StatFigure
            key={key}
            label={figureLabel}
            state="none"
            value={<span className="text-muted-foreground">{'—'}</span>}
            support={
              recentRate.total > 0 ? (
                <Record wins={recentRate.wins} losses={recentRate.losses} cue="none" />
              ) : undefined
            }
            delta={delta}
            onSelect={() => handleSelectHorizon(key)}
            pressed={isPressed}
          />
        );
      }

      if (state === 'collapsed') {
        const collapsedValue = t('analytics.stat.collapsedValue');
        const collapsedSupport = t('analytics.stat.collapsedSupport', {
          recent: recentRate.total,
          total: baselineAllTime.total,
        });
        return (
          <StatFigure
            key={key}
            label={figureLabel}
            state="collapsed"
            value={collapsedValue}
            support={collapsedSupport}
            onSelect={() => handleSelectHorizon(key)}
            pressed={isPressed}
          />
        );
      }

      const isThinRecent = state === 'thinRecent' || state === 'thin';

      return (
        <StatFigure
          key={key}
          label={figureLabel}
          value={`${Math.round(recentRate.rate * 100)}%`}
          state={isThinRecent ? 'thinRecent' : 'populated'}
          support={<Record wins={recentRate.wins} losses={recentRate.losses} cue="none" />}
          delta={delta}
          onSelect={() => handleSelectHorizon(key)}
          pressed={isPressed}
        />
      );
    },
  );

  return <StatRow leadWidth figures={[allTimeFigure, ...recentFigureNodes]} />;
}

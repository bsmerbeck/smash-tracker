import type { TFunction } from 'i18next';
import type { HorizonKey, InsightState } from '@smash-tracker/shared';
import { TREND_MIN_RECENT_GAMES } from '@smash-tracker/shared';
import type { DeltaChipState } from '@/components/analytics/DeltaChip';

/** Input of {@link deltaChipView} — the engine's ladder state plus the recent window's real size. */
export interface DeltaChipViewInput {
  /** The honesty ladder's state (`classify`), never re-derived here (D-07). */
  state: InsightState;
  /** Non-null exactly in the engine's `trend` / `suggestion` states. */
  deltaPoints: number | null;
  /** The recent window's real game count — never a constant. */
  recentGames: number;
  /** The window the chip speaks for. */
  horizon: HorizonKey;
  /** True only when the enclosing figure overline or list meta already names the horizon (UI-SPEC §7.5). */
  horizonOwnedByParent: boolean;
  t: TFunction;
}

/** What a host spreads onto `<DeltaChip>` (plus its own `ariaLabel`). */
export interface DeltaChipView {
  state: DeltaChipState;
  valueLabel: string;
  horizonLabel?: string;
  horizonOwnedByParent: boolean;
  recentGames: number;
}

/** The chip's own horizon label keys — lower-case, impersonal, read after a count ("no games · last 30"). */
const CHIP_HORIZON_KEYS: Record<HorizonKey, string> = {
  last30: 'insights.chip.horizon.last30',
  lastEvent: 'insights.chip.horizon.lastEvent',
  last90: 'insights.chip.horizon.last90',
};

/**
 * The ONE mapping from the engine's honesty-ladder state to a `DeltaChip`
 * (plan 39.1-36, UI-SPEC §7.5, bound by sketches 001-C / 003-A where their
 * text and the spec differ). The engine decides direction (D-07); this
 * module only renders what it decided, and degrades an impossible engine
 * output (a direction on too few games) rather than showing it:
 *
 * - `collapsed` -> `null` (no chip — the recent window IS all games).
 * - 0 recent games -> `none`: "no games", with the horizon label unless the
 *   parent owns it (sketch 001-C `shareBar`: "no games · last 30").
 * - 1 to `TREND_MIN_RECENT_GAMES - 1` recent games -> `thin`:
 *   "n N · no direction", hollow circle, no horizon suffix (sketch 001-C
 *   `deltaChip` thin branch) — the chip states a count, not a delta, so the
 *   view marks the horizon as owned and DeltaChip's horizon guard passes.
 *   Never steady, up or down below the floor, whatever state was fed in.
 * - `steady` -> "Steady"; `trend` / `suggestion` -> up / down with the
 *   engine's own points, each with its horizon label unless parent-owned.
 * - A sub-direction state on a full window (`locked` / `thin` /
 *   `thinRecent` on >= 8 games, or a direction with no points) is not a
 *   state the engine emits; it degrades to the thin "no direction" chip.
 */
export function deltaChipView({
  state,
  deltaPoints,
  recentGames,
  horizon,
  horizonOwnedByParent,
  t,
}: DeltaChipViewInput): DeltaChipView | null {
  if (state === 'collapsed') {
    return null;
  }

  const horizonLabel = horizonOwnedByParent ? undefined : t(CHIP_HORIZON_KEYS[horizon]);

  if (recentGames <= 0) {
    return {
      state: 'none',
      valueLabel: t('insights.chip.noGames'),
      horizonLabel,
      horizonOwnedByParent,
      recentGames: 0,
    };
  }

  const noDirection: DeltaChipView = {
    state: 'thin',
    valueLabel: t('insights.chip.noDirection', { count: recentGames }),
    horizonOwnedByParent: true,
    recentGames,
  };

  if (recentGames < TREND_MIN_RECENT_GAMES) {
    return noDirection;
  }

  if (state === 'steady') {
    return {
      state: 'steady',
      valueLabel: t('insights.chip.steady'),
      horizonLabel,
      horizonOwnedByParent,
      recentGames,
    };
  }

  if ((state === 'trend' || state === 'suggestion') && deltaPoints !== null) {
    const direction = deltaPoints < 0 ? 'down' : 'up';
    return {
      state: direction,
      valueLabel: t(
        direction === 'down' ? 'analytics.record.deltaDown' : 'analytics.record.deltaUp',
        {
          points: Math.abs(deltaPoints),
        },
      ),
      horizonLabel,
      horizonOwnedByParent,
      recentGames,
    };
  }

  return noDirection;
}

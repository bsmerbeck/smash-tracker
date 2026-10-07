import type { TFunction } from 'i18next';
import type { HorizonKey, Insight, Match } from '@smash-tracker/shared';
import { ACCOUNT_SCOPE, INSIGHT_TEMPLATES } from '@smash-tracker/shared';
import { deltaChipView, type DeltaChipView } from '@/components/analytics/deltaChipView';

/** `ratingMove` (TRND-02/DD-12), resolved once at module scope. */
const RATING_MOVE_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'ratingMove')!;

/** Input of {@link buildRatingMoveChipView}. */
export interface RatingMoveChipInput {
  matches: Match[];
  /** The page's ONE horizon — the window the rating move is measured across. */
  horizon: HorizonKey;
  /** A stable "now" (hosts read it once via a lazy `useState` initializer). */
  nowMs: number;
  t: TFunction;
}

/** The account-scope `ratingMove` insight plus the chip view a host spreads onto `<DeltaChip>`. */
export interface RatingMoveChip {
  insight: Insight | null;
  chipView: DeltaChipView | null;
  /**
   * The chip's accessible name (UAT review WR-01): the label, the direction
   * and signed move the chip shows, and its horizon — e.g. "Rating: Trending
   * up, +210 · last 30". Empty when there is no chip.
   */
  ariaLabel: string;
}

/**
 * The accessible name of a rating chip, built from the chip view itself so
 * it always says what the chip shows (DeltaChip's `aria-label` replaces the
 * visible text for assistive tech).
 */
function ratingChipAriaLabel(chipView: DeltaChipView | null, t: TFunction): string {
  if (chipView === null) {
    return '';
  }
  const label = t('trends.hero.rating');
  const value = chipView.valueLabel;
  const horizon = chipView.horizonLabel;
  if ((chipView.state === 'up' || chipView.state === 'down') && horizon) {
    return t('insights.chip.ratingAria.directional', {
      label,
      direction: t(`insights.chip.aria.${chipView.state}`),
      value,
      horizon,
    });
  }
  if (horizon) {
    return t('insights.chip.ratingAria.withHorizon', { label, value, horizon });
  }
  return t('insights.chip.ratingAria.bare', { label, value });
}

/**
 * The ONE code path that decides a rating figure's direction chip (plan
 * 35-05, UAT F24): the whole-account `ratingMove` template over the horizon
 * (start-of-window -> now, RD-band rule DD-12, gated by `classify`), mapped
 * through `deltaChipView` with a rating unit. The Dashboard Rating tile and
 * the Trends hero both call this, so the two pages can never disagree on a
 * rating direction — and neither shows a direction below the template's gate.
 */
export function buildRatingMoveChipView({
  matches,
  horizon,
  nowMs,
  t,
}: RatingMoveChipInput): RatingMoveChip {
  const insight =
    RATING_MOVE_TEMPLATE.build({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs })[0] ?? null;
  const chipView = deltaChipView({
    state: insight?.state ?? 'locked',
    deltaPoints: insight?.deltaPoints ?? null,
    recentGames: insight?.window.games ?? 0,
    horizon,
    horizonOwnedByParent: false,
    deltaUnit: 'rating',
    t,
  });
  return { insight, chipView, ariaLabel: ratingChipAriaLabel(chipView, t) };
}

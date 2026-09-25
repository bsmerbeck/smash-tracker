/**
 * VIZ-01 (UI-SPEC §11, §7.13): the hard mark-count caps every chart in this
 * phase (and Phase 41, per §12.2) is graded against, plus the two related
 * thresholds the grain ladder (`periodSeries.ts`) and `TrendLine
 * mode="period"` need — the narrow-plot re-grain target and the
 * locked-period-trend floor. THIS is the one place these six numbers are
 * declared under `packages/shared/src/insight/`; no other file in this
 * directory may re-declare any of them (mirrors `evidence/policy.ts`'s "one
 * threshold source" discipline, `markBounds.test.ts` asserts the exclusivity).
 */

/** UI-SPEC §11: a line chart at any account size shows at most this many points — the ladder re-grains rather than exceeding it. */
export const MARK_BOUND_LINE_POINTS = 60;

/** UI-SPEC §11: a bar chart shows at most this many bars. */
export const MARK_BOUND_BARS = 36;

/** UI-SPEC §11: a year x month activity heat map shows at most this many cells (9 years x 12 months). */
export const MARK_BOUND_HEAT_CELLS = 108;

/** UI-SPEC §11: a strip (`FormStrip`) shows at most this many ticks; beyond it the strip's meta reads "N of M games shown". */
export const MARK_BOUND_STRIP_TICKS = 60;

/**
 * UI-SPEC §11 "narrow plots re-grain, they do not squeeze": below a 520px
 * plot the ladder is asked for this smaller target instead of
 * `MARK_BOUND_LINE_POINTS`, rather than drawing sub-legible marks.
 */
export const NARROW_PLOT_TARGET = 30;

/**
 * UI-SPEC §7.13 `TrendLine mode="period"` locked state: fewer than this many
 * periods at the ladder's chosen grain replaces the plot with an L2 locked
 * inset instead of rendering.
 */
export const PERIOD_TREND_MIN_PERIODS = 8;

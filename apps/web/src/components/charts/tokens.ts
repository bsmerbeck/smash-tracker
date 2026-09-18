/**
 * Chart kit design tokens (D-03, CHRT-01/CHRT-04). SVG resolves CSS custom
 * properties natively in `stroke`/`fill` (unlike chart.js, which needs the
 * resolved-hex mirror in `apps/web/src/lib/chartTheme.ts` — that mirror is
 * the anti-pattern this module deliberately does NOT repeat). The app is
 * dark-only, `:root` and `.dark` share one identical palette
 * (`apps/web/src/index.css`), so this module carries exactly one token map
 * and no colour-scheme branch anywhere in the kit.
 *
 * `--chart-3` is deliberately given no mark role here: per the UI-SPEC's
 * validated palette table (`37-UI-SPEC.md`, "Chart Kit Palette" section),
 * its lightness (`L 0.80`) sits above the dark-mode lightness ceiling
 * (`0.67`) the palette validator enforces, so it reads washed-out/low
 * contrast on `--card` and is not dark-mode-safe as a chart mark. It stays
 * documented in the kit's closed vocabulary (see the kit README) rather than
 * silently dropped — a future chart needing a second identity color should
 * reach for `--chart-4` (already validated as the `{--chart-1, --chart-4}`
 * pair) instead.
 */
export const CHART_TOKENS = Object.freeze({
  /** The trend line's single identity series color (`--chart-1`, the app's brand red). */
  series1: 'var(--chart-1)',
  /** Reserved second-series slot for a future two-series comparison (Phase 41). */
  series2: 'var(--chart-4)',
  /** De-emphasis ink — never an identity series (e.g. a reference line). */
  deemphasis: 'var(--chart-2)',
  /** A stronger de-emphasis step than `deemphasis` (e.g. an unfilled meter track, gridlines). */
  deemphasisStrong: 'var(--chart-5)',
  /** Gridline / cursor hairline color. */
  grid: 'var(--border)',
  /** Axis tick / legend text color. */
  axisText: 'var(--muted-foreground)',
  /** The chart plot surface — the same surface every `Card` renders on. */
  surface: 'var(--card)',
  /** Border color shared with the rest of the `Card` family. */
  border: 'var(--border)',
});

/** Fixed chart body height (SC1's 1440p-fit mechanism) — bounded regardless of data length or viewport. */
export const CHART_BODY_HEIGHT_PX = 288;
/** Axis tick / legend font size in px. */
export const CHART_AXIS_FONT_SIZE = 12;
/** Trend line stroke width in px. */
export const CHART_LINE_WIDTH = 2;
/** Trend line dot marker radius in px. */
export const CHART_DOT_RADIUS = 4;
/** Comparison-bar row height in px (bar + label), Counterpick Advisor vocabulary member. */
export const CHART_BAR_ROW_HEIGHT_PX = 32;
/** Comparison-bar maximum thickness in px. */
export const CHART_BAR_MAX_THICKNESS_PX = 24;

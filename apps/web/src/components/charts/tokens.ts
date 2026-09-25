/**
 * Chart kit design tokens (D-03, CHRT-01/CHRT-04). SVG resolves CSS custom
 * properties natively in `stroke`/`fill` (unlike chart.js, which needs the
 * resolved-hex mirror in `apps/web/src/lib/chartTheme.ts` — that mirror is
 * the anti-pattern this module deliberately does NOT repeat). The app is
 * dark-only, `:root` and `.dark` share one identical palette
 * (`apps/web/src/index.css`), so this module carries exactly one token map
 * and no colour-scheme branch anywhere in the kit.
 *
 * Phase 39.1 plan 10 (UIX-05, UI-SPEC §4.2): `series1`/`series2`/
 * `deemphasis`/`deemphasisStrong` are repointed from the raw chart-N custom
 * properties onto the new tokenised viz-* layer (`apps/web/src/index.css`)
 * — no kit file may read a raw chart custom property directly after this
 * edit (`chartKitBoundary.test.ts`'s boundary guard). This closes the
 * `--chart-3` defect the kit README used to document: `--chart-3` is now
 * re-stepped and read (via `--viz-series-2`), not silently unused.
 *
 * Phase 39.1 wave 1 (UIX-05, review finding C1-H5): `win`/`loss`/`steady`
 * landed here ahead of the rest of the visualization token table (scheduled
 * for Track C, plan 39.1-10) because the marks that draw those roles
 * (`DeltaChip` here; `FormStrip` and the inline marks in plan 39.1-08) are
 * wave-1 components and would otherwise have had no legal colour source —
 * this is the ONE frozen token map (UIX-05's contract), never a second
 * module.
 */
export const CHART_TOKENS = Object.freeze({
  /** The identity series — every line, dot, usage bar, recent dumbbell dot (`--viz-series-1`). */
  series1: 'var(--viz-series-1)',
  /** Second identity series only when two are unavoidable (`ShareBar` segment 2) (`--viz-series-2`). */
  series2: 'var(--viz-series-2)',
  /** De-emphasis ink — never an identity series (e.g. a reference line) (`--viz-context`). */
  deemphasis: 'var(--viz-context)',
  /** A stronger de-emphasis step than `deemphasis` (e.g. an unfilled meter track, gridlines) (`--viz-context-strong`). Never the only carrier of a value. */
  deemphasisStrong: 'var(--viz-context-strong)',
  /** Gridline / cursor hairline color. */
  grid: 'var(--border)',
  /** Axis tick / legend text color. */
  axisText: 'var(--muted-foreground)',
  /** The chart plot surface — the same surface every `Card` renders on. */
  surface: 'var(--card)',
  /** Border color shared with the rest of the `Card` family. */
  border: 'var(--border)',
  /** Win mark colour (`DeltaChip` up state, `RecordBar` win segment, ▲ glyph). */
  win: 'var(--win)',
  /** Loss mark colour (`DeltaChip` down state, `RecordBar` loss segment, ▼ glyph). */
  loss: 'var(--loss)',
  /** Steady/no-direction mark colour (`DeltaChip` steady/thin/none states). */
  steady: 'var(--steady)',
});

/** Fixed chart body height (SC1's 1440p-fit mechanism) — bounded regardless of data length or viewport. */
export const CHART_BODY_HEIGHT_PX = 288;
/**
 * = `CHART_BODY_HEIGHT_PX` (UI-SPEC §3's `CHART_H_DEFAULT`) — a named alias,
 * not a rename, so no existing call site importing `CHART_BODY_HEIGHT_PX`
 * breaks.
 */
export const CHART_H_DEFAULT = CHART_BODY_HEIGHT_PX;
/** UI-SPEC §3: sparkline plot height in px. SIBLING named export, never a `CHART_TOKENS` key (review finding C2-M5) — this is a dimension, not a colour role. */
export const CHART_H_SPARK = 40;
/** UI-SPEC §3: compact plot height in px (hero period trend, every plot below 640px). SIBLING named export, never a `CHART_TOKENS` key. */
export const CHART_H_COMPACT = 160;
/** UI-SPEC §3: the kit's own fixed-dimension record of the page max width. SIBLING named export, never a `CHART_TOKENS` key. `PageShell.tsx` still carries its own `max-w-[1440px]` Tailwind literal — reconciling the two is a named follow-up, not done in this plan (review finding C2-M5). */
export const PAGE_MAX_WIDTH_PX = 1440;
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

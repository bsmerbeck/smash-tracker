import type { ChartOptions } from 'chart.js';

/**
 * Shared chart.js theming for the Smash dark palette. chart.js can't read
 * CSS variables at config time, so these mirror the tokens in index.css
 * (primary red #e60012 on dark-grey surfaces).
 *
 * Phase 39.1 plan 10 (DD-11, UIX-05): `series`/`seriesSoft` mirror the kit's
 * `--viz-series-1` value (`#3186e9`, `apps/web/src/index.css:33-37,67-71`'s
 * `--chart-1..5` block's tokenised sibling) so the LEGACY chart.js charts
 * this module still themes have a non-brand-red data-ink colour available.
 * The existing `red`/`redSoft` pair and `redLineDataset()` stay in place,
 * byte-unchanged, for the charts Phase 41 still owns — this plan does not
 * repoint any existing call site (see the SUMMARY's measured consumer list;
 * plan 39.1-15 switches the interim Trends charts over).
 */
export const chartColors = {
  red: '#e60012',
  redSoft: 'rgba(230, 0, 18, 0.35)',
  series: '#3186e9',
  seriesSoft: 'rgba(49, 134, 233, 0.35)',
  point: '#ffffff',
  hoverBorder: 'rgba(255, 255, 255, 0.6)',
  grid: 'rgba(255, 255, 255, 0.08)',
  tick: '#a1a1aa',
  legend: '#e4e4e7',
  tooltipBg: '#1d1d20',
  tooltipBorder: 'rgba(255, 255, 255, 0.1)',
} as const;

/** Dataset styling for the signature red win-rate line. */
export function redLineDataset() {
  return {
    fill: false,
    tension: 0.1,
    backgroundColor: chartColors.redSoft,
    borderColor: chartColors.red,
    pointBorderColor: chartColors.red,
    pointBackgroundColor: chartColors.point,
    pointBorderWidth: 1,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: chartColors.red,
    pointHoverBorderColor: chartColors.hoverBorder,
    pointHoverBorderWidth: 2,
    pointRadius: 5,
    pointHitRadius: 10,
  };
}

/** Dataset styling for the tokenised identity-series line (DD-11) — the non-brand-red replacement for `redLineDataset()`, same shape. */
export function seriesLineDataset() {
  return {
    fill: false,
    tension: 0.1,
    backgroundColor: chartColors.seriesSoft,
    borderColor: chartColors.series,
    pointBorderColor: chartColors.series,
    pointBackgroundColor: chartColors.point,
    pointBorderWidth: 1,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: chartColors.series,
    pointHoverBorderColor: chartColors.hoverBorder,
    pointHoverBorderWidth: 2,
    pointRadius: 5,
    pointHitRadius: 10,
  };
}

/** Dataset styling for a tokenised identity-series bar (DD-11) — the non-brand-red replacement for a bar dataset that would otherwise reach for `chartColors.red`. */
export function seriesBarDataset() {
  return {
    backgroundColor: chartColors.seriesSoft,
    borderColor: chartColors.series,
    borderWidth: 1,
    borderRadius: 2,
    hoverBackgroundColor: chartColors.series,
  };
}

/**
 * Scale/legend/tooltip styling legible on the dark background, plus the
 * `responsive`/`maintainAspectRatio` pair every chart on this dashboard
 * needs (V9-C): chart.js defaults `maintainAspectRatio` to `true`, which
 * locks the canvas to its intrinsic aspect ratio instead of filling a wide
 * flex/grid card — the cause of the "tiny chart in a huge card" bug on
 * Trends. Callers still need a fixed-height wrapper div (see
 * FighterAnalysis/RatingCurve/MonthlyPerformance) since `maintainAspectRatio:
 * false` alone doesn't give the canvas a height to fill.
 */
export function darkChartOptions(): Pick<
  ChartOptions<'line'>,
  'responsive' | 'maintainAspectRatio' | 'scales' | 'plugins'
> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        grid: { color: chartColors.grid },
        ticks: { color: chartColors.tick },
      },
      y: {
        grid: { color: chartColors.grid },
        ticks: { color: chartColors.tick },
      },
    },
    plugins: {
      legend: { labels: { color: chartColors.legend } },
      tooltip: {
        backgroundColor: chartColors.tooltipBg,
        borderColor: chartColors.tooltipBorder,
        borderWidth: 1,
      },
    },
  };
}

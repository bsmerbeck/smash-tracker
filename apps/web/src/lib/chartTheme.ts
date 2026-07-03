import type { ChartOptions } from 'chart.js';

/**
 * Shared chart.js theming for the Smash dark palette. chart.js can't read
 * CSS variables at config time, so these mirror the tokens in index.css
 * (primary red #e60012 on dark-grey surfaces).
 */
export const chartColors = {
  red: '#e60012',
  redSoft: 'rgba(230, 0, 18, 0.35)',
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

/** Scale/legend/tooltip styling legible on the dark background. */
export function darkChartOptions(): Pick<ChartOptions<'line'>, 'scales' | 'plugins'> {
  return {
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

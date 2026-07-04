/**
 * Color scale for the matchup matrix heatmap. Pure and independently
 * testable: given a cell's Wilson lower bound and sample size, returns an
 * inline `background-color` (interpolated between the theme's destructive
 * red, a neutral grey midpoint, and emerald green) plus an opacity that
 * scales with sample size, so a 1-game pairing reads as faint evidence and a
 * 10+-game pairing reads at full saturation.
 *
 * Colors are hard-coded RGB (not CSS variables) because they're linearly
 * interpolated at render time — mirrors the chartTheme.ts approach of
 * mirroring (not reading) the design tokens for cases that need real color
 * math.
 */

/** oklch(0.63 0.23 29) ~= destructive red, from index.css. */
const LOW_RGB: [number, number, number] = [217, 62, 52];
/** Neutral grey midpoint (matches the muted surface tone). */
const MID_RGB: [number, number, number] = [113, 113, 122];
/** emerald-500, used elsewhere in the app (WinLossPips, MatchupInsights). */
const HIGH_RGB: [number, number, number] = [16, 185, 129];

/** Sample size at which cell opacity reaches full saturation. */
export const FULL_SAMPLE_SIZE = 10;
/** Minimum opacity for a 1-game cell — faint but still visible/legible. */
const MIN_OPACITY = 0.25;
const MAX_OPACITY = 1;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(
  from: [number, number, number],
  to: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

/**
 * Interpolates red (rate=0) -> grey (rate=0.5) -> emerald (rate=1) from the
 * RAW win rate. Confidence lives in the opacity channel instead
 * (`sampleSizeToOpacity`): at real-world sample sizes the Wilson lower bound
 * sits below 0.5 for almost every pairing, which painted winning records
 * red — hue answers "am I winning this?", opacity answers "how sure are we?".
 */
export function rateToRgb(rate: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, rate));
  if (clamped <= 0.5) {
    return lerpRgb(LOW_RGB, MID_RGB, clamped / 0.5);
  }
  return lerpRgb(MID_RGB, HIGH_RGB, (clamped - 0.5) / 0.5);
}

/**
 * Opacity scaled by sample size: 1 game is faint (`MIN_OPACITY`), `
 * FULL_SAMPLE_SIZE`+ games is fully saturated (`MAX_OPACITY`), linear in
 * between. Zero/negative sample sizes clamp to the minimum.
 */
export function sampleSizeToOpacity(total: number): number {
  if (total <= 1) {
    return MIN_OPACITY;
  }
  if (total >= FULL_SAMPLE_SIZE) {
    return MAX_OPACITY;
  }
  const t = (total - 1) / (FULL_SAMPLE_SIZE - 1);
  return lerp(MIN_OPACITY, MAX_OPACITY, t);
}

/** CSS `rgba(...)` background-color string for a matrix cell with this raw win rate (0-1) and sample size. */
export function matchupCellBackground(winRate: number, total: number): string {
  const [r, g, b] = rateToRgb(winRate);
  const alpha = sampleSizeToOpacity(total);
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha.toFixed(3)})`;
}

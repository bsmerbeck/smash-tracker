/**
 * Tier mark dimensions and colour lookup (Phase 39.2 plan 06, UI-SPEC §3 and
 * §4.1, DD-01). One module owns the fixed geometry of the tier glyph and the
 * only place a `--tier-N` custom property name is spelled, so the colour
 * stays a MARK colour (a glyph rect fill) by construction: nothing else in
 * the tier components can reach a tier token without importing it from here.
 */

import type { TierBasis } from '@smash-tracker/shared';

/** Tier glyph width in px: five 2px bars and four 1px gaps. */
export const TIER_GLYPH_WIDTH_PX = 14;
/** Tier glyph height in px. */
export const TIER_GLYPH_HEIGHT_PX = 8;
/** Width of one glyph bar in px. */
export const TIER_GLYPH_BAR_WIDTH_PX = 2;
/** Gap between two glyph bars in px. */
export const TIER_GLYPH_BAR_GAP_PX = 1;
/** Number of bars, equal to the highest tier level (supermajor = 5). */
export const TIER_GLYPH_BAR_COUNT = 5;
/** Badge height in px (the shadcn `Badge` default). */
export const TIER_BADGE_HEIGHT_PX = 20;

/** The fill of an unfilled glyph bar (decorative track, never the only carrier of the level). */
export const TIER_GLYPH_TRACK_FILL = 'var(--viz-context-strong)';

/**
 * The fill for a glyph bar at `level` (1..5). Reads the raw `--tier-N`
 * custom property, which `index.css` declares unconditionally in `:root` and
 * `.dark`. The `--color-tier-N` theme aliases exist for utilities, but
 * Tailwind emits an unused theme variable only when a utility references it,
 * so an SVG `fill` naming the alias would resolve to nothing in a production
 * build. `DeltaChip` reads `--win`/`--loss` the same way.
 */
export function tierFillVar(level: number): string {
  const clamped = Math.min(TIER_GLYPH_BAR_COUNT, Math.max(1, Math.round(level)));
  return `var(--tier-${clamped})`;
}

/** DD-02, UI-SPEC §4.2 rule 12: a recorded or manual tier is a solid badge; an estimate or unknown is outlined. */
export function tierBadgeVariant(basis: TierBasis): 'secondary' | 'outline' {
  return basis === 'manual' || basis === 'recorded' ? 'secondary' : 'outline';
}

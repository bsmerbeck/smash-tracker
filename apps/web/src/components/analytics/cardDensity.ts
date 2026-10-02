/**
 * UI-SPEC §6.2 compact card density, composed by className over the shadcn
 * `Card` (which is never edited): 20px padding from 640px up, 16px below,
 * 16px header-to-content gap, no shadow. The strings are token-identical to
 * `ChartCard`'s `COMPACT_*` classes so a stat tile, a list card and a chart
 * card sit on one rhythm (quick 261002-leg).
 */
export const TILE_CARD_CLASS = 'gap-4 py-4 shadow-none sm:py-5';
/** Horizontal padding for a compact tile's `CardHeader`. */
export const TILE_HEADER_CLASS = 'px-4 sm:px-5';
/** Horizontal padding for a compact tile's `CardContent`. */
export const TILE_CONTENT_CLASS = 'px-4 sm:px-5';

/**
 * Device-local review composer video/editor split percentage — cloned from
 * `apps/web/src/pages/VodManager/lib/vodPrefs.ts`'s convention: a namespaced
 * `smash-tracker.*` key, a pure `parseStored*` that tolerates malformed
 * content, and `readStored*`/`persist*` wrappers guarding
 * `typeof window === 'undefined'` and try/catch around every storage call.
 * Never sent to the API — device-local by design (260826-kio).
 */

export const COMPOSER_SPLIT_STORAGE_KEY = 'smash-tracker.reviewComposerSplit';

/** 40% of a wide desktop pane sits close to today's fixed 480px column, so a coach who never drags the handle sees no visible change. */
export const COMPOSER_SPLIT_DEFAULT_PERCENT = 40;
export const COMPOSER_SPLIT_MIN_PERCENT = 30;
export const COMPOSER_SPLIT_MAX_PERCENT = 70;
/** Percent nudged per ArrowLeft/ArrowRight keypress on the resize handle. */
export const COMPOSER_SPLIT_STEP_PERCENT = 2;

/**
 * Clamps into the [min, max] range and rounds to a whole number so
 * `aria-valuenow` is always deterministic. Non-finite input (`NaN`,
 * `Infinity`, `-Infinity`) returns the default rather than an unusable
 * track.
 */
export function clampSplitPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return COMPOSER_SPLIT_DEFAULT_PERCENT;
  }
  const clamped = Math.min(COMPOSER_SPLIT_MAX_PERCENT, Math.max(COMPOSER_SPLIT_MIN_PERCENT, value));
  return Math.round(clamped);
}

/**
 * Pure, DOM-free split-percent computation from a pointer's clientX and a
 * plain rect object (never a live `DOMRect`, so this is trivially
 * unit-testable without a real pointer event — jsdom does not implement
 * `PointerEvent` coordinates). Returns the default when `width` is not a
 * positive finite number (e.g. a zero-width container mid-layout).
 */
export function computeSplitPercent(
  clientX: number,
  rect: { left: number; width: number },
): number {
  if (!Number.isFinite(rect.width) || rect.width <= 0) {
    return COMPOSER_SPLIT_DEFAULT_PERCENT;
  }
  const fraction = (clientX - rect.left) / rect.width;
  return clampSplitPercent(fraction * 100);
}

/**
 * Parses the persisted split percentage, tolerating missing/malformed
 * localStorage content. `null`, empty, or unparseable text falls back to
 * the default; an in-range numeric string returns that number (rounded); an
 * out-of-range numeric string clamps to the nearest bound.
 */
export function parseStoredSplitPercent(raw: string | null): number {
  if (!raw) {
    return COMPOSER_SPLIT_DEFAULT_PERCENT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return COMPOSER_SPLIT_DEFAULT_PERCENT;
  }
  return clampSplitPercent(parsed);
}

export function readStoredSplitPercent(): number {
  if (typeof window === 'undefined') return COMPOSER_SPLIT_DEFAULT_PERCENT;
  try {
    return parseStoredSplitPercent(window.localStorage.getItem(COMPOSER_SPLIT_STORAGE_KEY));
  } catch {
    return COMPOSER_SPLIT_DEFAULT_PERCENT;
  }
}

export function persistSplitPercent(percent: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMPOSER_SPLIT_STORAGE_KEY, String(percent));
  } catch {
    // Ignore storage failures — the split preference just won't persist this session.
  }
}

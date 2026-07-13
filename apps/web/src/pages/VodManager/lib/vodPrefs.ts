import { NOTE_PRESET_TAGS } from '@/lib/tags';

/**
 * Device-local VOD Manager preferences (quick-tag set + player size) —
 * cloned from `columnVisibility.ts`'s localStorage convention: a namespaced
 * `smash-tracker.*` key, a pure `parseStored*` that tolerates malformed
 * content, and `readStored*`/`persist*` wrappers guarding
 * `typeof window === 'undefined'` and try/catch around every storage call.
 * Neither preference is ever sent to the API — both are device-local by
 * design (04-CONTEXT.md locked decision).
 */

export const VOD_QUICK_TAGS_STORAGE_KEY = 'smash-tracker.vodQuickTags';

/**
 * Parses the persisted quick-tag button set, tolerating missing/malformed
 * localStorage content. Falls back to the 11 `NOTE_PRESET_TAGS` (the
 * quick-tag panel's default set) on null, malformed JSON, a non-array
 * value, or an empty array. A valid array is filtered to non-empty strings
 * and deduped, preserving first-seen order.
 */
export function parseStoredQuickTags(raw: string | null): string[] {
  if (!raw) return [...NOTE_PRESET_TAGS];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...NOTE_PRESET_TAGS];
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'string' && entry.length > 0 && !seen.has(entry)) {
        seen.add(entry);
        result.push(entry);
      }
    }
    return result.length > 0 ? result : [...NOTE_PRESET_TAGS];
  } catch {
    return [...NOTE_PRESET_TAGS];
  }
}

export function readStoredQuickTags(): string[] {
  if (typeof window === 'undefined') return [...NOTE_PRESET_TAGS];
  try {
    return parseStoredQuickTags(window.localStorage.getItem(VOD_QUICK_TAGS_STORAGE_KEY));
  } catch {
    return [...NOTE_PRESET_TAGS];
  }
}

export function persistQuickTags(tags: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VOD_QUICK_TAGS_STORAGE_KEY, JSON.stringify(tags));
  } catch {
    // Ignore storage failures — the quick-tag set just won't persist this session.
  }
}

export const VOD_PLAYER_SIZE_STORAGE_KEY = 'smash-tracker.vodPlayerSize';

export type VodPlayerSize = 'fill' | 'compact';

/**
 * Parses the persisted player size preference: only the exact stored
 * `'compact'` value resolves to `'compact'`; anything else (null, malformed,
 * an unrecognized string) falls back to `'fill'` (today's default behavior).
 */
export function parseStoredPlayerSize(raw: string | null): VodPlayerSize {
  return raw === 'compact' ? 'compact' : 'fill';
}

export function readStoredPlayerSize(): VodPlayerSize {
  if (typeof window === 'undefined') return 'fill';
  try {
    return parseStoredPlayerSize(window.localStorage.getItem(VOD_PLAYER_SIZE_STORAGE_KEY));
  } catch {
    return 'fill';
  }
}

export function persistPlayerSize(size: VodPlayerSize): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VOD_PLAYER_SIZE_STORAGE_KEY, size);
  } catch {
    // Ignore storage failures — the size preference just won't persist this session.
  }
}

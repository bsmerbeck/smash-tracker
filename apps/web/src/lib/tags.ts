import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';

/**
 * Fixed match-level preset tag slugs (TAG-03). Order matches CONTEXT.md and
 * is the order the add-combobox renders them in.
 */
export const MATCH_PRESET_TAGS = [
  'tournament-set',
  'practice-friendlies',
  'bad-matchup',
  'good-read-highlight',
  'to-review',
] as const;

/**
 * Fixed note-level preset tag slugs (TAG-04). Order matches CONTEXT.md and
 * is the order the add-combobox renders them in.
 */
export const NOTE_PRESET_TAGS = [
  'neutral',
  'punish',
  'edgeguard',
  'recovery',
  'kill-confirm',
  'defense',
  'mixup',
  'matchup-note',
  'mental-game',
  'mistake',
  'highlight',
] as const;

/** Every preset slug (match + note), used to distinguish preset vs. custom tags. */
export const PRESET_SLUGS: Set<string> = new Set<string>([
  ...MATCH_PRESET_TAGS,
  ...NOTE_PRESET_TAGS,
]);

/**
 * Resolves a stored tag slug/string to its display label: preset slugs
 * resolve through i18n (`tags.preset.<slug>`); custom tags render as the
 * raw string the user typed (trimmed at write time — see `addTagToList`).
 */
export function tagLabel(t: TFunction, slug: string): string {
  return PRESET_SLUGS.has(slug) ? t(`tags.preset.${slug}`) : slug;
}

const MAX_TAG_LENGTH = 24;

/**
 * Returns a NEW list with `candidate` added: trimmed, blank candidates
 * rejected, case-insensitive deduped against existing entries, and capped
 * at `max` entries (candidate silently dropped once the cap is reached).
 * Never mutates `list`.
 */
export function addTagToList(list: string[], candidate: string, max: number): string[] {
  const trimmed = candidate.trim().slice(0, MAX_TAG_LENGTH);
  if (!trimmed) {
    return list;
  }
  const lower = trimmed.toLowerCase();
  if (list.some((tag) => tag.toLowerCase() === lower)) {
    return list;
  }
  if (list.length >= max) {
    return list;
  }
  return [...list, trimmed];
}

/** Returns a NEW list without `tag` (exact match). Never mutates `list`. */
export function removeTagFromList(list: string[], tag: string): string[] {
  return list.filter((entry) => entry !== tag);
}

/**
 * Derives the sorted, deduped set of CUSTOM tags (presets excluded) in use
 * across `matches` — both match-level `tags` and every note-level
 * `vodTimestamps[].tags` — for the add-combobox's "your existing custom
 * tags" group and for locked-decision cross-match vocabulary. Mirrors
 * `getVodManagerFilterOptions`'s Set+iterate-all+sort shape. Case-insensitive
 * dedupe: the first-seen casing wins.
 */
export function deriveCustomTagVocabulary(matches: Match[]): string[] {
  const seen = new Map<string, string>();
  for (const match of matches) {
    for (const tag of match.tags ?? []) {
      if (!PRESET_SLUGS.has(tag) && !seen.has(tag.toLowerCase())) {
        seen.set(tag.toLowerCase(), tag);
      }
    }
    for (const stamp of match.vodTimestamps ?? []) {
      for (const tag of stamp.tags ?? []) {
        if (!PRESET_SLUGS.has(tag) && !seen.has(tag.toLowerCase())) {
          seen.set(tag.toLowerCase(), tag);
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

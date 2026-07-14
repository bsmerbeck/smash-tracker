import type { TFunction } from 'i18next';
import type { Match, VodTimestamp } from '@smash-tracker/shared';

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

/** Note-level tags are capped at 5 per note (TAG-04) — keeps a single
 * moment's tags skimmable. Shared between `TimestampRow` (the note-tag
 * combobox) and `VodManagerPage`'s quick-tag same-timecode dedupe (retest
 * fix-up #5) so the cap can never drift between the two call sites. */
export const MAX_NOTE_TAGS = 5;

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
 *
 * `extraTags` folds in additional custom-tag sources that aren't (yet)
 * persisted on any match/note — namely the Quick Tags panel's device-local
 * button set (`vodPrefs.ts`'s `quickTags`). A tag the user customizes into
 * their Quick Tags set is, from the user's perspective, already "added" —
 * it should be offered in every OTHER add-combobox immediately, not only
 * after it's actually been applied to some match/note (the bug this
 * parameter fixes: a freshly-customized quick tag was invisible to every
 * other combobox until it happened to get captured onto a note first). Same
 * preset-exclusion + case-insensitive dedupe rules apply; entries already
 * seen from `matches` take casing precedence.
 */
export function deriveCustomTagVocabulary(matches: Match[], extraTags: string[] = []): string[] {
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
  for (const tag of extraTags) {
    if (!PRESET_SLUGS.has(tag) && !seen.has(tag.toLowerCase())) {
      seen.set(tag.toLowerCase(), tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Sorted, deduped tag slugs in use across `timestamps` (a single match's
 * notes) — the note-tag filter chip row's option list (retest fix-up #12,
 * "filter notes by tag"). Presets AND custom tags are both included (unlike
 * `deriveCustomTagVocabulary`, which deliberately EXCLUDES presets for the
 * add-combobox's "custom tags" grouping) since every tag actually applied to
 * a note should be filterable.
 */
export function deriveNoteTagOptions(timestamps: VodTimestamp[]): string[] {
  const seen = new Set<string>();
  for (const stamp of timestamps) {
    for (const tag of stamp.tags ?? []) {
      seen.add(tag);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Returns the indices (into `timestamps`, UNCHANGED — never re-indexed) of
 * notes matching ANY tag in `selectedTags` (OR semantics) — every index when
 * `selectedTags` is empty (no filter narrowing). Shared by
 * `VodManagerPage`'s Prev/Next timestamp navigation and `TimestampList`'s
 * row visibility (retest fix-up #12) so both apply IDENTICAL filter
 * semantics and neither accidentally re-indexes the underlying array —
 * edit/delete/seek all target the note's ORIGINAL position in the full
 * `vodTimestamps` array.
 */
export function filterTimestampIndices(
  timestamps: VodTimestamp[],
  selectedTags: string[],
): number[] {
  if (selectedTags.length === 0) {
    return timestamps.map((_, i) => i);
  }
  return timestamps
    .map((stamp, i) => ({ stamp, i }))
    .filter(({ stamp }) => (stamp.tags ?? []).some((tag) => selectedTags.includes(tag)))
    .map(({ i }) => i);
}

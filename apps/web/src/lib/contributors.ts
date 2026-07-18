/**
 * Sentinel contributor key for an owner-authored note (no `coach`
 * attribution). Distinct from any real coach display name — display names
 * are trimmed and at least 1 character (`coachAttributionSchema`), never
 * this bracketed value.
 */
export const OWNER_CONTRIBUTOR_KEY = '__owner__';

/**
 * Minimal note shape the contributor helpers operate on — deliberately NOT
 * `VodTimestamp`/`SessionTimestamp` (keeps this lib page-agnostic; both
 * shapes structurally satisfy it, including `VodTimestamp.coach`'s extra
 * `sessionId` field).
 */
type ContributorNote = { coach?: { displayName: string } | null };

/**
 * The contributor key for a single note: the owner sentinel for an
 * owner-authored note (no `coach`, or `coach: null`), else the coach's
 * display name verbatim (casing preserved).
 */
export function contributorKeyOf(note: ContributorNote): string {
  const displayName = note.coach?.displayName;
  return typeof displayName === 'string' && displayName.length > 0
    ? displayName
    : OWNER_CONTRIBUTOR_KEY;
}

/**
 * Distinct contributor keys across `notes`, in stable display order: the
 * owner sentinel first (only when at least one owner note exists), then
 * coach display names case-insensitively deduped (first-seen casing wins)
 * and sorted by `localeCompare`. Mirrors `deriveNoteTagOptions`'s
 * Set/Map-dedupe shape (`lib/tags.ts`).
 */
export function deriveContributorKeys(notes: ContributorNote[]): string[] {
  let hasOwner = false;
  const coaches = new Map<string, string>();
  for (const note of notes) {
    const key = contributorKeyOf(note);
    if (key === OWNER_CONTRIBUTOR_KEY) {
      hasOwner = true;
      continue;
    }
    const lower = key.toLowerCase();
    if (!coaches.has(lower)) {
      coaches.set(lower, key);
    }
  }
  const sortedCoaches = [...coaches.values()].sort((a, b) => a.localeCompare(b));
  return hasOwner ? [OWNER_CONTRIBUTOR_KEY, ...sortedCoaches] : sortedCoaches;
}

/**
 * Returns the indices (into `notes`, UNCHANGED — never re-indexed) matching
 * `selectedKey`: every index when `selectedKey` is `null` (no filter
 * narrowing), otherwise the indices whose `contributorKeyOf(note)` matches
 * `selectedKey` CASE-INSENSITIVELY (a coach-name casing variance can't drop
 * a note from a selected group). Mirrors `filterTimestampIndices`'s
 * index-preserving contract (`lib/tags.ts`) — callers rely on original
 * positions for edit/delete/seek targeting.
 */
export function filterContributorIndices(
  notes: ContributorNote[],
  selectedKey: string | null,
): number[] {
  if (selectedKey == null) {
    return notes.map((_, i) => i);
  }
  const lowerSelected = selectedKey.toLowerCase();
  return notes
    .map((note, i) => ({ note, i }))
    .filter(({ note }) => contributorKeyOf(note).toLowerCase() === lowerSelected)
    .map(({ i }) => i);
}

/**
 * Display label for a contributor key: the page-supplied `ownerLabel` for
 * the owner sentinel, else the key (a coach display name) unchanged. The
 * caller supplies its own owner label ("You" on the owner page, the shared
 * owner display name / a generic "Owner" on the share page) so this lib
 * stays i18n-free.
 */
export function contributorLabel(key: string, ownerLabel: string): string {
  return key === OWNER_CONTRIBUTOR_KEY ? ownerLabel : key;
}

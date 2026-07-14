import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { VodTimestamp } from '@smash-tracker/shared';
import { deriveNoteTagOptions, filterTimestampIndices, tagLabel } from '@/lib/tags';
import { Badge } from '@/components/ui/badge';
import { NoteComposer } from './NoteComposer';
import { TimestampRow } from './TimestampRow';

export interface TimestampListProps {
  timestamps: VodTimestamp[];
  /** Index of the last-clicked note, or `null` if none. Fixed to the last
   * click — does NOT track live playback position (D-13/D-14). */
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  /** Seeks the live player (via `VodPlayer`'s `useVodPlayer` instance) —
   * never a navigate-to-URL fallback, per PITFALLS.md Pitfall 1. */
  onSeek: (seconds: number) => void;
  /** Populated by `VodPlayer` with the live player's `getCurrentTime`
   * function, forwarded to the inline `NoteComposer`'s on-focus prefill. */
  getCurrentTimeRef: RefObject<(() => number) | null>;
  /** Fires with the full next `vodTimestamps` array (existing + new,
   * re-sorted ascending) whenever the composer adds a note — the caller
   * owns the single PATCH mutation (`VodManagerPage`). */
  onUpdateTimestamps: (next: VodTimestamp[]) => void;
  /** Custom tag vocabulary derived across ALL loaded VOD matches (03-02
   * locked decision) — forwarded to every row's note-tag add-combobox. */
  tagVocabulary: string[];
  /** Index of the one row (of the whole list) currently in edit mode, or
   * `null` if none — lifted to `VodManagerPage` (controlled, mirroring
   * `selectedIndex`/`onSelect`) so the quick-tag panel can command a
   * freshly-captured row straight into edit mode after its PATCH resolves. */
  editingIndex: number | null;
  onEditingIndexChange: (index: number | null) => void;
  /** Selected note-tag filter slugs (OR semantics, retest fix-up #12,
   * "filter notes by tag") — lifted to `VodManagerPage` (mirrors
   * `editingIndex`) since the Prev/Next TIMESTAMP jump buttons live outside
   * this component and must navigate only the same VISIBLE (filtered) set. */
  noteTagFilter: string[];
  onNoteTagFilterChange: (next: string[]) => void;
}

/**
 * Click-to-seek list of the selected match's VOD timestamp notes (PLAY-03),
 * with a persistent inline `NoteComposer` (NOTE-01) rendered above the rows
 * — never a modal. Adapted from `VodNotesDialog`'s timestamp row markup
 * (lines 152-187). Plan 01 shipped add-only; this plan extends each row via
 * `TimestampRow` with in-place edit (NOTE-02) and AlertDialog-confirmed
 * delete (NOTE-03).
 *
 * Invoked by `VodManagerPage`'s detail panel, directly below `VodPlayer`
 * (D-03). Clicking a row body seeks the live player AND highlights the row
 * using the locked D-13 sidebar-active-link tokens (`bg-accent
 * text-accent-foreground` + `border-l-2 border-primary`) — edit/delete never
 * write to `selectedIndex`/`onSelect` (D-13/D-14 preserved).
 *
 * `editingIndex` is a CONTROLLED prop (one row edits at a time — starting a
 * new edit implicitly closes any other open edit), owned by
 * `VodManagerPage` so the quick-tag panel can command a freshly-captured
 * row into edit mode after its PATCH resolves. This component translates
 * each row's commit/delete callback into the next full re-sorted/filtered
 * array, which is the only shape `onUpdateTimestamps` (the caller's single
 * PATCH mutation site) ever receives.
 */
export function TimestampList({
  timestamps,
  selectedIndex,
  onSelect,
  onSeek,
  getCurrentTimeRef,
  onUpdateTimestamps,
  tagVocabulary,
  editingIndex,
  onEditingIndexChange,
  noteTagFilter,
  onNoteTagFilterChange,
}: TimestampListProps) {
  const { t } = useTranslation();

  // Tags in use across THIS match's notes (retest fix-up #12) — the chip
  // row's option list. Hidden entirely when no note has any tag.
  const noteTagOptions = deriveNoteTagOptions(timestamps);
  // Indices (into the FULL, unfiltered `timestamps` array — never
  // re-indexed) of the currently-visible rows. Shared with
  // `VodManagerPage`'s Prev/Next timestamp navigation via the exact same
  // `filterTimestampIndices` helper so both apply identical semantics.
  const visibleIndices = new Set(filterTimestampIndices(timestamps, noteTagFilter));

  function toggleTagFilter(tag: string) {
    const next = noteTagFilter.includes(tag)
      ? noteTagFilter.filter((selected) => selected !== tag)
      : [...noteTagFilter, tag];
    onNoteTagFilterChange(next);
  }

  function handleCommitEdit(index: number, next: VodTimestamp) {
    const updated = timestamps
      .map((stamp, i) => (i === index ? next : stamp))
      .sort((a, b) => a.seconds - b.seconds);
    onUpdateTimestamps(updated);
    onEditingIndexChange(null);
  }

  function handleDelete(index: number) {
    onUpdateTimestamps(timestamps.filter((_, i) => i !== index));
    onEditingIndexChange(editingIndex === index ? null : editingIndex);
  }

  // Tags never affect ordering (only time edits re-sort) — replace element
  // `index`'s tags in place, omitting the `tags` key entirely when the
  // resulting list is empty so RTDB drops it (mirrors the omit-to-clear
  // convention `buildUpdateInput`/`SelectedMatchMeta` already use for
  // match-level tags).
  function handleUpdateTags(index: number, tags: string[]) {
    const updated = timestamps.map((stamp, i) =>
      i === index
        ? { seconds: stamp.seconds, note: stamp.note, ...(tags.length > 0 ? { tags } : {}) }
        : stamp,
    );
    onUpdateTimestamps(updated);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Sticky notes header (retest fix-up #6): stays pinned to the top of
          the nearest scrolling ancestor while the note list below scrolls
          under it. In the compact+lg rail layout that ancestor is the
          `vod-timestamp-rail` wrapper (`overflow-y-auto`, fix-up #7); in
          the stacked layout (fill mode, or below `lg`) there is no internal
          scroll container, so `sticky` falls back to the document/viewport
          scroll instead — the composer stays visible at the top of the
          page as the user scrolls through a long note list either way.
          `bg-background` keeps note rows from visibly scrolling underneath
          it once it's pinned. */}
      <div className="sticky top-0 z-10 bg-background">
        <NoteComposer
          timestamps={timestamps}
          getCurrentTimeRef={getCurrentTimeRef}
          onUpdateTimestamps={onUpdateTimestamps}
        />
      </div>

      {timestamps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('shared.vod.noTimestamps')}</p>
      ) : (
        <>
          {/* Note-tag filter chip row (retest fix-up #12, "filter notes by
              tag") — hidden entirely when no note on this match has any
              tag. Toggling a chip filters visible rows below (OR within
              selected chips); the underlying `timestamps` array is NEVER
              re-sliced — `index` passed to each `TimestampRow` below always
              stays the note's true position, so edit/delete/seek keep
              hitting the correct note regardless of the active filter. */}
          {noteTagOptions.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('vodManager.notes.filterByTag')}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {noteTagOptions.map((tag) => {
                  const label = tagLabel(t, tag);
                  const selected = noteTagFilter.includes(tag);
                  return (
                    <Badge key={tag} asChild variant={selected ? 'default' : 'outline'}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        aria-label={t('vodManager.notes.filterByTagAria', { label })}
                        onClick={() => toggleTagFilter(tag)}
                      >
                        {label}
                      </button>
                    </Badge>
                  );
                })}
              </div>
            </div>
          )}
          {visibleIndices.size === 0 ? (
            <p className="text-sm text-muted-foreground">{t('vodManager.notes.noMatchingNotes')}</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label={t('shared.vod.timestampsAria')}>
              {timestamps.map((stamp, index) => {
                if (!visibleIndices.has(index)) {
                  return null;
                }
                return (
                  <li key={`${stamp.seconds}-${index}`}>
                    <TimestampRow
                      stamp={stamp}
                      index={index}
                      isSelected={index === selectedIndex}
                      isEditing={editingIndex === index}
                      onSeek={onSeek}
                      onSelect={onSelect}
                      onStartEdit={onEditingIndexChange}
                      onCancelEdit={() => onEditingIndexChange(null)}
                      onCommitEdit={handleCommitEdit}
                      onDelete={handleDelete}
                      onUpdateTags={handleUpdateTags}
                      tagVocabulary={tagVocabulary}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

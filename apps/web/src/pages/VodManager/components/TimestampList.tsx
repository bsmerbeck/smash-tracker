import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { VodTimestamp } from '@smash-tracker/shared';
import type { VodTimestampInput } from '@/lib/api';
import { deriveNoteTagOptions, filterTimestampIndices, tagLabel } from '@/lib/tags';
import { Badge } from '@/components/ui/badge';
import { NoteComposer } from './NoteComposer';
import { TimestampRow } from './TimestampRow';

export interface TimestampListProps {
  timestamps: VodTimestamp[];
  /** Stable note id of the last-clicked note, or `null` if none. Fixed to
   * the last click — does NOT track live playback position (D-13/D-14).
   * Id-keyed (never an array index) so a concurrent write reordering the
   * array can never move the highlight to a different note (Pitfall 3). */
  selectedNoteId: string | null;
  onSelect: (id: string) => void;
  /** Seeks the live player (via `VodPlayer`'s `useVodPlayer` instance) —
   * never a navigate-to-URL fallback, per PITFALLS.md Pitfall 1. */
  onSeek: (seconds: number) => void;
  /** Populated by `VodPlayer` with the live player's `getCurrentTime`
   * function, forwarded to the inline `NoteComposer`'s on-focus prefill. */
  getCurrentTimeRef: RefObject<(() => number) | null>;
  /** Fires with the composer's single new `{ seconds, note }` — the caller
   * (`VodManagerPage`) owns the create mutation against the dedicated
   * `POST /api/matches/:id/notes` endpoint (Phase 8). */
  onCreateNote: (input: VodTimestampInput) => void;
  /** Fires with a row's committed `{ seconds, note, tags? }` addressed by
   * stable note id — the caller owns the update-by-id mutation. */
  onCommitEdit: (id: string, next: VodTimestampInput) => void;
  /** Fires with the confirmed-deleted note's stable id — the caller owns
   * the delete-by-id mutation. */
  onDelete: (id: string) => void;
  /** Fires with a note's full next tag list addressed by stable note id —
   * the caller owns the update-by-id mutation (TAG-02). */
  onUpdateTags: (id: string, tags: string[]) => void;
  /** Custom tag vocabulary derived across ALL loaded VOD matches (03-02
   * locked decision) — forwarded to every row's note-tag add-combobox. */
  tagVocabulary: string[];
  /** Stable note id of the one row (of the whole list) currently in edit
   * mode, or `null` if none — lifted to `VodManagerPage` (controlled,
   * mirroring `selectedNoteId`/`onSelect`) so the quick-tag panel can
   * command a freshly-captured row straight into edit mode once its create
   * resolves with the server-assigned id. */
  editingNoteId: string | null;
  onEditingNoteIdChange: (id: string | null) => void;
  /** Selected note-tag filter slugs (OR semantics, retest fix-up #12,
   * "filter notes by tag") — lifted to `VodManagerPage` (mirrors
   * `editingNoteId`) since the Prev/Next TIMESTAMP jump buttons live
   * outside this component and must navigate only the same VISIBLE
   * (filtered) set. */
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
 * `editingNoteId` is a CONTROLLED prop (one row edits at a time — starting
 * a new edit implicitly closes any other open edit), owned by
 * `VodManagerPage` so the quick-tag panel can command a freshly-captured
 * row into edit mode once its create resolves. Every row callback reports
 * the note's stable id (Phase 8) straight through to the caller's per-op
 * mutations — this component never rebuilds a full next array, and never
 * re-sorts (the read normalizer already returns seconds-ascending order).
 */
export function TimestampList({
  timestamps,
  selectedNoteId,
  onSelect,
  onSeek,
  getCurrentTimeRef,
  onCreateNote,
  onCommitEdit,
  onDelete,
  onUpdateTags,
  tagVocabulary,
  editingNoteId,
  onEditingNoteIdChange,
  noteTagFilter,
  onNoteTagFilterChange,
}: TimestampListProps) {
  const { t } = useTranslation();

  // Tags in use across THIS match's notes (retest fix-up #12) — the chip
  // row's option list. Hidden entirely when no note has any tag.
  const noteTagOptions = deriveNoteTagOptions(timestamps);
  // Stable ids of the currently-visible rows. Shared with
  // `VodManagerPage`'s Prev/Next timestamp navigation via the exact same
  // `filterTimestampIndices` helper so both apply identical semantics.
  const visibleIds = new Set(
    filterTimestampIndices(timestamps, noteTagFilter).map((i) => timestamps[i]!.id),
  );

  function toggleTagFilter(tag: string) {
    const next = noteTagFilter.includes(tag)
      ? noteTagFilter.filter((selected) => selected !== tag)
      : [...noteTagFilter, tag];
    onNoteTagFilterChange(next);
  }

  function handleCommitEdit(id: string, next: VodTimestampInput) {
    onCommitEdit(id, next);
    onEditingNoteIdChange(null);
  }

  function handleDelete(id: string) {
    onDelete(id);
    onEditingNoteIdChange(editingNoteId === id ? null : editingNoteId);
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
          onCreateNote={onCreateNote}
        />
      </div>

      {timestamps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('shared.vod.noTimestamps')}</p>
      ) : (
        <>
          {/* Note-tag filter chip row (retest fix-up #12, "filter notes by
              tag") — hidden entirely when no note on this match has any
              tag. Toggling a chip filters visible rows below (OR within
              selected chips); every row is addressed by its stable note id,
              so edit/delete/seek keep hitting the correct note regardless
              of the active filter. */}
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
          {visibleIds.size === 0 ? (
            <p className="text-sm text-muted-foreground">{t('vodManager.notes.noMatchingNotes')}</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label={t('shared.vod.timestampsAria')}>
              {timestamps.map((stamp) => {
                if (!visibleIds.has(stamp.id)) {
                  return null;
                }
                return (
                  <li key={stamp.id}>
                    <TimestampRow
                      stamp={stamp}
                      isSelected={stamp.id === selectedNoteId}
                      isEditing={editingNoteId === stamp.id}
                      onSeek={onSeek}
                      onSelect={onSelect}
                      onStartEdit={onEditingNoteIdChange}
                      onCancelEdit={() => onEditingNoteIdChange(null)}
                      onCommitEdit={handleCommitEdit}
                      onDelete={handleDelete}
                      onUpdateTags={onUpdateTags}
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

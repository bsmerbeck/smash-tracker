import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import type { VodTimestamp } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { formatTimestamp, parseFlexibleTimestamp } from '@/lib/vod';
import {
  MAX_NOTE_TAGS,
  NOTE_PRESET_TAGS,
  addTagToList,
  removeTagFromList,
  tagLabel,
} from '@/lib/tags';
import { TagAddCombobox } from './TagAddCombobox';

/** Order-sensitive array equality — note tags are never reordered by
 * add/remove, so a simple index-wise compare is sufficient (unlike
 * `QuickTagPanel`'s order-insensitive `tagSetsEqual`, which allows a
 * user-driven reorder that doesn't apply here). */
function tagsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/** Removable tag-chip row shared by both the read and edit views (retest
 * fix-up #3: chips were previously only rendered in read mode, so a
 * quick-tag capture's pre-applied tag was invisible the instant its row
 * dropped into edit mode). */
function NoteTagChips({
  t,
  tags,
  vocabulary,
  onAdd,
  onRemove,
}: {
  t: TFunction;
  tags: string[];
  vocabulary: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pl-2">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1">
          {tagLabel(t, tag)}
          <button
            type="button"
            aria-label={t('tags.removeAria', { tag: tagLabel(t, tag) })}
            onClick={() => onRemove(tag)}
            className="-mr-1 rounded-full p-0.5 hover:bg-black/10"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <TagAddCombobox
        presets={NOTE_PRESET_TAGS}
        existingTags={tags}
        vocabulary={vocabulary}
        onAdd={onAdd}
        ariaLabel={t('tags.addAria')}
      />
    </div>
  );
}

export interface TimestampRowProps {
  stamp: VodTimestamp;
  /** This row's position in the CURRENT (already-sorted) `timestamps` array
   * — the identity `TimestampList` uses to target commit/delete. */
  index: number;
  /** Whether this is the last-clicked row (D-13/D-14) — fixed to the last
   * click, unaffected by edit/delete on any row. */
  isSelected: boolean;
  /** Whether THIS row is the one row (of the whole list) currently in edit
   * mode — owned by the parent so only one row edits at a time. */
  isEditing: boolean;
  /** Seeks the live player (never a navigate-to-URL fallback). */
  onSeek: (seconds: number) => void;
  onSelect: (index: number) => void;
  onStartEdit: (index: number) => void;
  onCancelEdit: () => void;
  /** Fires with the validated `{ seconds, note }` once Enter/save commits —
   * the parent builds the next re-sorted array and owns the PATCH. */
  onCommitEdit: (index: number, next: VodTimestamp) => void;
  /** Fires once the AlertDialog confirm is accepted — the parent builds the
   * next filtered array and owns the PATCH. */
  onDelete: (index: number) => void;
  /** Fires with the note's full next tag list (add or remove) — the parent
   * rebuilds the `vodTimestamps` array element and owns the PATCH (TAG-02). */
  onUpdateTags: (index: number, tags: string[]) => void;
  /** Custom tag vocabulary derived across ALL loaded VOD matches (03-02
   * locked decision) — fed into this note's add-combobox "your existing
   * custom tags" group. */
  tagVocabulary: string[];
}

/**
 * One timestamp note row (NOTE-02/NOTE-03). View mode preserves plan 01's
 * click-to-seek + highlight button UNCHANGED; the pencil/trash affordances
 * are siblings that never call `onSeek`/`onSelect` (D-13/D-14). Edit is a
 * from-scratch in-place state machine — no codebase precedent existed for
 * this exact shape (`GspMatchLog` opens a dialog, the wrong interaction
 * here); the icon pairing and inline pencil/check/X idiom mirror
 * `GspHero`'s `EliteThresholdCard`. Delete goes through an `AlertDialog`
 * confirm (copied from `MatchTable`'s shape) before removal — never an
 * immediate delete.
 */
export function TimestampRow({
  stamp,
  index,
  isSelected,
  isEditing,
  onSeek,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onDelete,
  onUpdateTags,
  tagVocabulary,
}: TimestampRowProps) {
  const { t } = useTranslation();
  const [timeInput, setTimeInput] = useState(() => formatTimestamp(stamp.seconds));
  const [noteInput, setNoteInput] = useState(stamp.note);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Retest fix-up #4 ("can't add multiple tags to one note"): `onUpdateTags`
  // PATCHes go through a full server round-trip (no optimistic cache write —
  // see `useUpdateMatch`), so `stamp.tags` (the prop) only reflects the
  // FIRST add of a rapid add-add sequence once its refetch lands. A second
  // add fired before that refetch resolves would otherwise recompute
  // `addTagToList` against the STALE pre-first-add `stamp.tags`, silently
  // dropping the first tag when its own (also-stale-based) PATCH resolves.
  // `pendingTags` tracks the last tag list THIS row itself dispatched —
  // `null` when there is no in-flight write, in which case `stamp.tags` is
  // authoritative. Cleared (falling back to reading props again) once the
  // incoming `stamp.tags` prop actually catches up to match what was last
  // dispatched — the "adjusting state during render" pattern this file
  // already uses for `trackedIsEditing`, not an effect (avoids a flash of
  // stale tags before the effect would fire).
  const [pendingTags, setPendingTags] = useState<string[] | null>(null);
  if (pendingTags !== null && tagsEqual(stamp.tags ?? [], pendingTags)) {
    setPendingTags(null);
  }
  const currentTags = pendingTags ?? stamp.tags ?? [];

  function dispatchTags(next: string[]) {
    setPendingTags(next);
    onUpdateTags(index, next);
  }

  function handleAddTag(tag: string) {
    dispatchTags(addTagToList(currentTags, tag, MAX_NOTE_TAGS));
  }

  function handleRemoveTag(tag: string) {
    dispatchTags(removeTagFromList(currentTags, tag));
  }

  // The row stays mounted across edit/view toggles — re-seed the draft from
  // the current stamp every time it (re-)enters edit mode, not just once.
  // "Adjusting state when a prop changes" (reset during render, not an
  // effect — mirrors `VodManagerPage`'s `trackedMatchId` pattern) so
  // re-opening edit never flashes the previous draft before an effect gets
  // a chance to run.
  const [trackedIsEditing, setTrackedIsEditing] = useState(isEditing);
  if (isEditing !== trackedIsEditing) {
    setTrackedIsEditing(isEditing);
    if (isEditing) {
      setTimeInput(formatTimestamp(stamp.seconds));
      setNoteInput(stamp.note);
      setError(null);
    }
  }

  function commit() {
    const seconds = parseFlexibleTimestamp(timeInput);
    if (seconds == null) {
      setError(t('shared.vod.timeFormatError'));
      return;
    }
    const note = noteInput.trim();
    if (!note) {
      setError(t('shared.vod.noteRequired'));
      return;
    }
    // Preserve this note's existing tags (e.g. the quick-tag panel's
    // pre-tag, or a tag just added while this row was in edit mode via the
    // fix-up #3 chips below) — the time+text edit inputs never touch tags,
    // so committing must carry them through unchanged rather than silently
    // dropping them. Reads `currentTags` (pending-aware, see its doc
    // comment above), not the raw `stamp.tags` prop, so an in-flight tag
    // add isn't lost if its PATCH hasn't refetched yet when Enter commits.
    onCommitEdit(index, {
      seconds,
      note,
      ...(currentTags.length > 0 ? { tags: currentTags } : {}),
    });
  }

  function cancel() {
    setTimeInput(formatTimestamp(stamp.seconds));
    setNoteInput(stamp.note);
    setError(null);
    onCancelEdit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  function confirmDelete() {
    onDelete(index);
    setConfirmingDelete(false);
  }

  if (isEditing) {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border p-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={timeInput}
            onChange={(e) => {
              setTimeInput(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            aria-label={t('vodManager.notes.editTimeAria')}
            className="w-24"
            autoFocus
          />
          <Input
            value={noteInput}
            onChange={(e) => {
              setNoteInput(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            aria-label={t('vodManager.notes.editNoteAria')}
            maxLength={200}
            className="min-w-[10rem] flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t('vodManager.notes.saveEdit')}
            onClick={commit}
          >
            <Check />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t('vodManager.notes.cancelEdit')}
            onClick={cancel}
          >
            <X />
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {/* Retest fix-up #3: tag chips (add/remove) stay visible and
            interactive while this row is in edit mode — previously they
            only rendered in the read-mode branch below, so a freshly
            quick-tag-captured note's tag was invisible the instant its row
            dropped straight into edit mode. Add/remove here go through the
            SAME `dispatchTags`/`onUpdateTags` PATCH site as read mode,
            independent of the time/note draft above — `commit()` reads
            `currentTags` so any tag change made here survives an Enter/Save. */}
        <NoteTagChips
          t={t}
          tags={currentTags}
          vocabulary={tagVocabulary}
          onAdd={handleAddTag}
          onRemove={handleRemoveTag}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            onSeek(stamp.seconds);
            onSelect(index);
          }}
          className={cn(
            'flex flex-1 items-center gap-2 rounded-md border p-2 text-left text-sm',
            isSelected && 'bg-accent text-accent-foreground border-l-2 border-primary',
          )}
        >
          <span className="shrink-0 font-mono">{formatTimestamp(stamp.seconds)}</span>
          <span className="truncate">{stamp.note}</span>
        </button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('shared.vod.editTimestamp', { time: formatTimestamp(stamp.seconds) })}
          onClick={() => onStartEdit(index)}
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('shared.vod.deleteTimestamp', { time: formatTimestamp(stamp.seconds) })}
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 />
        </Button>

        <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('vodManager.notes.deleteConfirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('common.cannotBeUndone')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDelete}>{t('common.remove')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Note-tag chips (TAG-02/TAG-04) — a sibling of the seek button, never
          inside it, so chip/removal/add-combobox clicks never fire
          onSeek/onSelect (D-13/D-14). Sits under the note text so a dense
          row stays scannable. Same `NoteTagChips` component the edit-mode
          branch above renders (retest fix-up #3) — identical markup, one
          definition. */}
      <NoteTagChips
        t={t}
        tags={currentTags}
        vocabulary={tagVocabulary}
        onAdd={handleAddTag}
        onRemove={handleRemoveTag}
      />
    </div>
  );
}

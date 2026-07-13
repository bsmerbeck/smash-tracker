import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
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
import { NOTE_PRESET_TAGS, addTagToList, removeTagFromList, tagLabel } from '@/lib/tags';
import { TagAddCombobox } from './TagAddCombobox';

/** Note-level tags are capped at 5 per note (TAG-04) — keeps a single moment's tags skimmable. */
const MAX_NOTE_TAGS = 5;

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
    // pre-tag) — the time+text edit inputs never touch tags, so committing
    // must carry them through unchanged rather than silently dropping them.
    onCommitEdit(index, {
      seconds,
      note,
      ...(stamp.tags && stamp.tags.length > 0 ? { tags: stamp.tags } : {}),
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
          row stays scannable. */}
      <div className="flex flex-wrap items-center gap-2 pl-2">
        {(stamp.tags ?? []).map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1">
            {tagLabel(t, tag)}
            <button
              type="button"
              aria-label={t('tags.removeAria', { tag: tagLabel(t, tag) })}
              onClick={() => onUpdateTags(index, removeTagFromList(stamp.tags ?? [], tag))}
              className="-mr-1 rounded-full p-0.5 hover:bg-black/10"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <TagAddCombobox
          presets={NOTE_PRESET_TAGS}
          existingTags={stamp.tags ?? []}
          vocabulary={tagVocabulary}
          onAdd={(tag) => onUpdateTags(index, addTagToList(stamp.tags ?? [], tag, MAX_NOTE_TAGS))}
          ariaLabel={t('tags.addAria')}
        />
      </div>
    </div>
  );
}

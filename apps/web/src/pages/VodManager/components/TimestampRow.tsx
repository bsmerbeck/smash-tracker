import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import type { VodTimestamp } from '@smash-tracker/shared';
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
    onCommitEdit(index, { seconds, note });
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
  );
}

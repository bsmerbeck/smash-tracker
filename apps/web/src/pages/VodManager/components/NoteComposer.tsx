import { useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import type { VodTimestamp } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatTimestamp, parseFlexibleTimestamp } from '@/lib/vod';

const MAX_TIMESTAMPS = 20;

export interface NoteComposerProps {
  /** The selected match's current timestamp notes — used only to enforce
   * the 20-note cap and to build the next sorted array; never mutated. */
  timestamps: VodTimestamp[];
  /** Populated by `VodPlayer` with the live player's `getCurrentTime`
   * function once available (mirrors `seekRef`'s plumbing). */
  getCurrentTimeRef: RefObject<(() => number) | null>;
  /** Fires with the full next `vodTimestamps` array (existing + new,
   * re-sorted ascending) — the caller owns the single PATCH mutation. */
  onUpdateTimestamps: (next: VodTimestamp[]) => void;
}

/**
 * Persistent inline "add a timestamp note" composer (NOTE-01), rendered at
 * the top of `TimestampList` directly below the player — never a modal
 * (the phase goal explicitly retires the old `VodNotesDialog` flow here).
 *
 * Ports `VodNotesDialog.handleAddTimestamp`'s parse/cap/sort logic verbatim,
 * swapping the stricter `parseTimestamp` for `parseFlexibleTimestamp` per
 * CONTEXT.md (`1:23:45` / `95` / `1h2m3s` all accepted). Focusing the time
 * input pulls the live position ONCE via `getCurrentTimeRef` — a one-shot
 * read, never polled (D-14 / CONTEXT.md's explicit no-polling constraint).
 * Saving never touches `selectedIndex`/`onSelect` (D-13/D-14 preserved) and
 * never pauses/interrupts playback.
 */
export function NoteComposer({
  timestamps,
  getCurrentTimeRef,
  onUpdateTimestamps,
}: NoteComposerProps) {
  const { t } = useTranslation();
  const [timeInput, setTimeInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);

  function handleTimeFocus() {
    const current = getCurrentTimeRef.current?.();
    if (current != null) {
      setTimeInput(formatTimestamp(current));
    }
  }

  function handleAdd() {
    const seconds = parseFlexibleTimestamp(timeInput);
    if (seconds == null) {
      setTimeError(t('shared.vod.timeFormatError'));
      return;
    }
    const note = noteInput.trim();
    if (!note) {
      setTimeError(t('shared.vod.noteRequired'));
      return;
    }
    if (timestamps.length >= MAX_TIMESTAMPS) {
      setTimeError(t('shared.vod.timestampLimit', { max: MAX_TIMESTAMPS }));
      return;
    }
    onUpdateTimestamps([...timestamps, { seconds, note }].sort((a, b) => a.seconds - b.seconds));
    setTimeInput('');
    setNoteInput('');
    setTimeError(null);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    handleAdd();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        {t('vodManager.composer.title')}
      </span>
      <div className="flex flex-wrap items-start gap-2">
        <Input
          value={timeInput}
          onFocus={handleTimeFocus}
          onChange={(e) => {
            setTimeInput(e.target.value);
            setTimeError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('shared.vod.timePlaceholder')}
          aria-label={t('shared.vod.timeAria')}
          className="w-24"
        />
        <Input
          value={noteInput}
          onChange={(e) => {
            setNoteInput(e.target.value);
            setTimeError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('shared.vod.notePlaceholder')}
          aria-label={t('shared.vod.noteAria')}
          maxLength={200}
          className="min-w-[10rem] flex-1"
        />
        <Button type="button" variant="outline" size="icon-sm" onClick={handleAdd}>
          <Plus />
          <span className="sr-only">{t('shared.vod.addTimestamp')}</span>
        </Button>
      </div>
      {timeError && <p className="text-sm text-destructive">{timeError}</p>}
    </div>
  );
}

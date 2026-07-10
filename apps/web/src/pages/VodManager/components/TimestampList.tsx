import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { VodTimestamp } from '@smash-tracker/shared';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '@/lib/vod';
import { NoteComposer } from './NoteComposer';

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
}

/**
 * Click-to-seek list of the selected match's VOD timestamp notes (PLAY-03),
 * with a persistent inline `NoteComposer` (NOTE-01) rendered above the rows
 * — never a modal. Adapted from `VodNotesDialog`'s timestamp row markup
 * (lines 152-187); add/edit/delete affordances land here across this phase's
 * plans (this plan ships add only).
 *
 * Invoked by `VodManagerPage`'s detail panel, directly below `VodPlayer`
 * (D-03). Clicking a row seeks the live player AND highlights the row using
 * the locked D-13 sidebar-active-link tokens (`bg-accent
 * text-accent-foreground` + `border-l-2 border-primary`) — the composer
 * never writes to `selectedIndex`/`onSelect` (D-13/D-14 preserved).
 */
export function TimestampList({
  timestamps,
  selectedIndex,
  onSelect,
  onSeek,
  getCurrentTimeRef,
  onUpdateTimestamps,
}: TimestampListProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <NoteComposer
        timestamps={timestamps}
        getCurrentTimeRef={getCurrentTimeRef}
        onUpdateTimestamps={onUpdateTimestamps}
      />

      {timestamps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('shared.vod.noTimestamps')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('shared.vod.timestampsAria')}>
          {timestamps.map((stamp, index) => {
            const isSelected = index === selectedIndex;
            return (
              <li key={`${stamp.seconds}-${index}`}>
                <button
                  type="button"
                  onClick={() => {
                    onSeek(stamp.seconds);
                    onSelect(index);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm',
                    isSelected && 'bg-accent text-accent-foreground border-l-2 border-primary',
                  )}
                >
                  <span className="shrink-0 font-mono">{formatTimestamp(stamp.seconds)}</span>
                  <span className="truncate">{stamp.note}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

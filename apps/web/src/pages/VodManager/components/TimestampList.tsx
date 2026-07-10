import { useTranslation } from 'react-i18next';
import type { VodTimestamp } from '@smash-tracker/shared';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '@/lib/vod';

export interface TimestampListProps {
  timestamps: VodTimestamp[];
  /** Index of the last-clicked note, or `null` if none. Fixed to the last
   * click — does NOT track live playback position (D-13/D-14). */
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  /** Seeks the live player (via `VodPlayer`'s `useVodPlayer` instance) —
   * never a navigate-to-URL fallback, per PITFALLS.md Pitfall 1. */
  onSeek: (seconds: number) => void;
}

/**
 * Read-only, click-to-seek list of the selected match's VOD timestamp notes
 * (PLAY-03). Adapted from `VodNotesDialog`'s timestamp row markup (lines
 * 152-187) with the add/delete affordances removed — Phase 1 is watch-only,
 * editing notes stays in `VodNotesDialog` until a later phase.
 *
 * Invoked by `VodManagerPage`'s detail panel, directly below `VodPlayer`
 * (D-03). Clicking a row seeks the live player AND highlights the row using
 * the locked D-13 sidebar-active-link tokens (`bg-accent
 * text-accent-foreground` + `border-l-2 border-primary`).
 */
export function TimestampList({ timestamps, selectedIndex, onSelect, onSeek }: TimestampListProps) {
  const { t } = useTranslation();

  if (timestamps.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('shared.vod.noTimestamps')}</p>;
  }

  return (
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
  );
}

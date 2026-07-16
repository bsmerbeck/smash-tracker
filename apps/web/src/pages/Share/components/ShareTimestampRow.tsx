import { useTranslation } from 'react-i18next';
import type { ShareTimestamp } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '@/lib/vod';
import { tagLabel } from '@/lib/tags';

export interface ShareTimestampRowProps {
  stamp: ShareTimestamp;
  /** Whether this is the row matching the current seek/deep-link position — same visual treatment as the owner's `TimestampRow`. */
  isSelected: boolean;
  /** Seeks the live player to this note's `seconds` — the ONLY interaction this row supports. */
  onSelect: (seconds: number) => void;
}

/**
 * Read-only counterpart to `apps/web/src/pages/VodManager/components/TimestampRow.tsx`
 * for the anonymous share page (VIEW-02). Reuses ONLY that component's
 * highlight visual tokens (`bg-accent text-accent-foreground
 * border-l-2 border-primary`) and general row shape — deliberately has no
 * `onUpdateTimestamps`/`editingIndex`/`onEditingIndexChange`-style props, no
 * `NoteComposer`, and no edit/delete affordances (RESEARCH.md Anti-Pattern:
 * `TimestampList` is inherently editable and must not be reused as-is here).
 */
export function ShareTimestampRow({ stamp, isSelected, onSelect }: ShareTimestampRowProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => onSelect(stamp.seconds)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm',
          isSelected && 'bg-accent text-accent-foreground border-l-2 border-primary',
        )}
      >
        <span className="shrink-0 font-mono">{formatTimestamp(stamp.seconds)}</span>
        <span className="truncate">{stamp.note}</span>
      </button>
      {stamp.tags && stamp.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pl-2">
          {stamp.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tagLabel(t, tag)}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

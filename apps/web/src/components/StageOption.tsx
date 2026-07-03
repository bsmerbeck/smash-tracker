import type { Stage } from '@smash-tracker/shared';
import { cn } from '@/lib/utils';

/**
 * A short (2-3 letter) abbreviation of a stage name for the fallback tile,
 * e.g. "Battlefield" -> "BF", "Final Destination" -> "FD",
 * "Yoshi's Story" -> "YS", "Mementos" -> "MEM" (single-word names take their
 * first 3 letters since there's no second word to initial).
 */
export function stageAbbreviation(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return '??';
  }
  if (words.length === 1) {
    return (words[0] ?? '').slice(0, 3).toUpperCase();
  }
  return words
    .slice(0, 3)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

/**
 * Stage thumbnail (or a styled fallback tile with an abbreviation for stages
 * lacking art) beside the stage name — the legacy stage-picture behavior,
 * modernized. Shared by every stage `<select>` in the app so pickers stay
 * visually consistent.
 */
export function StageOption({ stage, className }: { stage: Stage; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      {stage.url ? (
        <img
          src={stage.url}
          alt=""
          className="h-9 w-16 shrink-0 rounded object-cover"
          loading="lazy"
        />
      ) : (
        <span
          className="flex h-9 w-16 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground"
          aria-hidden="true"
        >
          {stageAbbreviation(stage.name)}
        </span>
      )}
      <span className="truncate">{stage.name}</span>
    </span>
  );
}

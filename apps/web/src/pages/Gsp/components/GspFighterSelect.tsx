import type { Fighter } from '@smash-tracker/shared';
import { cn } from '@/lib/utils';

/**
 * Sprite row fighter selector across the top of the GSP page — every fighter
 * with a GSP-bearing match, plus the user's primary/secondary picks as
 * always-available suggestions (see `getGspFighterOptions`). GSP is tracked
 * per-character, so unlike most of this app's pages the rest of the GSP page
 * is entirely scoped to whichever sprite is active here.
 */
export function GspFighterSelect({
  fighter,
  fighterOptions,
  onChange,
}: {
  fighter: Fighter | undefined;
  fighterOptions: Fighter[];
  onChange: (fighter: Fighter) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2"
      role="group"
      aria-label="Select fighter"
    >
      {fighterOptions.map((option) => {
        const selected = option.id === fighter?.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={selected}
            className={cn(
              'flex flex-col items-center gap-1 rounded-md border px-2 py-1.5 transition-colors',
              selected
                ? 'border-primary bg-primary/10'
                : 'border-transparent hover:border-border hover:bg-accent',
            )}
          >
            <img src={option.url} alt="" className="size-12 object-contain" />
            <span className="max-w-16 truncate text-xs text-muted-foreground">{option.name}</span>
          </button>
        );
      })}
    </div>
  );
}

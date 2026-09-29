import type { TierResolution } from '@smash-tracker/shared';
import { cn } from '@/lib/utils';
import { useTierProvenanceText } from './tierProvenance';

/**
 * The visible sentence naming how a tier was established (UI-SPEC §7.2, DD-02):
 * "Estimated from 1,581 entrants", "Set manually", "Online events aren't
 * estimated". It always accompanies a `TierBadge`, so the basis never rests on
 * a tooltip. One flexible slot: a long de/ja sentence truncates with a `title`
 * and never wraps the row it sits in (E1 long-text).
 */
export function TierProvenanceLine({
  resolution,
  className,
}: {
  resolution: TierResolution;
  className?: string;
}) {
  const text = useTierProvenanceText(resolution);
  if (text == null) {
    return null;
  }
  return (
    <p
      data-slot="tier-provenance"
      className={cn(
        'flex min-w-0 flex-wrap gap-x-2 text-xs leading-4 text-muted-foreground tabular-nums',
        className,
      )}
    >
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
    </p>
  );
}

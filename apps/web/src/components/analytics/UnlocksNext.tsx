import type { ReactNode } from 'react';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { Card } from '@/components/ui/card';

export interface UnlocksNextMeter {
  /** The `body`-role sentence, fully composed by the host. */
  sentence: string;
  have: number;
  need: number;
  /** e.g. "3 of 8 games" — fully composed by the host (Track B rule B1). */
  countLabel: string;
}

/** At most 3 meters (DD-08) — a fourth entry is a TypeScript error. */
export type UnlocksNextMeters =
  | readonly [UnlocksNextMeter]
  | readonly [UnlocksNextMeter, UnlocksNextMeter]
  | readonly [UnlocksNextMeter, UnlocksNextMeter, UnlocksNextMeter];

export interface UnlocksNextProps {
  /** The dashed `ClaimChip` node ("Unlocks next"), built by the host. */
  chip: ReactNode;
  name: string;
  meters: UnlocksNextMeters;
}

/**
 * The single locked card of a rail (DD-08, UI-SPEC §7.8). Renders the
 * dashed claim chip, then at most 3 meters — each a sentence, a 6px
 * progress track (`role="img"`, accessible name = its count label), and
 * the count label itself. No doors, no dismiss.
 */
export function UnlocksNext({ chip, name, meters }: UnlocksNextProps) {
  return (
    <Card data-slot="insight-card" data-card-kind="unlocks-next" className="gap-4 p-5 shadow-none">
      <div className="flex items-center gap-2" data-slot="insight-card-header">
        {chip}
        <span className="truncate text-xs leading-4 text-muted-foreground tabular-nums">
          {name}
        </span>
      </div>

      <div className="flex flex-col gap-3" data-slot="unlocks-next-meters">
        {meters.map((meter, index) => {
          const fillPercent =
            meter.need > 0 ? Math.min(100, Math.round((meter.have / meter.need) * 100)) : 0;
          return (
            <div key={index} className="flex flex-col gap-1.5" data-slot="unlocks-next-meter">
              <p className="text-sm leading-5">{meter.sentence}</p>
              <div
                role="img"
                aria-label={meter.countLabel}
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${fillPercent}%`, backgroundColor: CHART_TOKENS.steady }}
                />
              </div>
              <p className="text-xs leading-4 text-muted-foreground tabular-nums">
                {meter.countLabel}
              </p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

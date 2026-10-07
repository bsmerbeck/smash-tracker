import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface SegmentedControlOption {
  value: string;
  /** The full label — always the option's accessible name. */
  label: string;
  /** Shown instead of `label` below 640px; the accessible name stays the full label. */
  shortLabel?: string;
  /** Not choosable right now: `aria-disabled`, its reason in a tooltip, nothing changes when activated. */
  unavailable?: boolean;
  /** The tooltip text for an unavailable option. Absent: the option is guarded but no tooltip mounts. */
  unavailableReason?: string;
  /** Extra classes for this option's item (e.g. a host's dimming of an inert option); the primitive adds none for `unavailable`. */
  className?: string;
}

export interface SegmentedControlProps {
  /** The group's accessible name (`aria-label`) when no visible element names it. */
  label?: string;
  /** The id of a visible element that names the group (wins over `label`). */
  ariaLabelledBy?: string;
  value: string;
  onChange: (next: string) => void;
  options: readonly SegmentedControlOption[];
  className?: string;
}

/**
 * Plan 39.1-47 (PD-47-1, sketch 003 B `.seg`): the ONE segmented single-choice
 * control — extracted from `HorizonSwitch`'s own markup so the page horizon
 * switch and the Counterpick Advisor's Phase / Role controls render through
 * one implementation (a second `ToggleGroup` copy under `components/analytics`
 * or `pages/Matchups` fails `designFidelity.test.ts`).
 *
 * It composes the installed `ToggleGroup` in `single` mode, which Radix
 * renders with `role="radiogroup"` / per-item `role="radio"`, roving-focus
 * arrow keys and Space-to-select. It holds NO selected state — the value is
 * always the prop. Exactly one option is pressed (the muted fill plus the
 * primary-colour bottom accent). An unavailable option is not a real
 * `disabled` button (that would block the tooltip's hover / focus trigger):
 * it is `aria-disabled`, and the guard lives in `handleValueChange`.
 *
 * Below 640px the group is full width with content-sized segments
 * (`flex-auto`, never wrapping — UAT 39.1-22: a long short label such as fr
 * 'Dernier événement' takes the shorter segments' slack instead of
 * overflowing an equal third) and each option shows its short label; the accessible name is pinned to the FULL label on
 * the item (both visible spans are `aria-hidden`, because a CSS-only
 * `sm:hidden` toggle is invisible to jsdom's accname computation and both
 * spans would otherwise contribute their text at once).
 */
export function SegmentedControl({
  label,
  ariaLabelledBy,
  value,
  onChange,
  options,
  className,
}: SegmentedControlProps) {
  function handleValueChange(next: string): void {
    // A deselect activation reports '' (Radix's single-mode "no value"
    // signal) — ignored, one value is always selected.
    if (!next) return;
    const option = options.find((candidate) => candidate.value === next);
    if (!option || option.unavailable) return;
    onChange(next);
  }

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={handleValueChange}
      aria-label={ariaLabelledBy ? undefined : label}
      aria-labelledby={ariaLabelledBy}
      className={cn('w-full rounded-md border bg-card p-0.5 sm:w-fit', className)}
    >
      {options.map((option) => {
        const isSelected = value === option.value;
        const isUnavailable = option.unavailable === true;

        const item = (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.label}
            aria-disabled={isUnavailable || undefined}
            className={cn(
              'relative h-8 flex-auto whitespace-nowrap px-3 text-sm data-[state=on]:bg-muted data-[state=on]:text-foreground sm:flex-none',
              option.className,
            )}
          >
            {option.shortLabel ? (
              <>
                <span aria-hidden="true" className="sm:hidden">
                  {option.shortLabel}
                </span>
                <span aria-hidden="true" className="hidden sm:inline">
                  {option.label}
                </span>
              </>
            ) : (
              <span aria-hidden="true">{option.label}</span>
            )}
            {isSelected && (
              <span
                aria-hidden="true"
                data-slot="segmented-control-accent"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary transition-opacity duration-[120ms] motion-reduce:transition-none"
              />
            )}
          </ToggleGroupItem>
        );

        if (!isUnavailable || !option.unavailableReason) {
          return item;
        }

        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>{item}</TooltipTrigger>
            <TooltipContent>{option.unavailableReason}</TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey } from '@smash-tracker/shared';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useHorizon } from '@/hooks/useHorizon';
import { cn } from '@/lib/utils';

/**
 * D-06: the three choices, in the FIXED declared order — a literal tuple,
 * never derived from object-key iteration (not a stable ordering
 * guarantee for this shape) and never re-orderable by a stored value.
 */
const HORIZON_ORDER: readonly HorizonKey[] = ['last30', 'lastEvent', 'last90'];

export interface HorizonSwitchProps {
  className?: string;
}

/**
 * Plan 39.1-12 (INS-02, D-06, UI-SPEC §7.7): the ONE page-level horizon
 * control — never a per-chart twin (verified by a grep gate under
 * `components/charts/` at the plan-verification level, mirrored inline by
 * this file's own test). Composes the installed `ToggleGroup` in `single`
 * mode, which Radix already renders with `role="radiogroup"` / per-item
 * `role="radio"`, roving-focus arrow-key navigation, and Space-to-select —
 * no custom keyboard handling needed here.
 *
 * Reads `useHorizon` directly and holds NO local selected state — a second
 * copy of "which horizon is selected" here could drift from the hook's own
 * resolution (e.g. the lastEvent-unavailable fallback).
 *
 * Reading `insights.horizon.*` here is correct even though this file lives
 * in `components/analytics/` alongside plans 39.1-06/07's primitives: their
 * "no i18n key" rule is a per-file contract on the files THEY create, not a
 * directory-wide guard (review finding C1-L6) — this is the first Track C
 * component placed in this directory, and it is meant to read i18n.
 */
export function HorizonSwitch({ className }: HorizonSwitchProps) {
  const { t } = useTranslation();
  const { horizon, setHorizon, isLastEventAvailable } = useHorizon();
  const labelId = useId();

  function handleValueChange(next: string): void {
    // A deselect activation reports '' (Radix's single-mode "no value"
    // signal) — ignored, one value is always selected.
    if (!next) return;
    const nextHorizon = next as HorizonKey;
    // The disabled option is not made a real `disabled` button (that would
    // block the tooltip's hover/focus trigger) — the guard lives here
    // instead, so clicking or space-selecting it while unavailable performs
    // no write, matching `useHorizon`'s own read-side fallback.
    if (nextHorizon === 'lastEvent' && !isLastEventAvailable) return;
    setHorizon(nextHorizon);
  }

  return (
    <div
      data-slot="horizon-switch"
      data-horizon={horizon}
      className={cn('flex w-full flex-col items-start gap-1 sm:w-fit sm:items-end', className)}
    >
      <span
        id={labelId}
        className="text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase"
      >
        {t('insights.horizon.label')}
      </span>
      <ToggleGroup
        type="single"
        value={horizon}
        onValueChange={handleValueChange}
        aria-labelledby={labelId}
        className="w-full rounded-md border bg-card p-0.5 sm:w-fit"
      >
        {HORIZON_ORDER.map((key) => {
          const isSelected = horizon === key;
          const isDisabled = key === 'lastEvent' && !isLastEventAvailable;

          const fullLabel = t(`insights.horizon.${key}`);

          const item = (
            <ToggleGroupItem
              key={key}
              value={key}
              // The accessible name is pinned to the FULL label regardless
              // of which of the two CSS-toggled spans below is visually
              // shown at a given viewport width — both spans are marked
              // `aria-hidden` so their text never enters the accname
              // computation (a CSS-only `sm:hidden` toggle is invisible to
              // jsdom/dom-accessibility-api, which never loads the
              // stylesheet, so without this override BOTH spans would
              // contribute their text to the accessible name at once).
              aria-label={fullLabel}
              aria-disabled={isDisabled || undefined}
              className="relative h-8 flex-1 px-3 text-sm data-[state=on]:bg-muted data-[state=on]:text-foreground sm:flex-none"
            >
              <span aria-hidden="true" className="sm:hidden">
                {t(`insights.horizon.short.${key}`)}
              </span>
              <span aria-hidden="true" className="hidden sm:inline">
                {fullLabel}
              </span>
              {isSelected && (
                <span
                  aria-hidden="true"
                  data-slot="horizon-switch-accent"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary transition-opacity duration-[120ms] motion-reduce:transition-none"
                />
              )}
            </ToggleGroupItem>
          );

          if (!isDisabled) {
            return item;
          }

          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>{item}</TooltipTrigger>
              <TooltipContent>{t('insights.horizon.lastEventDisabled')}</TooltipContent>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </div>
  );
}

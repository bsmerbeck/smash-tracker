import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey } from '@smash-tracker/shared';
import {
  SegmentedControl,
  type SegmentedControlOption,
} from '@/components/analytics/SegmentedControl';
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
 * this file's own test). Renders through the one `SegmentedControl` primitive
 * (plan 39.1-47, PD-47-1 — the markup moved there unchanged, so the advisor's
 * Phase / Role controls share it): a Radix single-choice group with
 * `role="radiogroup"` / per-item `role="radio"`, roving-focus arrow keys and
 * Space-to-select, no custom keyboard handling here.
 *
 * Reads `useHorizon` directly and holds NO local selected state — a second
 * copy of "which horizon is selected" here could drift from the hook's own
 * resolution (e.g. the lastEvent-unavailable fallback). Its `useHorizon`
 * call is separate from the host page's; `useHorizon` broadcasts each
 * `setHorizon` to every mounted call on the same subject, so a press here
 * moves the page's figures in the same event (39.1-REVIEW iteration 2 CR-01).
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
    const nextHorizon = next as HorizonKey;
    // The primitive already ignores a deselect ('') and an unavailable option
    // (no `disabled` button — that would block the tooltip's hover / focus
    // trigger); this second guard keeps "no write while last event is
    // unavailable" true at the write site too, matching `useHorizon`'s own
    // read-side fallback.
    if (nextHorizon === 'lastEvent' && !isLastEventAvailable) return;
    setHorizon(nextHorizon);
  }

  const options: SegmentedControlOption[] = HORIZON_ORDER.map((key) => {
    const label = t(`insights.horizon.${key}`);
    const shortLabel = t(`insights.horizon.short.${key}`);
    const unavailable = key === 'lastEvent' && !isLastEventAvailable;
    return { value: key, label, shortLabel, unavailable };
  });
  // Only last event can be unavailable; its reason is the existing tooltip copy.
  const lastEvent = options.find((option) => option.value === 'lastEvent');
  if (lastEvent) lastEvent.unavailableReason = t('insights.horizon.lastEventDisabled');

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
      <SegmentedControl
        ariaLabelledBy={labelId}
        value={horizon}
        onChange={handleValueChange}
        options={options}
      />
    </div>
  );
}

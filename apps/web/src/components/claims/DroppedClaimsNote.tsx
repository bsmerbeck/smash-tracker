import { useTranslation } from 'react-i18next';

/**
 * Phase 39 (plan 39-10, D-07 / UI-SPEC E8): the one-line footer that tells a
 * reader claims were removed from a delivered report or practice plan because
 * they could not be verified. `droppedClaimCount` is the stored count (plan
 * 39-07 on scout reports, 28-06 on practice plans) — rendered as stored,
 * never recomputed.
 *
 * The guard is an EXPLICIT finite-integer check, not a truthiness test: `NaN`
 * is falsy in one direction and prints "NaN claims" in the other, and a
 * fractional or negative count is not a count at all. Absent, null, zero,
 * negative, fractional and non-numeric values all render nothing.
 */
/**
 * Code review IN-04: which sentence the count gets. `report` (the default) is
 * a scout report; `plan` is a claims-era practice plan; `legacyPlan` is a
 * Phase 28 practice plan, whose stored `droppedClaimCount` counts focus-area
 * SECTIONS dropped by 28-06's citation check, not claims.
 */
export type DroppedClaimsNoteVariant = 'report' | 'plan' | 'legacyPlan';

const DROPPED_NOTE_KEY: Record<DroppedClaimsNoteVariant, string> = {
  report: 'reports.droppedClaims',
  plan: 'reports.droppedClaimsPlan',
  legacyPlan: 'reports.droppedPlanSections',
};

export function DroppedClaimsNote({
  count,
  variant = 'report',
}: {
  count: unknown;
  variant?: DroppedClaimsNoteVariant;
}) {
  const { t } = useTranslation();
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    return null;
  }
  return (
    <p className="text-xs text-muted-foreground" data-dropped-claims-note="">
      {t(DROPPED_NOTE_KEY[variant], { count })}
    </p>
  );
}

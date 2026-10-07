/**
 * Post-plan fix (39-10, owner decision 2026-09-25): whether a report job took
 * the viewer's credit, as far as the web can PROVE it. Refund wording on the
 * paid cards ("refunding your credit…", "your credit was refunded", "your
 * credit was returned") renders only for `'charged'`.
 *
 * - The job's own `wasCharged` — the spend fact the API persists at spend
 *   time — decides whenever it is present. It wins over the viewer's CURRENT
 *   free-access status, which can change after the job ran.
 * - A job without it (written before the field existed, or by an API revision
 *   that predates it) falls back to plan 39-10's rule: every spend site sets
 *   `spent = !freeAccess`, so a LOADED credits read decides. Residual, for
 *   those older jobs only: a uid whose free-access status changed since.
 * - Neither known (an older job while the credits read is loading or failed)
 *   is `'unknown'` — the card then says less ("Failed"), never something false.
 */
export type ReportJobCharge = 'charged' | 'notCharged' | 'unknown';

export function resolveReportJobCharge({
  wasCharged,
  freeAccess,
}: {
  wasCharged: boolean | undefined;
  freeAccess: boolean | undefined;
}): ReportJobCharge {
  if (typeof wasCharged === 'boolean') {
    return wasCharged ? 'charged' : 'notCharged';
  }
  if (freeAccess === false) {
    return 'charged';
  }
  if (freeAccess === true) {
    return 'notCharged';
  }
  return 'unknown';
}

/**
 * Which failure badge a `failed`/`refunded` job shows. Each value maps to ONE
 * complete i18n string per card (no concatenated fragments):
 * - `pendingRefund` — charged, refund not yet recorded (`failed`)
 * - `refunded` — charged and refunded (`refunded`)
 * - `noCharge` — never charged ("Failed — no credit was used.")
 * - `chargeUnknown` — cannot tell ("Failed")
 */
export type FailedJobBadgeCopy = 'pendingRefund' | 'refunded' | 'noCharge' | 'chargeUnknown';

export function failedJobBadgeCopy(
  status: 'failed' | 'refunded',
  charge: ReportJobCharge,
): FailedJobBadgeCopy {
  if (charge === 'notCharged') {
    return 'noCharge';
  }
  if (charge === 'unknown') {
    return 'chargeUnknown';
  }
  return status === 'refunded' ? 'refunded' : 'pendingRefund';
}

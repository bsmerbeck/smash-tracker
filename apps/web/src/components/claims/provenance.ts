/**
 * Phase 39 (plan 39-10, RPT-10 / D-08): the ONE provenance predicate every
 * disclosure surface shares — the library row and opened-card legacy badge
 * (`LegacyReportBadge`), the withheld-prose note (`WithheldProseNote`) and the
 * `.md` export's withheld-prose line (`reportToMarkdown`). Pure (no React) so
 * the three cannot disagree, and so the Markdown builder can import it without
 * pulling a component module.
 *
 * The typing is deliberately loose (`unknown`): the predicate must hold for a
 * record in ANY shape RTDB can hand back — a null-stripped field, a string
 * where a number belongs, a half-written validation block.
 */
export interface ProvenanceFields {
  claimSchemaVersion?: unknown;
  validation?: unknown;
}

/**
 * True ONLY when the stored record carries a positive-integer
 * `claimSchemaVersion` AND a `validation` object whose `status` is the
 * validated literal (`'passed'`, `reportValidationSchema`). Everything else —
 * an absent or null version, a string version, a missing or null validation
 * block, a block with no status or an unknown status — returns false, and a
 * false here renders the legacy badge.
 *
 * FAIL CLOSED, on purpose: a half-written record displaying as validated is
 * the ONE mislabel that would defeat this phase's disclosure guarantee, while
 * a validated record wrongly labelled legacy only understates it. Never
 * "simplify" the default in the other direction, and never decide legacy-ness
 * from a timestamp — the ABSENCE of the fields is the signal (D-08).
 */
export function isValidatedRecord(record: ProvenanceFields): boolean {
  const { claimSchemaVersion, validation } = record;
  if (
    typeof claimSchemaVersion !== 'number' ||
    !Number.isInteger(claimSchemaVersion) ||
    claimSchemaVersion < 1
  ) {
    return false;
  }
  if (typeof validation !== 'object' || validation === null) {
    return false;
  }
  return (validation as { status?: unknown }).status === 'passed';
}

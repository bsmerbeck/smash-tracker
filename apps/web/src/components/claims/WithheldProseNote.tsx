import { useTranslation } from 'react-i18next';
import { isValidatedRecord, type ProvenanceFields } from './provenance';

/**
 * Phase 39 (plan 39-10, decision D-20 / review C3-M1): the disclosure that
 * some of a report's commentary was withheld.
 *
 * The owner's decision, in his terms: when the prose check strips a section's
 * commentary, the report is still DELIVERED and still CHARGED as a claims-only
 * report (the engine-authored figures, confidence tiers and actions all stand),
 * and the condition of that decision is that the reader is TOLD. This note is
 * that telling, on the card; `reportToMarkdown` carries the same sentence into
 * the `.md` copy the reader keeps. One sentence saying what happened and why —
 * informative, never an apology or an alarm, and no money vocabulary.
 *
 * Renders only when the stored `strippedSectionCount` (plan 39-06's field,
 * rendered as stored, never recomputed) is a finite integer of at least one —
 * the same explicit guard `DroppedClaimsNote` uses, never a truthiness check,
 * so absent, null, zero, negative, fractional and non-numeric values render
 * nothing and no string can contain `NaN`.
 *
 * A LEGACY record never shows it at any count: a record produced before the
 * app checked prose at all cannot have had any withheld. The legacy test is
 * the shared fail-closed `isValidatedRecord`, not a second local predicate,
 * so this note and the legacy badge can never disagree about a record.
 */
export interface WithheldProseNoteProps extends ProvenanceFields {
  strippedSectionCount: unknown;
}

export function WithheldProseNote({
  strippedSectionCount,
  claimSchemaVersion,
  validation,
}: WithheldProseNoteProps) {
  const { t } = useTranslation();
  if (
    typeof strippedSectionCount !== 'number' ||
    !Number.isInteger(strippedSectionCount) ||
    strippedSectionCount < 1
  ) {
    return null;
  }
  if (!isValidatedRecord({ claimSchemaVersion, validation })) {
    return null;
  }
  return (
    <p className="text-xs text-muted-foreground" data-withheld-prose-note="">
      {t('reports.withheldProse', { count: strippedSectionCount })}
    </p>
  );
}

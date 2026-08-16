import type {
  ResearchEnrichmentFieldCoverage,
  ResearchEnrichmentFieldCoverageCell,
} from '@smash-tracker/shared';

/**
 * Phase 30.3 Gate 5 (web evidence-surfaces worker): the four fields
 * `ResearchEnrichmentFieldCoverage` (`packages/shared/src/researchEnrichment.ts`)
 * rolls up — `DataCoveragePanel`'s field-coverage section iterates this
 * array so its rendered order and its i18n label lookups
 * (`enrichment.coverage.fieldCoverage.fields.<field>`) stay driven by ONE
 * list rather than four hand-copied JSX blocks.
 */
export const ENRICHMENT_FIELD_COVERAGE_FIELDS = ['stages', 'characters', 'stocks', 'vods'] as const;
export type EnrichmentFieldCoverageField = (typeof ENRICHMENT_FIELD_COVERAGE_FIELDS)[number];

/**
 * The web-side RENDERING type for one field's coverage cell — every member
 * `DataCoveragePanel`'s field-coverage section actually reads off the
 * shared `ResearchEnrichmentFieldCoverageCell` shape, named identically to
 * the shared shape's own members. Exists as its own named type (rather than
 * re-exporting the shared one directly) so the cross-package contract test
 * (`enrichmentEvidence.test.ts`) has a concrete web-owned target to pin
 * every field name against — if a shared field were ever renamed or
 * dropped, `selectFieldCoverageCell` below fails to type-check before any
 * row could silently go missing from the panel.
 */
export interface RenderableFieldCoverageCell {
  present: number;
  missing: number;
  ambiguous: number;
  latestSourceRevisionId: number | null | undefined;
  latestProjectedAtMs: number | null | undefined;
}

/** Selects one field's cell off a coverage rollup as the rendering shape above — a pure, total function (every `EnrichmentFieldCoverageField` has a corresponding required cell on `ResearchEnrichmentFieldCoverage`). */
export function selectFieldCoverageCell(
  coverage: ResearchEnrichmentFieldCoverage,
  field: EnrichmentFieldCoverageField,
): RenderableFieldCoverageCell {
  const cell: ResearchEnrichmentFieldCoverageCell = coverage[field];
  return {
    present: cell.present,
    missing: cell.missing,
    ambiguous: cell.ambiguous,
    latestSourceRevisionId: cell.latestSourceRevisionId,
    latestProjectedAtMs: cell.latestProjectedAtMs,
  };
}

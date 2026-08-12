/**
 * Phase 30.2 (Liquipedia Stage & VOD Enrichment, ENR-04/ENR-13): the NEUTRAL
 * shared home for the runtime provenance vocabulary — the two dimensions
 * ("who observed this fact" and "what kind of fact is it") that every stored
 * record in this milestone must declare separately, never conflated.
 *
 * This module exists ONLY to break an ESM import cycle (cycle-1 review
 * HIGH 1): the vocabulary is needed by BOTH `researchEnrichment.ts` (the new
 * Liquipedia-sourced stored shapes) and `researchIngestion.ts` (the existing
 * `researchSupplementRecordSchema`, corrected under ENR-13). If the
 * vocabulary lived inside either of those two modules, the other would have
 * to import it from there — and `researchIngestion.ts` also needs to import
 * the enrichment coverage response shape (plan 10), which would close a
 * cycle between two modules whose exports are Zod VALUES, not types. Under a
 * runtime ESM cycle one side observes `undefined` at module-evaluation time,
 * so a schema built from an undefined array throws or silently builds a
 * broken validator. This module has NO sibling imports at all — not even
 * `zod`, matching the plain-vocabulary convention already established by
 * `researchKind.ts` in this package — so it can sit underneath both without
 * ever completing that cycle.
 *
 * Deliberately exports ONLY the two vocabularies and their inferred types —
 * no schemas, no helpers, no re-exports of anything else in this package.
 */

/**
 * The "who observed this fact" dimension. `manual` is a human admin writing
 * a supplement; `liquipedia` is the Liquipedia MediaWiki API. A value can
 * never claim the other origin's authorship — every schema that uses this
 * vocabulary restricts itself to a single literal member of this list
 * (ENR-04's anti-masquerade guarantee).
 */
export const RESEARCH_PROVENANCE_ORIGINS = ['manual', 'liquipedia'] as const;
export type ResearchProvenanceOrigin = (typeof RESEARCH_PROVENANCE_ORIGINS)[number];

/**
 * The "what kind of fact is it" dimension — orthogonal to origin. `note` and
 * `vod-reference` are the two shapes a manual supplement may declare;
 * `stage-observation` is Liquipedia-only. ENR-13 corrects a shipped defect
 * where this dimension was conflated with `sourceKind` (provenance); this
 * vocabulary is the corrected, separated content-type axis.
 */
export const RESEARCH_PROVENANCE_CONTENT_TYPES = [
  'note',
  'vod-reference',
  'stage-observation',
] as const;
export type ResearchProvenanceContentType = (typeof RESEARCH_PROVENANCE_CONTENT_TYPES)[number];

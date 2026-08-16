import type { Database } from 'firebase-admin/database';
import type { ResearchCoverageResponse } from '@smash-tracker/shared';
import { readIdentityMapping } from './ingestion/identity.js';
import { readActiveBackfillRun } from './ingestion/backfillRun.js';
import { buildCoverageResponse, readCoverageSnapshot } from './ingestion/rollup.js';
import { composeEnrichmentCoverageResponse } from './enrichment/rollup.js';

/**
 * Phase 30.1 Plan 05 (WKSP-01A, review C3-L1): the shared coverage composer,
 * extracted verbatim from `routes/research.ts`'s former local closure so it
 * can be called by BOTH the admin research route
 * (`/research/tenants/:tenantId/coverage`, unchanged behavior) and the new
 * self-only `GET /api/users/me/coverage` (T-30.1-12).
 *
 * `subjectId` is intentionally a generic subject key — the underlying reads
 * (`readCoverageSnapshot`, `readIdentityMapping`, `readActiveBackfillRun`,
 * `readEnrichmentCoverage`) are keyed by whatever id string they are given
 * (a research tenant id OR an ordinary account uid) and perform no
 * authorization themselves. Callers are responsible for ensuring the
 * `subjectId` they pass in is one the caller is entitled to read — the
 * admin route gates via `requireResearchTenantAdmin`, and the self route
 * passes only `request.uid`, so a caller can never reach another subject's
 * coverage through either call site. This composer's own authorization
 * posture is UNCHANGED by the enrichment read below: it still performs
 * none of its own (Phase 30.2 Plan 10).
 */
export async function composeCoverageResponse(
  database: Database,
  subjectId: string,
): Promise<ResearchCoverageResponse> {
  const [coverage, mapping, activeRun, enrichment] = await Promise.all([
    readCoverageSnapshot(database, subjectId),
    readIdentityMapping(database, subjectId),
    readActiveBackfillRun(database, subjectId),
    // 30.3 Gate 5: the stored snapshot PLUS the read-time-derived
    // present/missing/ambiguous field coverage (stages, characters, stocks,
    // VODs) — one composer, shared with the admin enrichment/coverage route.
    composeEnrichmentCoverageResponse(database, subjectId),
  ]);
  const confirmedPlayerIds = Object.keys(mapping.confirmedPlayerIds ?? {}).sort();
  const unresolvedCandidateCount = Object.keys(mapping.candidates ?? {}).length;
  const response = buildCoverageResponse({
    coverage,
    confirmedPlayerIds,
    unresolvedCandidateCount,
    activeRun,
  });
  // `buildCoverageResponse` (the LOCKED ingestion composer, `./ingestion/
  // rollup.ts`) has no `enrichment` parameter and is never touched by this
  // phase (PATTERNS.md section 5) — the additive member is merged onto its
  // output here instead, conditional-spread so an un-enriched subject's
  // response is byte-identical to what this composer returned before
  // Phase 30.2 (the enrichment member absent, never `null`).
  return {
    ...response,
    ...(enrichment != null ? { enrichment } : {}),
  };
}

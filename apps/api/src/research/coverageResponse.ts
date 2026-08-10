import type { Database } from 'firebase-admin/database';
import type { ResearchCoverageResponse } from '@smash-tracker/shared';
import { readIdentityMapping } from './ingestion/identity.js';
import { readActiveBackfillRun } from './ingestion/backfillRun.js';
import { buildCoverageResponse, readCoverageSnapshot } from './ingestion/rollup.js';

/**
 * Phase 30.1 Plan 05 (WKSP-01A, review C3-L1): the shared coverage composer,
 * extracted verbatim from `routes/research.ts`'s former local closure so it
 * can be called by BOTH the admin research route
 * (`/research/tenants/:tenantId/coverage`, unchanged behavior) and the new
 * self-only `GET /api/users/me/coverage` (T-30.1-12).
 *
 * `subjectId` is intentionally a generic subject key — the underlying reads
 * (`readCoverageSnapshot`, `readIdentityMapping`, `readActiveBackfillRun`)
 * are keyed by whatever id string they are given (a research tenant id OR
 * an ordinary account uid) and perform no authorization themselves. Callers
 * are responsible for ensuring the `subjectId` they pass in is one the
 * caller is entitled to read — the admin route gates via
 * `requireResearchTenantAdmin`, and the self route passes only
 * `request.uid`, so a caller can never reach another subject's coverage
 * through either call site.
 */
export async function composeCoverageResponse(
  database: Database,
  subjectId: string,
): Promise<ResearchCoverageResponse> {
  const [coverage, mapping, activeRun] = await Promise.all([
    readCoverageSnapshot(database, subjectId),
    readIdentityMapping(database, subjectId),
    readActiveBackfillRun(database, subjectId),
  ]);
  const confirmedPlayerIds = Object.keys(mapping.confirmedPlayerIds ?? {}).sort();
  const unresolvedCandidateCount = Object.keys(mapping.candidates ?? {}).length;
  return buildCoverageResponse({
    coverage,
    confirmedPlayerIds,
    unresolvedCandidateCount,
    activeRun,
  });
}

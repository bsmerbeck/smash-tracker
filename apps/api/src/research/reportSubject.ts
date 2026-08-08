import type { Database } from 'firebase-admin/database';
import { CLIENT_SUBJECT_HEADER_PREFIX } from '../coaching/subject.js';
import { isPathSafeTenantId, readSubjectKind } from './subjectKind.js';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, plan 29-11,
 * RTEN-05A/RTEN-04/RTEN-01): the total, never-throwing three-outcome
 * classifier the report route (`apps/api/src/routes/reports.ts`) uses to
 * decide whether a `POST /api/reports` submission must be refused.
 *
 * This module is DELIBERATELY NOT the shared subject preHandler
 * (`apps/api/src/plugins/resolveSubject.ts`/`apps/api/src/coaching/subject.ts`).
 * It resolves NO subject for storage — the report route's evidence,
 * payload, and results stay keyed by the caller's own uid exactly as they
 * are today (D-07). This classifier exists SOLELY to answer one question:
 * must this specific request be refused because it names a research
 * tenant it is a member of? Generalizing the report route's subject model
 * to something a job/result path could be stored under is Phase 32's job
 * (RTEN-05B), not this one's.
 *
 * **Deliberately NOT built on the shared access primitives.**
 * `apps/api/src/research/access.ts`'s `assertTenantAccess`/
 * `resolveTenantAccess` are correct for every OTHER tenant-addressed
 * surface in this codebase, and WRONG here, because both resolve the
 * tenant's KIND before membership is even a consideration. This route must
 * be indistinguishable from today's behavior for a caller who is NOT a
 * member of the tenant they named — resolving kind first would let any
 * authenticated caller learn whether an arbitrary tenant id is a research
 * tenant by probing this route, which is exactly the enumeration oracle
 * RTEN-01 forbids. Do not "unify" this module with those primitives; the
 * ordering constraint is load-bearing, not an oversight (cycle-2 finding
 * C2-HIGH-5). The one thing this module DOES share with them is plan
 * 29-01's `isPathSafeTenantId` and `readSubjectKind` — reused verbatim,
 * never re-implemented.
 *
 * **Ordering (five steps, load-bearing in two independent ways):**
 * 1. Header absent or `'personal'` -> not-applicable, zero reads.
 * 2. Header lacks the `client:` prefix, or the tenant id is empty ->
 *    not-applicable, zero reads.
 * 3. **Key shape** (cycle-2 finding C2-HIGH-4): the tenant id fails
 *    `isPathSafeTenantId` -> not-applicable, ZERO database references
 *    constructed. This step sits ABOVE membership because both the real
 *    Admin SDK and `FakeDatabase`
 *    (`apps/api/src/test-support/fakeDatabase.ts`) reject RTDB-illegal key
 *    characters SYNCHRONOUSLY at `ref()` construction — validating the
 *    shape before interpolating the id into `clientMembers/{tenantId}/{uid}`
 *    is what keeps a caller-supplied illegal id from throwing (and 500ing
 *    an otherwise-ordinary request) instead of cleanly refusing.
 * 4. **Membership** at `clientMembers/{tenantId}/{uid}` — checked BEFORE
 *    kind, and this ordering relative to step 5 must never be reordered.
 *    Not a member -> not-applicable (today's behavior exactly — the
 *    no-oracle property: a non-member learns nothing about whether the
 *    tenant exists or what kind it is). If the membership READ ITSELF
 *    throws (a genuine infrastructure failure, distinct from a well-formed
 *    id simply having no membership record) -> indeterminate, so the route
 *    refuses rather than silently falling open into a charge.
 * 5. Resolved kind (via `readSubjectKind`, itself total) is `research` ->
 *    research. Resolved kind is `unresolved` -> indeterminate. Resolved
 *    kind is `ordinary` -> not-applicable (an ordinary coach generating a
 *    report from inside a client workspace is unaffected).
 *
 * At most TWO direct-path reads (the membership read, then the kind read
 * inside `readSubjectKind`) — and exactly ZERO for the personal, malformed,
 * and path-illegal cases.
 *
 * Never throws for any input, including a membership read that rejects.
 */

export type ReportSubjectClassification = 'not-applicable' | 'research' | 'indeterminate';

export interface ClassifyReportSubjectOptions {
  database: Database;
  uid: string;
  /** Raw `X-Active-Subject` header value (already flattened from a possible array). */
  header: string | undefined;
}

export async function classifyReportSubject({
  database,
  uid,
  header,
}: ClassifyReportSubjectOptions): Promise<ReportSubjectClassification> {
  // Step 1: absent or personal — zero-read passthrough.
  if (!header || header === 'personal') {
    return 'not-applicable';
  }

  // Step 2: malformed prefix or empty tenant id — never reaches the database.
  if (!header.startsWith(CLIENT_SUBJECT_HEADER_PREFIX)) {
    return 'not-applicable';
  }
  const tenantId = header.slice(CLIENT_SUBJECT_HEADER_PREFIX.length);
  if (!tenantId) {
    return 'not-applicable';
  }

  // Step 3: key-shape guard, strictly BEFORE any reference is constructed —
  // see the module header for why this must precede step 4.
  if (!isPathSafeTenantId(tenantId)) {
    return 'not-applicable';
  }

  // Step 4: membership, checked BEFORE kind (no-oracle — see module header).
  // A rejecting read is classified `indeterminate`, distinct from a
  // well-formed id that simply has no membership record (`not-applicable`).
  let isMember: boolean;
  try {
    const membership = await database.ref(`clientMembers/${tenantId}/${uid}`).get();
    isMember = membership.exists();
  } catch {
    return 'indeterminate';
  }
  if (!isMember) {
    return 'not-applicable';
  }

  // Step 5: kind resolution — `readSubjectKind` is itself total and never
  // throws (it maps every read failure to `'unresolved'`).
  const kind = await readSubjectKind(database, tenantId);
  if (kind === 'research') {
    return 'research';
  }
  if (kind === 'unresolved') {
    return 'indeterminate';
  }
  return 'not-applicable';
}

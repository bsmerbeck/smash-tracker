import type { Database } from 'firebase-admin/database';
import type { ResearchConfig } from '../config/env.js';
import { ForbiddenError } from '../services/rtdb.js';
import { readSubjectKind } from './subjectKind.js';

/**
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-01/RTEN-06):
 * the ONE research authorization decision site in this API (review
 * consensus finding #1; cycle-2 finding C2-HIGH-5). Every tenant-addressed
 * surface — subject resolution, membership gating, listing,
 * archive/delete/export, claim flows, and the research route family —
 * routes through `assertTenantAccess`. A caller that must distinguish
 * `indeterminate` for its OWN error reporting (e.g. plan 29-04's kind
 * endpoint, which must surface an infrastructure failure to an operator)
 * uses `resolveTenantAccess` directly and is responsible for keeping its
 * PUBLIC response indistinguishable from the ordinary denial. Adding a new
 * tenant-addressed surface without calling either of these two functions is
 * what makes removing a uid from `RESEARCH_ADMIN_UIDS` fail to revoke
 * access everywhere — see `29-REVIEWS.md` consensus finding 1.
 *
 * Cycle-2 finding C2-HIGH-5 is why this module exports exactly TWO
 * functions over ONE discriminated result type, rather than three
 * irreconcilable readings (a void-or-throw assertion, a returned
 * resolution, and a "surface as a server error" contract) each plan
 * independently assumed: a total, non-throwing `resolveTenantAccess`
 * returning all four outcomes, and a thin `assertTenantAccess` that returns
 * the permitted kind and throws the shared non-member rejection for both
 * `denied` and `indeterminate`.
 */

/**
 * Four outcomes, distinguished by a single literal tag. `denied` and
 * `indeterminate` are deliberately DIFFERENT outcomes with the SAME public
 * consequence: both MUST present to a caller as the ordinary non-member
 * denial (no-oracle, T-11-07) — they are distinguished only so a caller
 * that needs to report an infrastructure failure to an operator can do so
 * without inventing a second lookup.
 */
export type TenantAccessOutcome =
  { kind: 'ordinary' } | { kind: 'research' } | { kind: 'denied' } | { kind: 'indeterminate' };

export interface TenantAccessInput {
  database: Database;
  /** Config-null fail-closed — see `apps/api/src/config/env.ts`'s `getResearchConfig`. */
  researchConfig: ResearchConfig | null;
  uid: string;
  tenantId: string;
}

/**
 * Total — NEVER throws for any input, because `readSubjectKind` is total
 * and the allowlist membership check is pure. Maps: ordinary resolution ->
 * `ordinary` (existing behavior preserved exactly, for any caller);
 * research resolution -> `research` when `researchConfig` is non-null AND
 * its `adminUids` set contains `uid`, otherwise `denied`; unresolved
 * resolution -> `indeterminate`.
 */
export async function resolveTenantAccess({
  database,
  researchConfig,
  uid,
  tenantId,
}: TenantAccessInput): Promise<TenantAccessOutcome> {
  const resolution = await readSubjectKind(database, tenantId);

  if (resolution === 'ordinary') {
    return { kind: 'ordinary' };
  }
  if (resolution === 'unresolved') {
    return { kind: 'indeterminate' };
  }

  // The only remaining case in the tri-state union is the research
  // resolution. Membership in the allowlist is what turns a research
  // tenant into an authorized `research` outcome; absence (config-null OR
  // uid not in the set) is `denied`, never a silent fallback to `ordinary`.
  if (researchConfig !== null && researchConfig.adminUids.has(uid)) {
    return { kind: 'research' };
  }
  return { kind: 'denied' };
}

/**
 * Thin wrapper over `resolveTenantAccess`: returns the permitted kind for
 * `ordinary`/`research` — a caller gets the server-resolved kind without a
 * second read — and THROWS for BOTH `denied` and `indeterminate`, failing
 * closed on an unreadable tenant record, not only an unauthorized one.
 *
 * The thrown rejection is BYTE-IDENTICAL (same class, same message) to
 * `requireMembership`'s existing non-member rejection
 * (`apps/api/src/coaching/tenants.ts`) for `denied` and `indeterminate`
 * alike, so a demoted research admin, a foreign caller, an unreadable
 * record, and a nonexistent tenant remain indistinguishable (no-oracle,
 * T-11-07).
 */
export async function assertTenantAccess(
  input: TenantAccessInput,
): Promise<'ordinary' | 'research'> {
  const outcome = await resolveTenantAccess(input);
  if (outcome.kind === 'denied' || outcome.kind === 'indeterminate') {
    // Both fail closed with the SAME rejection `requireMembership` throws
    // for a non-member (no-oracle) — never a distinguishable error.
    throw new ForbiddenError('Not a member of this client tenant');
  }
  // TypeScript narrows `outcome.kind` to 'ordinary' | 'research' here —
  // the return type this function promises — without a second literal
  // comparison against the research member.
  return outcome.kind;
}

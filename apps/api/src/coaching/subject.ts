import type { Database } from 'firebase-admin/database';
import type { SubjectKindResolution } from '@smash-tracker/shared';
import type { ResearchConfig } from '../config/env.js';
import { assertTenantAccess } from '../research/access.js';
import { isPathSafeTenantId } from '../research/subjectKind.js';
import { ForbiddenError } from '../services/rtdb.js';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-02): the single
 * server-side authority translating a verified Firebase uid into the
 * "subject" (whose data tree) a request should read/write.
 *
 * `X-Active-Subject` header contract:
 *   - absent, or `'personal'` — zero-read passthrough: `subjectId === uid`.
 *     This is the dominant case (every existing personal-mode user) and
 *     performs no RTDB read at all, so personal behavior is byte-for-byte
 *     unchanged.
 *   - `'client:{tenantId}'` — the caller is requesting to act against a
 *     managed-client tenant. Membership is checked by existence at
 *     `clientMembers/{tenantId}/{uid}` — never trusted from the header
 *     alone. Present → `subjectId = tenantId`. Absent → `ForbiddenError`
 *     (mapped to 403 by the global error handler).
 *   - anything else (malformed: not `'personal'`, no `client:` prefix) —
 *     `ForbiddenError`.
 *
 * Named `Coaching`/`Subject`/`Tenant`, never a bare CamelCase `Coach`-prefixed
 * identifier — this codebase already has an unrelated Phase 8 "coach"
 * concept (an anonymous share-link reviewer's note attribution, gated by a
 * share token — a completely different actor from an authenticated
 * grandfinals.gg coach managing a client tenant). See the phase RESEARCH.md
 * "naming collision" finding for the full rationale.
 *
 * Phase 29 (Research Tenancy, Isolation & Governance Gate, D-07, review
 * consensus finding 1): a client subject header naming a RESEARCH tenant is
 * now gated by the SAME shared primitive every other tenant-addressed
 * surface uses (`assertTenantAccess`) — this was the review's #1 finding:
 * gating only the `/research/*` route family would leave this
 * header-driven path reachable by membership alone, so removing a uid from
 * `RESEARCH_ADMIN_UIDS` would not revoke anything here.
 */
export const CLIENT_SUBJECT_HEADER_PREFIX = 'client:';

export interface ResolveSubjectOptions {
  database: Database;
  uid: string;
  /** Raw `X-Active-Subject` header value (already flattened from a possible array). */
  header: string | undefined;
  /** Config-null fail-closed — see `apps/api/src/config/env.ts`'s `getResearchConfig`. */
  researchConfig: ResearchConfig | null;
}

export interface ResolvedSubject {
  subjectId: string;
  /**
   * `undefined` ONLY for the personal case — see `apps/api/src/plugins/resolveSubject.ts`'s
   * population invariant (cycle-2 finding C2-MED-8): this MUST be assigned
   * explicitly (never left absent) by every caller, so an `undefined` value
   * always means "the subject is personal", never "this route never opted
   * into subject resolution".
   */
  subjectKind: SubjectKindResolution | undefined;
}

/**
 * Full dual-gated subject resolution. Preserves the personal-case zero-read
 * passthrough and the malformed-header rejection exactly (before any read).
 *
 * Cycle-2 finding C2-HIGH-4: the key shape is validated with
 * `isPathSafeTenantId` immediately after the prefix is stripped and BEFORE
 * any `clientMembers` reference is constructed — both the real Admin SDK
 * and `FakeDatabase` reject RTDB-illegal key characters synchronously at
 * `ref()` construction, so validating first is what keeps a caller-supplied
 * illegal id from 500ing an otherwise-ordinary request. Malformed CALLER
 * INPUT is deliberately classified as the SAME client rejection the
 * empty-id case already raises — never reaching the database — while a
 * genuine infrastructure failure (a read that throws) continues to
 * propagate unconverted, as it does today.
 */
export async function resolveSubject({
  database,
  uid,
  header,
  researchConfig,
}: ResolveSubjectOptions): Promise<ResolvedSubject> {
  if (!header || header === 'personal') {
    // Zero-read passthrough — unchanged personal behavior. `subjectKind` is
    // assigned `undefined` EXPLICITLY (own property), never left absent.
    return { subjectId: uid, subjectKind: undefined };
  }

  if (!header.startsWith(CLIENT_SUBJECT_HEADER_PREFIX)) {
    throw new ForbiddenError('Invalid X-Active-Subject header');
  }

  const tenantId = header.slice(CLIENT_SUBJECT_HEADER_PREFIX.length);
  if (!tenantId || !isPathSafeTenantId(tenantId)) {
    // Malformed caller input never reaches the database — classified
    // separately from an infrastructure failure below, which is not
    // converted into a client error.
    throw new ForbiddenError('Invalid X-Active-Subject header');
  }

  const membership = await database.ref(`clientMembers/${tenantId}/${uid}`).get();
  if (!membership.exists()) {
    throw new ForbiddenError('Not a member of this client tenant');
  }

  // Only after membership passes: resolve the kind and apply the research
  // gate through the ONE shared decision site. `assertTenantAccess` returns
  // the permitted kind for `ordinary`/`research` and throws the SAME
  // rejection `requireMembership` raises for both `denied` and
  // `indeterminate` — a demoted research admin, an unreadable tenant
  // record, a foreign coach, and a nonexistent tenant are all
  // indistinguishable here. One read (via `assertTenantAccess` ->
  // `readSubjectKind`) per gated request — never re-read the tenant record
  // a second time, so timing cannot distinguish the cases.
  const kind = await assertTenantAccess({ database, researchConfig, uid, tenantId });

  return { subjectId: tenantId, subjectKind: kind };
}

export interface ResolveSubjectIdOptions {
  database: Database;
  uid: string;
  /** Raw `X-Active-Subject` header value (already flattened from a possible array). */
  header: string | undefined;
  /** Config-null fail-closed — see `apps/api/src/config/env.ts`'s `getResearchConfig`. */
  researchConfig: ResearchConfig | null;
}

/**
 * Thin call into `resolveSubject` returning only the id — kept for callers
 * that only need `subjectId`, with the SAME `Promise<string>` return shape
 * every existing caller already assumes (no shape change). Takes the same
 * `researchConfig` parameter so it cannot be used as a bypass of the
 * research gate `resolveSubject` applies.
 */
export async function resolveSubjectId({
  database,
  uid,
  header,
  researchConfig,
}: ResolveSubjectIdOptions): Promise<string> {
  const { subjectId } = await resolveSubject({ database, uid, header, researchConfig });
  return subjectId;
}

import type { Database } from 'firebase-admin/database';
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
 */
export const CLIENT_SUBJECT_HEADER_PREFIX = 'client:';

export interface ResolveSubjectIdOptions {
  database: Database;
  uid: string;
  /** Raw `X-Active-Subject` header value (already flattened from a possible array). */
  header: string | undefined;
}

export async function resolveSubjectId({
  database,
  uid,
  header,
}: ResolveSubjectIdOptions): Promise<string> {
  if (!header || header === 'personal') {
    return uid; // zero-read passthrough — unchanged personal behavior
  }

  if (!header.startsWith(CLIENT_SUBJECT_HEADER_PREFIX)) {
    throw new ForbiddenError('Invalid X-Active-Subject header');
  }

  const tenantId = header.slice(CLIENT_SUBJECT_HEADER_PREFIX.length);
  if (!tenantId) {
    throw new ForbiddenError('Invalid X-Active-Subject header');
  }

  const membership = await database.ref(`clientMembers/${tenantId}/${uid}`).get();
  if (!membership.exists()) {
    throw new ForbiddenError('Not a member of this client tenant');
  }

  return tenantId;
}

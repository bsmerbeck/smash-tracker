import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  isValidSupplementField,
  RESEARCH_MAX_SUPPLEMENTS_PER_SET,
  researchSupplementRecordSchema,
  type ResearchSourceSetRecord,
  type ResearchSupplementRecord,
  type ResearchSupplementSourceKind,
} from '@smash-tracker/shared';
import { isPathSafeTenantId } from '../subjectKind.js';

/**
 * Phase 30 Plan 04 (ING-08, D-05): the set-scoped supplement store and its
 * explicit sibling overlay reader.
 *
 * This module never mutates a provider record, never writes under the
 * source tier (see `apps/api/src/research/ingestion/identity.ts`'s sibling
 * for the same no-authorization module contract this file copies), performs
 * no authorization of its own (the route layer's `requireResearchTenantAdmin`
 * in `apps/api/src/routes/research.ts` is the single authorization site for
 * this family), and emits nothing.
 *
 * Storage layout: `researchSupplements/{tenantId}/{targetSetId}/{supplementId}`
 * — the target set id is a PATH SEGMENT, never a stored member alone, so a
 * read for one set is bounded to that set's subtree. D-15 forbids a
 * full-scan read; a flat tenant-level list would force one every time a
 * caller wanted one set's supplements.
 */

function supplementsSetRef(database: Database, tenantId: string, targetSetId: string) {
  return database.ref(`researchSupplements/${tenantId}/${targetSetId}`);
}

function supplementRef(
  database: Database,
  tenantId: string,
  targetSetId: string,
  supplementId: string,
) {
  return database.ref(`researchSupplements/${tenantId}/${targetSetId}/${supplementId}`);
}

/**
 * VALIDATES; never sanitizes (review C-H11). Calls the shared
 * `isValidSupplementField` on the RAW field name and returns null
 * immediately when it is false — an invalid name is REJECTED, never
 * rewritten into something usable.
 *
 * The construction is correct for two reasons:
 *
 * 1. The separator is a hyphen, which the field class (letters, digits, and
 *    underscore only — `isValidSupplementField`) cannot contain, and which
 *    neither source-kind member (`manual`, `vod`) contains either. The id
 *    therefore decomposes UNIQUELY — two distinct field names can never
 *    produce the same id. A sanitizing transform, by contrast, could map a
 *    dotted name and its underscore-substituted twin onto the same id, and
 *    the second supplement would silently destroy the first.
 * 2. Rejecting rather than rewriting means an admin who submits an unusable
 *    field name is told so, instead of discovering their note filed under a
 *    name they never chose.
 */
export function buildSupplementId(input: {
  field: string;
  sourceKind: ResearchSupplementSourceKind;
}): string | null {
  if (!isValidSupplementField(input.field)) {
    return null;
  }
  return `${input.sourceKind.toLowerCase()}-${input.field}`;
}

export interface UpsertSupplementInput {
  targetSetId: string;
  field: string;
  value: string;
  sourceKind: ResearchSupplementSourceKind;
  attributedToUid: string;
  note?: string;
  vodUrl?: string;
  vodTimestampSeconds?: number;
  now?: number;
}

/**
 * ENR-13 (Phase 30.2): the single place the `sourceKind` -> `contentType`
 * mapping lives on the WRITE side (its read-side twin is
 * `deriveSupplementProvenance` in `@smash-tracker/shared`) — never an inline
 * conditional at the `upsertSupplement` call site, so there is exactly one
 * definition of the mapping per direction.
 */
function deriveSupplementContentType(
  sourceKind: ResearchSupplementSourceKind,
): 'note' | 'vod-reference' {
  return sourceKind === 'manual' ? 'note' : 'vod-reference';
}

export type UpsertSupplementOutcome =
  'created' | 'replaced' | 'rejected-key' | 'rejected-field' | 'rejected-cap';

export interface UpsertSupplementResult {
  outcome: UpsertSupplementOutcome;
  supplementId: string | null;
}

/**
 * Writes a supplement under the target set's own subtree, stamped with the
 * supplying uid and timestamp. Idempotent per `(sourceKind, field)` pair —
 * upserting the same target set, field, and source kind twice overwrites in
 * place and yields the SAME supplement id; a different source kind for the
 * same field creates a SECOND, separately attributable record.
 */
export async function upsertSupplement(
  database: Database,
  tenantId: string,
  input: UpsertSupplementInput,
): Promise<UpsertSupplementResult> {
  // 1. Guard EVERY path segment BEFORE constructing any reference (review
  // C2-A6) — both FakeDatabase and the real Admin SDK reject an illegal key
  // SYNCHRONOUSLY at `ref()` construction.
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(input.targetSetId)) {
    return { outcome: 'rejected-key', supplementId: null };
  }

  // 2. Validate (never sanitize) the field name.
  const supplementId = buildSupplementId({ field: input.field, sourceKind: input.sourceKind });
  if (supplementId === null) {
    return { outcome: 'rejected-field', supplementId: null };
  }

  // 3. Enforce the per-set count cap (review C2-A2) — a NEW supplement id is
  // rejected once the set already holds `RESEARCH_MAX_SUPPLEMENTS_PER_SET`
  // records; REPLACING an existing id is always allowed, so the cap can
  // never strand an admin editing what they already own. This read-then-
  // write is deliberately NOT a CR-01 transaction: the writers are
  // dual-gated admins acting one at a time, the worst case under a race is
  // one record over the cap, and a transaction over the whole set subtree
  // would rewrite every sibling on every note edit — a cost this bound does
  // not justify.
  const setSnapshot = await supplementsSetRef(database, tenantId, input.targetSetId).get();
  const existingChildren = (setSnapshot.val() as Record<string, unknown> | null) ?? {};
  const isNewId = !(supplementId in existingChildren);
  if (isNewId && Object.keys(existingChildren).length >= RESEARCH_MAX_SUPPLEMENTS_PER_SET) {
    return { outcome: 'rejected-cap', supplementId: null };
  }

  // 4. Conditionally-spread record — optional members absent, never null —
  // parsed through the shared schema before the write so an invalid shape
  // (an over-length value, a non-http VOD URL) fails at the boundary. Touches
  // no path outside `researchSupplements/{tenantId}/{targetSetId}/`.
  const now = input.now ?? Date.now();
  const record = researchSupplementRecordSchema.parse({
    sourceKind: input.sourceKind,
    targetSetId: input.targetSetId,
    field: input.field,
    value: input.value,
    attributedToUid: input.attributedToUid,
    recordedAtMs: now,
    // ENR-13: every NEW record this writer produces carries both provenance
    // dimensions EXPLICITLY, so it is never indistinguishable from a legacy
    // record — a schema that merely PERMITS the two dimensions is not the
    // ENR-13 outcome on its own (cycle-1 review MEDIUM 6).
    sourceOrigin: 'manual',
    contentType: deriveSupplementContentType(input.sourceKind),
    ...(input.note != null ? { note: input.note } : {}),
    ...(input.vodUrl != null ? { vodUrl: input.vodUrl } : {}),
    ...(input.vodTimestampSeconds != null
      ? { vodTimestampSeconds: input.vodTimestampSeconds }
      : {}),
  } satisfies ResearchSupplementRecord);

  await supplementRef(database, tenantId, input.targetSetId, supplementId).set(record);

  return { outcome: isNewId ? 'created' : 'replaced', supplementId };
}

/**
 * Reads the one target-set subtree and safe-parses each child
 * INDEPENDENTLY, skipping any child that fails to parse rather than
 * throwing or discarding the whole set (review C-M5): a single malformed
 * sibling — say one written before a bound was tightened — must not make
 * the other supplements on that set invisible.
 *
 * Guards EVERY path segment before constructing a reference (review C2-A6):
 * on an unsafe `tenantId` or `targetSetId`, returns an empty array and
 * constructs no reference, rather than throwing — both `FakeDatabase`
 * (`apps/api/src/test-support/fakeDatabase.ts:141`) and the real Admin SDK
 * throw SYNCHRONOUSLY at `ref()` construction on an illegal key, so an
 * unguarded segment taken straight from a route parameter would 500 a
 * handler whose family contract is a uniform 404.
 */
export async function listSupplementsForSet(
  database: Database,
  tenantId: string,
  targetSetId: string,
): Promise<ResearchSupplementRecord[]> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(targetSetId)) {
    return [];
  }

  const snapshot = await supplementsSetRef(database, tenantId, targetSetId).get();
  if (!snapshot.exists()) {
    return [];
  }

  const raw = snapshot.val() as Record<string, unknown>;
  return Object.values(raw).flatMap((value) => {
    const parsed = researchSupplementRecordSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Removes exactly one supplement record, leaving the target set's other
 * supplements intact. Guards EVERY path segment before constructing a
 * reference (review C2-A6) — see `listSupplementsForSet`'s doc comment for
 * why this family-wide guard matters.
 */
export async function deleteSupplement(
  database: Database,
  tenantId: string,
  targetSetId: string,
  supplementId: string,
): Promise<{ ok: true }> {
  if (
    !isPathSafeTenantId(tenantId) ||
    !isPathSafeProviderId(targetSetId) ||
    !isPathSafeProviderId(supplementId)
  ) {
    return { ok: true };
  }

  await supplementRef(database, tenantId, targetSetId, supplementId).remove();
  return { ok: true };
}

/**
 * Counts the target set's supplement records. Guards EVERY path segment
 * before constructing a reference (review C2-A6) — see
 * `listSupplementsForSet`'s doc comment for why this family-wide guard
 * matters.
 */
export async function countSupplementsForSet(
  database: Database,
  tenantId: string,
  targetSetId: string,
): Promise<number> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(targetSetId)) {
    return 0;
  }

  const snapshot = await supplementsSetRef(database, tenantId, targetSetId).get();
  if (!snapshot.exists()) {
    return 0;
  }
  return Object.keys(snapshot.val() as Record<string, unknown>).length;
}

export interface ResearchSourceSetOverlay {
  provider: ResearchSourceSetRecord;
  supplemented: Record<
    string,
    {
      value: string;
      sourceKind: ResearchSupplementSourceKind;
      attributedToUid: string;
      recordedAtMs: number;
      note?: string;
      vodUrl?: string;
      vodTimestampSeconds?: number;
    }
  >;
}

/**
 * A PURE function. Its whole point is the shape: the provider record is
 * returned by reference under `provider` with no member added, removed, or
 * changed, and every supplement lands in a SIBLING `supplemented` map keyed
 * by field name. A future reader that wants "the value including
 * supplements" must reach into `supplemented` deliberately and will always
 * see the attribution alongside it.
 *
 * A shallow-merge helper is deliberately NOT provided, because a merged
 * object is exactly the shape in which a supplement could masquerade as a
 * start.gg fact (ING-08) — including when a supplement's field name
 * collides with a provider field: the provider value stays in place under
 * `provider`, and the supplement is exposed only under `supplemented`.
 */
export function overlaySupplements(
  record: ResearchSourceSetRecord,
  supplements: ResearchSupplementRecord[],
): ResearchSourceSetOverlay {
  const supplemented: ResearchSourceSetOverlay['supplemented'] = {};
  for (const supplement of supplements) {
    supplemented[supplement.field] = {
      value: supplement.value,
      sourceKind: supplement.sourceKind,
      attributedToUid: supplement.attributedToUid,
      recordedAtMs: supplement.recordedAtMs,
      ...(supplement.note != null ? { note: supplement.note } : {}),
      ...(supplement.vodUrl != null ? { vodUrl: supplement.vodUrl } : {}),
      ...(supplement.vodTimestampSeconds != null
        ? { vodTimestampSeconds: supplement.vodTimestampSeconds }
        : {}),
    };
  }
  return { provider: record, supplemented };
}

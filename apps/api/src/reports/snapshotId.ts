import { SNAPSHOT_HASH_EXCLUDED_FIELDS, type EvidenceSnapshot } from '@smash-tracker/shared';
import { canonicalDigest } from '../research/registry/canonical.js';

/**
 * Phase 39 (plan 39-06, review C1-B2): the API-side half of the evidence
 * snapshot contract. `packages/shared/src/evidence/snapshot.ts` owns the
 * snapshot's TYPES and id SHAPE (`isSnapshotId`) and deliberately carries no
 * digest — that package is reachable from the browser bundle, where a
 * `node:crypto` import is illegal. The digest lives here, and it REUSES the
 * one canonicalizer this repo has (`research/registry/canonical.ts`) rather
 * than porting it: that module's own head doc comment explains why a second
 * "obviously equivalent" canonicalizer is the hazard, and 39-CONTEXT
 * `<specifics>` names reuse of exactly that module as the decision.
 */

/**
 * Thrown by `normalizeRtdbWriteShape` for an array carrying a `null` (or
 * `undefined`) member, or a member that would itself vanish on write. Real
 * RTDB shreds such an array: the member is deleted, the array reads back
 * SPARSE (a hole) or SHORT (a stripped tail), and the record then fails its
 * own schema on read-back (the 30.2 production defect). This phase never
 * persists one; the normaliser refuses rather than silently reproducing the
 * shred.
 */
export class RtdbInteriorNullArrayError extends Error {
  constructor(readonly path: string) {
    super(
      `normalizeRtdbWriteShape: the array at "${path || '<root>'}" carries a member RTDB would delete (null, undefined, or an empty object/array) — it would read back sparse or short`,
    );
    this.name = 'RtdbInteriorNullArrayError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for the two container shapes RTDB deletes outright on write: `{}` and `[]`. */
function isVanishingContainer(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function normalizeAt(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((member, index) => {
      const memberPath = `${path}[${index}]`;
      if (member === null || member === undefined) {
        throw new RtdbInteriorNullArrayError(path);
      }
      const normalized = normalizeAt(member, memberPath);
      if (isVanishingContainer(normalized)) {
        throw new RtdbInteriorNullArrayError(path);
      }
      return normalized;
    });
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      // Step 1 — the CAUSE: RTDB deletes a null-valued (or, in this
      // codebase's write discipline, never-written undefined) member first.
      if (member === null || member === undefined) {
        continue;
      }
      // Step 2 — recurse first, so a child emptied by ITS OWN members'
      // deletion is seen as empty here...
      const normalized = normalizeAt(member, path ? `${path}.${key}` : key);
      // Step 3 — ...and is itself deleted from this parent. Because every
      // level runs this same check on its already-normalised children, the
      // deletion cascades upward to the first non-empty ancestor.
      if (isVanishingContainer(normalized)) {
        continue;
      }
      result[key] = normalized;
    }
    return result;
  }
  return value;
}

/**
 * Models every RTDB write behaviour this phase depends on (reviews C1-H5 and
 * C2-H1), applied in this order:
 *
 * 1. an object member whose value is `null` or `undefined` is deleted — the
 *    CAUSE: real RTDB deletes the null-valued key first, and the empty
 *    object is what that deletion leaves behind;
 * 2. after recursing, a member that is now an empty object or an empty
 *    array is deleted;
 * 3. the deletion cascades upward — a parent emptied by its own members'
 *    deletion is itself deleted from ITS parent, to the root. A root that
 *    normalises to `{}` is returned as `{}`; the caller reads that as "this
 *    node would not exist";
 * 4. an array carrying a `null`/`undefined` member (or a member that would
 *    vanish) THROWS `RtdbInteriorNullArrayError` instead of silently
 *    reproducing RTDB's sparse/short read-back.
 *
 * A `null`/`undefined` ROOT is returned as `null` (a write of `null` deletes
 * the node). Pure: never mutates its input, returns a new value. The FAKE
 * database (`test-support/fakeDatabase.ts`) simulates only the empty-ARRAY
 * and array-null half of this, which is why the phase's round-trip proofs
 * normalise through THIS function and assert on schema tolerance rather than
 * trusting the double.
 */
export function normalizeRtdbWriteShape(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeAt(value, '');
}

/** Deletes every member named in `excluded` at EVERY object depth (see `snapshotIdFor` for why depth matters). */
function omitFieldsDeep(value: unknown, excluded: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((member) => omitFieldsDeep(member, excluded));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (excluded.has(key)) {
        continue;
      }
      result[key] = omitFieldsDeep(member, excluded);
    }
    return result;
  }
  return value;
}

/**
 * The content address of an evidence snapshot: 64 lowercase hex (sha256),
 * satisfying the shared `isSnapshotId`. NEVER derived from a job id — two
 * jobs over identical evidence share one id, which is what makes the
 * create-if-absent write (plan 39-07) a no-op rather than a rewrite.
 *
 * The hash input is built in three steps:
 *
 * 1. every field named in the shared `SNAPSHOT_HASH_EXCLUDED_FIELDS` is
 *    removed at EVERY depth, not only the top level. `refreshedAt` is the
 *    listed field, and it is wall-clock in more than one place: the
 *    snapshot's own `refreshedAt`, every row's `SampleMeta.refreshedAt`, and
 *    the matchup advisor's claim sample, which stamps `Date.now()` itself
 *    (`packages/shared/src/matchupAdvisor.ts`'s `rankMatchupWithGate`).
 *    Excluding only the top-level field would make two assemblies of
 *    identical evidence content-address differently.
 * 2. the result is passed through `normalizeRtdbWriteShape`. This is
 *    REQUIRED, not optional: `canonicalJson` KEEPS `null` and omits only
 *    `undefined` (read `research/registry/canonical.ts`), so an unnormalised
 *    hash of a row carrying an all-null `subject` (`recent_form`,
 *    `cohort_disclosure`) contains four nulls, while the database's
 *    read-back has no `subject` key at all. Hashing the normalised form is
 *    what makes hash-before-write equal hash-after-read.
 * 3. `canonicalDigest` of that value.
 */
export function snapshotIdFor(snapshot: EvidenceSnapshot): string {
  const excluded = new Set(SNAPSHOT_HASH_EXCLUDED_FIELDS);
  const withoutExcluded = omitFieldsDeep(snapshot, excluded);
  return canonicalDigest(normalizeRtdbWriteShape(withoutExcluded));
}

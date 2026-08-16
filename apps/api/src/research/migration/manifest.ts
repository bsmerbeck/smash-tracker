import type { Database } from 'firebase-admin/database';
import type { ResearchConfig } from '../../config/env.js';
import { archiveClient, TENANT_DELETION_TREES } from '../../coaching/tenants.js';
import { isPathSafeTenantId, readSubjectKind } from '../subjectKind.js';

/**
 * Phase 30.1 Plan 01 (Demo Account Topology & Migration, ACCT-02): the
 * data-plane core of the demo-account migration — a descriptor registry
 * locked against `TENANT_DELETION_TREES` (`apps/api/src/coaching/tenants.ts`),
 * a conflict-aware, depth-correct copy/compare engine, destination preflight,
 * and a non-destructive archive step. This module is fixture-tested only
 * (`manifest.test.ts` against `FakeDatabase`); it is NEVER run against prod
 * here — Plan 04's owner-run CLI is the only caller that ever passes a real
 * `Database`.
 *
 * Cycle-1 review found the previous generic algorithm operated at the wrong
 * record depth for the nested research trees (H1) and could silently clobber
 * a same-key/different-value destination record while a post-write
 * identifier-only compare reported a false positive (H2). Cycle-2 review
 * added two corrections folded in below: `researchEntitlements` is
 * `assert-empty` (NOT `copy`) because it is an authorization-bearing node
 * OUTSIDE the owner-locked migration list — copying it would flip a demo
 * uid's `resolveEntitlement` to `active:true` (C2-H1); and the copy uses a
 * per-record CONDITIONAL `transaction()` rather than an enumerate-then-
 * unconditional-`update()`, closing the write-in-between race (cycle-2
 * MEDIUM).
 */

// ---------------------------------------------------------------------------
// Descriptor registry
// ---------------------------------------------------------------------------

export type TreeShape = 'flat' | 'nested-sets' | 'nested-two-level' | 'singleton';
export type TreeDisposition = 'copy' | 'assert-empty';

export interface CopyTreeDescriptor {
  tree: string;
  disposition: 'copy';
  shape: TreeShape;
}

export interface AssertEmptyTreeDescriptor {
  tree: string;
  disposition: 'assert-empty';
}

export type TreeDescriptor = CopyTreeDescriptor | AssertEmptyTreeDescriptor;

export function isCopyDescriptor(descriptor: TreeDescriptor): descriptor is CopyTreeDescriptor {
  return descriptor.disposition === 'copy';
}

export function isAssertEmptyDescriptor(
  descriptor: TreeDescriptor,
): descriptor is AssertEmptyTreeDescriptor {
  return descriptor.disposition === 'assert-empty';
}

/**
 * One descriptor per member of `TENANT_DELETION_TREES`, matching the
 * disposition table in `30.1-01-PLAN.md` exactly. `copy` is assigned ONLY to
 * the owner-locked data trees (CONTEXT.md): the lossless source layer,
 * legacy match projection, admin-confirmed identity mapping, ingestion-run/
 * cursor state, and completeness coverage. Every other member — including
 * the authorization-bearing `researchEntitlements`, the claim pointer, and
 * every coaching-content tree — is `assert-empty` and forces `runMigration`
 * to refuse if non-empty for the source.
 *
 * Phase 30.2 Plan 01 (ENR-04/ENR-05/ENR-06/ENR-08/ENR-10/ENR-12) adds the six
 * Liquipedia enrichment trees, all `copy`: an `assert-empty` disposition
 * would make any future migration of an already-enriched workspace refuse to
 * run outright, and enrichment attribution must survive migration per
 * ENR-11's minimum coverage list. `researchEnrichmentReceipts` specifically:
 * an attachment that survived migration without its authorising receipt
 * would be un-auditable at the destination and could not be re-verified by
 * the attachment writer's revalidation path — so the receipt travels with
 * its attachment, never left behind.
 */
export const TREE_DESCRIPTORS: readonly TreeDescriptor[] = [
  // -- copy (14): owner-locked data trees + Liquipedia enrichment trees -----
  { tree: 'matches', disposition: 'copy', shape: 'flat' },
  { tree: 'opponents', disposition: 'copy', shape: 'flat' },
  { tree: 'researchSource', disposition: 'copy', shape: 'nested-sets' },
  { tree: 'researchSupplements', disposition: 'copy', shape: 'nested-two-level' },
  { tree: 'researchIdentity', disposition: 'copy', shape: 'singleton' },
  { tree: 'researchIngestionRuns', disposition: 'copy', shape: 'singleton' },
  { tree: 'researchCoverage', disposition: 'copy', shape: 'singleton' },
  { tree: 'researchEnrichmentObservations', disposition: 'copy', shape: 'flat' },
  { tree: 'researchEnrichmentReceipts', disposition: 'copy', shape: 'flat' },
  { tree: 'researchEnrichmentAttachments', disposition: 'copy', shape: 'nested-two-level' },
  { tree: 'researchEnrichmentProjection', disposition: 'copy', shape: 'flat' },
  { tree: 'researchEnrichmentCoverage', disposition: 'copy', shape: 'singleton' },
  { tree: 'researchEnrichmentRuns', disposition: 'copy', shape: 'singleton' },
  // Phase 30.2 Plan 09 (ENR-10, cycle-1 review MEDIUM 8): the shrink-guard
  // review-entry log — diagnostic, but naming the previous/next observation
  // counts a held refresh refused to overwrite is exactly the kind of
  // enrichment provenance ENR-11's minimum coverage list expects to survive
  // migration alongside the rest of this family.
  { tree: 'researchEnrichmentShrinkReviews', disposition: 'copy', shape: 'flat' },
  // Phase 30.3 Gate 5: the admin-reviewed YouTube VOD candidate tree — a
  // `nested-two-level` shape ({targetSetId}/{candidateId}) like the
  // attachment tree it mirrors. `copy`: a confirmed candidate is an
  // explicit admin decision and the provenance behind a projected VOD
  // (the witness's `vodCandidateId` names it), so it must survive
  // migration exactly like the receipts that authorize attachments.
  { tree: 'researchEnrichmentVodCandidates', disposition: 'copy', shape: 'nested-two-level' },
  // -- assert-empty (15): authorization + claim + coaching-content ----------
  // Authorization-bearing — OUTSIDE the owner-locked migration list. A live
  // grant refuses the run and escalates a separate revoke/disposition
  // decision to the owner (review C2-H1); NEVER copied onto a demo uid.
  { tree: 'researchEntitlements', disposition: 'assert-empty' },
  // Claim topology — partial claim topology is never copied (review MEDIUM #3).
  { tree: 'activeClaimInvitationByTenant', disposition: 'assert-empty' },
  // Coaching content — a research tenant never populates these; copying
  // unexpected content would reintroduce unverified topology.
  { tree: 'playlists', disposition: 'assert-empty' },
  { tree: 'opponentAliases', disposition: 'assert-empty' },
  { tree: 'opponentNotes', disposition: 'assert-empty' },
  { tree: 'stageFavorites', disposition: 'assert-empty' },
  { tree: 'primaryFighters', disposition: 'assert-empty' },
  { tree: 'secondaryFighters', disposition: 'assert-empty' },
  { tree: 'reviewDrafts', disposition: 'assert-empty' },
  { tree: 'reviewVersions', disposition: 'assert-empty' },
  { tree: 'reviewVersionIndex', disposition: 'assert-empty' },
  { tree: 'reviewStatus', disposition: 'assert-empty' },
  { tree: 'reviewDeliveries', disposition: 'assert-empty' },
  { tree: 'trainingSessions', disposition: 'assert-empty' },
  { tree: 'sessionDeliveries', disposition: 'assert-empty' },
];

export interface TreeDescriptorLockResult {
  ok: boolean;
  /** A `TENANT_DELETION_TREES` member with no descriptor at all. */
  missingDescriptors: string[];
  /** A descriptor naming a tree that is not a `TENANT_DELETION_TREES` member. */
  unknownDescriptors: string[];
  /** A descriptor whose `disposition` is neither `'copy'` nor `'assert-empty'`. */
  missingDisposition: string[];
}

/**
 * Exported as a standalone pure predicate (never inlined only at module
 * load) so the test suite can drive it against both the real registry AND a
 * deliberately broken fixture array, proving the lock itself fails loudly —
 * not merely that today's registry happens to be complete. Accepts a
 * structurally-typed descriptor (`disposition: string`, not the narrower
 * `TreeDescriptor` union) precisely so a fixture with an unrecognized
 * disposition value type-checks and is caught at RUNTIME by this function,
 * rather than being rejected at compile time before the lock ever runs.
 */
export function checkTreeDescriptorLock(
  descriptors: readonly { tree: string; disposition: string }[],
  deletionTrees: readonly string[],
): TreeDescriptorLockResult {
  const deletionSet = new Set(deletionTrees);
  const descriptorTreeSet = new Set(descriptors.map((d) => d.tree));

  const missingDescriptors = deletionTrees.filter((tree) => !descriptorTreeSet.has(tree));
  const unknownDescriptors = descriptors
    .map((d) => d.tree)
    .filter((tree) => !deletionSet.has(tree));
  const missingDisposition = descriptors
    .filter((d) => d.disposition !== 'copy' && d.disposition !== 'assert-empty')
    .map((d) => d.tree);

  return {
    ok:
      missingDescriptors.length === 0 &&
      unknownDescriptors.length === 0 &&
      missingDisposition.length === 0,
    missingDescriptors,
    unknownDescriptors,
    missingDisposition,
  };
}

/**
 * Module-load-time invariant (review H1): a `TENANT_DELETION_TREES` member
 * added upstream with no descriptor here, or a descriptor naming a
 * non-member, fails loudly at import time rather than being silently
 * mis-copied or missed.
 */
export const TREE_DESCRIPTOR_LOCK: TreeDescriptorLockResult = checkTreeDescriptorLock(
  TREE_DESCRIPTORS,
  TENANT_DELETION_TREES,
);
if (!TREE_DESCRIPTOR_LOCK.ok) {
  throw new Error(
    `TREE_DESCRIPTORS lock violated: missingDescriptors=[${TREE_DESCRIPTOR_LOCK.missingDescriptors.join(
      ', ',
    )}] unknownDescriptors=[${TREE_DESCRIPTOR_LOCK.unknownDescriptors.join(
      ', ',
    )}] missingDisposition=[${TREE_DESCRIPTOR_LOCK.missingDisposition.join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// Value comparison
// ---------------------------------------------------------------------------

/**
 * Deterministic structural deep-equal over plain JSON values — recursive,
 * order-independent object-key comparison, NEVER referential equality. This
 * is the ONE value comparator both `copyTree` and `compareTree` use.
 */
export function recordsDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }
  if (typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    if (!aIsArray || !bIsArray || a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => recordsDeepEqual(value, (b as unknown[])[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every(
    (key, index) => key === bKeys[index] && recordsDeepEqual(aRecord[key], bRecord[key]),
  );
}

// ---------------------------------------------------------------------------
// Record enumeration + destination path construction (depth-correct, H1)
// ---------------------------------------------------------------------------

/** Sentinel record id for a `singleton`-shaped descriptor's one logical record. */
export const SINGLETON_RECORD_ID = '.';

function assertSafeSubjectId(subjectId: string): void {
  if (!isPathSafeTenantId(subjectId)) {
    throw new Error(`Unsafe tenantId/uid: ${subjectId}`);
  }
}

/**
 * Reads a `copy`-descriptor's records at their CORRECT logical-record depth
 * — flat reads immediate children, `nested-sets` reads under the fixed
 * `sets` segment, `nested-two-level` keys by the composite `a/b`, and
 * `singleton` returns the whole node as ONE record keyed by
 * `SINGLETON_RECORD_ID`. Validates `subjectId` with `isPathSafeTenantId`
 * BEFORE any `ref()` is constructed (guard-before-ref).
 */
export async function enumerateRecords(
  database: Database,
  descriptor: CopyTreeDescriptor,
  subjectId: string,
): Promise<Map<string, unknown>> {
  assertSafeSubjectId(subjectId);

  const records = new Map<string, unknown>();

  if (descriptor.shape === 'flat') {
    const snapshot = await database.ref(`${descriptor.tree}/${subjectId}`).get();
    const raw = snapshot.val() as Record<string, unknown> | null;
    if (raw !== null && typeof raw === 'object') {
      for (const [id, value] of Object.entries(raw)) {
        records.set(id, value);
      }
    }
    return records;
  }

  if (descriptor.shape === 'nested-sets') {
    const snapshot = await database.ref(`${descriptor.tree}/${subjectId}/sets`).get();
    const raw = snapshot.val() as Record<string, unknown> | null;
    if (raw !== null && typeof raw === 'object') {
      for (const [id, value] of Object.entries(raw)) {
        records.set(id, value);
      }
    }
    return records;
  }

  if (descriptor.shape === 'nested-two-level') {
    const snapshot = await database.ref(`${descriptor.tree}/${subjectId}`).get();
    const raw = snapshot.val() as Record<string, Record<string, unknown>> | null;
    if (raw !== null && typeof raw === 'object') {
      for (const [a, children] of Object.entries(raw)) {
        if (children === null || typeof children !== 'object') {
          continue;
        }
        for (const [b, value] of Object.entries(children)) {
          records.set(`${a}/${b}`, value);
        }
      }
    }
    return records;
  }

  // singleton
  const snapshot = await database.ref(`${descriptor.tree}/${subjectId}`).get();
  const raw = snapshot.val();
  if (raw !== null && raw !== undefined) {
    records.set(SINGLETON_RECORD_ID, raw);
  }
  return records;
}

/**
 * Builds the destination path for one logical record, reconstructed at the
 * SAME depth `enumerateRecords` reads from. For `nested-two-level`, `id` is
 * already the `a/b` composite — RTDB paths are `/`-delimited, so
 * interpolating it directly produces the correct two-level path without a
 * second split/join step.
 */
function destinationRecordPath(
  descriptor: CopyTreeDescriptor,
  destUid: string,
  id: string,
): string {
  if (descriptor.shape === 'flat') {
    return `${descriptor.tree}/${destUid}/${id}`;
  }
  if (descriptor.shape === 'nested-sets') {
    return `${descriptor.tree}/${destUid}/sets/${id}`;
  }
  if (descriptor.shape === 'nested-two-level') {
    return `${descriptor.tree}/${destUid}/${id}`;
  }
  // singleton — the whole node is the one record; `id` is always
  // SINGLETON_RECORD_ID and carries no path information.
  return `${descriptor.tree}/${destUid}`;
}

// ---------------------------------------------------------------------------
// Copy (conflict-aware, per-record conditional transaction — H2)
// ---------------------------------------------------------------------------

export interface CopyResult {
  tree: string;
  copied: number;
  skipped: number;
  conflicts: string[];
}

/**
 * Enumerates the SOURCE records only, then writes each through its own
 * per-record CONDITIONAL `transaction()` at the destination path (never an
 * unconditional multipath `update()` — that has the enumerate-then-update
 * race, review MEDIUM). Absent at destination -> written (copied++); present
 * and deep-equal -> skipped, NOT rewritten (skipped++); present and
 * different -> recorded in `conflicts` and NEVER written. Because the
 * read-decide-write is one atomic transaction per record, a write that lands
 * between source enumeration and destination commit is seen by the callback
 * and treated as deep-equal-skip or conflict — never clobbered.
 *
 * The transaction callback can be invoked more than once per record (real
 * SDK retries, and `FakeDatabase`'s documented null-first-run emulation) —
 * classification is derived from the RESOLVED `{ committed, snapshot }`
 * result AFTER the transaction settles, never from a closure flag mutated
 * inside the callback (which would double-count under a retry, CR-01). The
 * callback itself decides only "write or abort"; `committed` then tells us
 * whether a write landed, and — on abort — the resolved snapshot (the
 * destination's TRUE current value at settle time) tells us whether that was
 * a deep-equal skip or a same-id/different-value conflict.
 */
export async function copyTree(
  database: Database,
  descriptor: CopyTreeDescriptor,
  sourceId: string,
  destUid: string,
): Promise<CopyResult> {
  assertSafeSubjectId(sourceId);
  assertSafeSubjectId(destUid);

  const sourceRecords = await enumerateRecords(database, descriptor, sourceId);

  let copied = 0;
  let skipped = 0;
  const conflicts: string[] = [];

  for (const [id, sourceValue] of sourceRecords) {
    const path = destinationRecordPath(descriptor, destUid, id);

    const result = await database.ref(path).transaction(
      (current) =>
        current === null || current === undefined
          ? sourceValue // absent — write it
          : undefined, // present — abort (NEVER clobber); classified below
    );

    if (result.committed) {
      copied += 1;
      continue;
    }

    // Aborted — the resolved snapshot is the destination's TRUE current
    // value at settle time (never clobbered by this transaction).
    const currentValue = result.snapshot.val();
    if (recordsDeepEqual(currentValue, sourceValue)) {
      skipped += 1;
    } else {
      conflicts.push(id);
    }
  }

  return { tree: descriptor.tree, copied, skipped, conflicts };
}

// ---------------------------------------------------------------------------
// Compare (count + identifier + deep value — H2)
// ---------------------------------------------------------------------------

export interface CompareResult {
  tree: string;
  sourceCount: number;
  destCount: number;
  missingIds: string[];
  extraIds: string[];
  valueMismatchIds: string[];
  match: boolean;
}

/**
 * Compares source vs destination by logical-record id AND deep value.
 * `match=true` requires equal counts, empty `missingIds`/`extraIds`, and
 * empty `valueMismatchIds` — counts+keys alone can never pass (review H2).
 */
export async function compareTree(
  database: Database,
  descriptor: CopyTreeDescriptor,
  sourceId: string,
  destUid: string,
): Promise<CompareResult> {
  const [sourceRecords, destRecords] = await Promise.all([
    enumerateRecords(database, descriptor, sourceId),
    enumerateRecords(database, descriptor, destUid),
  ]);

  const missingIds: string[] = [];
  const valueMismatchIds: string[] = [];
  for (const [id, sourceValue] of sourceRecords) {
    if (!destRecords.has(id)) {
      missingIds.push(id);
      continue;
    }
    if (!recordsDeepEqual(sourceValue, destRecords.get(id))) {
      valueMismatchIds.push(id);
    }
  }

  const extraIds: string[] = [];
  for (const id of destRecords.keys()) {
    if (!sourceRecords.has(id)) {
      extraIds.push(id);
    }
  }

  const match =
    sourceRecords.size === destRecords.size &&
    missingIds.length === 0 &&
    extraIds.length === 0 &&
    valueMismatchIds.length === 0;

  return {
    tree: descriptor.tree,
    sourceCount: sourceRecords.size,
    destCount: destRecords.size,
    missingIds,
    extraIds,
    valueMismatchIds,
    match,
  };
}

// ---------------------------------------------------------------------------
// assert-empty read
// ---------------------------------------------------------------------------

async function isSourceTreeEmpty(
  database: Database,
  descriptor: AssertEmptyTreeDescriptor,
  sourceId: string,
): Promise<boolean> {
  assertSafeSubjectId(sourceId);
  const snapshot = await database.ref(`${descriptor.tree}/${sourceId}`).get();
  const raw = snapshot.val();
  if (raw === null || raw === undefined) {
    return true;
  }
  if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// runMigration / verifyMigration
// ---------------------------------------------------------------------------

export interface MigrationManifest {
  sourceId: string;
  destUid: string;
  trees: CompareResult[];
  copies: CopyResult[];
  assertEmptyViolations: string[];
  ok: boolean;
}

/**
 * Runs a GLOBAL assert-empty PRE-PASS over every `assert-empty` descriptor
 * for `sourceId` FIRST. If ANY is non-empty, returns `ok=false` with the
 * violations immediately — BEFORE any `copyTree` write executes (review
 * C3-M1). Only when the pre-pass is clean does it iterate the `copy`
 * descriptors, calling `copyTree` then `compareTree` for each.
 */
export async function runMigration(
  database: Database,
  { sourceId, destUid }: { sourceId: string; destUid: string },
): Promise<MigrationManifest> {
  assertSafeSubjectId(sourceId);
  assertSafeSubjectId(destUid);

  const assertEmptyDescriptors = TREE_DESCRIPTORS.filter(isAssertEmptyDescriptor);
  const assertEmptyViolations: string[] = [];
  for (const descriptor of assertEmptyDescriptors) {
    const empty = await isSourceTreeEmpty(database, descriptor, sourceId);
    if (!empty) {
      assertEmptyViolations.push(descriptor.tree);
    }
  }

  if (assertEmptyViolations.length > 0) {
    // Refusal — the destination is GLOBALLY unchanged, not merely missing
    // the offending tree: NO copyTree call has run at all.
    return { sourceId, destUid, trees: [], copies: [], assertEmptyViolations, ok: false };
  }

  const copyDescriptors = TREE_DESCRIPTORS.filter(isCopyDescriptor);
  const copies: CopyResult[] = [];
  const trees: CompareResult[] = [];
  for (const descriptor of copyDescriptors) {
    copies.push(await copyTree(database, descriptor, sourceId, destUid));
    trees.push(await compareTree(database, descriptor, sourceId, destUid));
  }

  const ok = copies.every((copy) => copy.conflicts.length === 0) && trees.every((t) => t.match);

  return { sourceId, destUid, trees, copies, assertEmptyViolations, ok };
}

export interface VerificationResult {
  sourceId: string;
  destUid: string;
  trees: CompareResult[];
  assertEmptyViolations: string[];
  ok: boolean;
}

/**
 * The READ-ONLY half of `runMigration` — re-checks live state against the
 * SAME rules (`compareTree` for every `copy` descriptor, the assert-empty
 * read for every `assert-empty` descriptor) without ever calling `copyTree`
 * or performing a write. This is the primitive Plan 04's `archive`
 * subcommand re-runs against live prod immediately BEFORE `archiveSources`,
 * so a stale or foreign-environment manifest artifact can never authorize an
 * archive of live data that no longer matches (cycle-2 MEDIUM).
 */
export async function verifyMigration(
  database: Database,
  { sourceId, destUid }: { sourceId: string; destUid: string },
): Promise<VerificationResult> {
  assertSafeSubjectId(sourceId);
  assertSafeSubjectId(destUid);

  const assertEmptyDescriptors = TREE_DESCRIPTORS.filter(isAssertEmptyDescriptor);
  const assertEmptyViolations: string[] = [];
  for (const descriptor of assertEmptyDescriptors) {
    const empty = await isSourceTreeEmpty(database, descriptor, sourceId);
    if (!empty) {
      assertEmptyViolations.push(descriptor.tree);
    }
  }

  const copyDescriptors = TREE_DESCRIPTORS.filter(isCopyDescriptor);
  const trees: CompareResult[] = [];
  for (const descriptor of copyDescriptors) {
    trees.push(await compareTree(database, descriptor, sourceId, destUid));
  }

  const ok = assertEmptyViolations.length === 0 && trees.every((t) => t.match);
  return { sourceId, destUid, trees, assertEmptyViolations, ok };
}

// ---------------------------------------------------------------------------
// Destination-uid preflight (MEDIUM #2)
// ---------------------------------------------------------------------------

export interface PreflightResult {
  ok: boolean;
  problems: string[];
}

/**
 * Refuses the migration unless the destination uids are mutually distinct,
 * each has a `users/{uid}` record, each resolves `readSubjectKind === 'ordinary'`
 * (the SAME tri-state resolver `apps/api/src/research/subjectKind.ts` uses
 * everywhere else — never a bespoke check), and none collides with a source
 * tenant id. Accumulates a problem string per failure rather than throwing
 * on the first, so an operator sees every issue in one pass.
 */
export async function preflightDestinations(
  database: Database,
  { destUids, sourceIds }: { destUids: string[]; sourceIds: string[] },
): Promise<PreflightResult> {
  for (const uid of destUids) {
    assertSafeSubjectId(uid);
  }
  for (const id of sourceIds) {
    assertSafeSubjectId(id);
  }

  const problems: string[] = [];
  const sourceSet = new Set(sourceIds);
  const seen = new Set<string>();

  for (const uid of destUids) {
    if (seen.has(uid)) {
      problems.push(`duplicate destination uid: ${uid}`);
    }
    seen.add(uid);

    if (sourceSet.has(uid)) {
      problems.push(`destination uid collides with a source tenant id: ${uid}`);
    }

    const userSnapshot = await database.ref(`users/${uid}`).get();
    if (!userSnapshot.exists()) {
      problems.push(`missing users/${uid} record`);
    }

    const kind = await readSubjectKind(database, uid);
    if (kind !== 'ordinary') {
      problems.push(
        `destination uid ${uid} does not resolve to an ordinary subject (resolved: ${kind})`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Non-destructive archive step
// ---------------------------------------------------------------------------

/**
 * Marks each source tenant archived (soft, reversible — sets `archivedAt`)
 * via the EXISTING `archiveClient` (`apps/api/src/coaching/tenants.ts`),
 * reused verbatim: no new archive code. This function is exported
 * INDEPENDENTLY and is NEVER called from `copyTree`/`runMigration`/
 * `verifyMigration` — copy and archive are distinct steps; archive is gated
 * behind owner sign-off in Plan 04. This module imports ONLY `archiveClient`
 * from `coaching/tenants.ts`; it never imports the irreversible hard-delete
 * cascade sibling (proven by `manifest.test.ts`'s import-absence scan).
 */
export async function archiveSources(
  database: Database,
  coachUid: string,
  tenantIds: string[],
  researchConfig: ResearchConfig | null,
): Promise<void> {
  for (const tenantId of tenantIds) {
    await archiveClient(database, coachUid, tenantId, true, researchConfig);
  }
}

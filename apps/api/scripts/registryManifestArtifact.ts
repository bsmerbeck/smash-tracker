import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tournamentRegistryRowSchema, type TournamentRegistryRow } from '@smash-tracker/shared';
import type { TournamentRegistryPlan } from '../src/research/registry/reconcile.js';

/**
 * Phase 30.3 (Tournament Registry Backfill): the PURE, unit-tested half of
 * the owner-run `deriveTournamentRegistry.ts` CLI — the same split
 * `migrateManifestArtifact.ts` and `enrichManifestArtifact.ts` establish
 * (the CLI shell ends in `void main()` and is never unit-tested; every
 * decision that matters lives here instead).
 *
 * Runtime dependencies are zod + node crypto + the shared row schema ONLY —
 * the plan type is imported `type`-only, so parsing/validating a manifest
 * artifact never pulls in firebase-admin.
 *
 * The artifact is the ONLY thing standing between "owner reviewed the
 * dry-run" and "apply writes the four demo registries", so:
 * - `.strict()` at every object level this module owns (a stray key fails
 *   loudly; the row level reuses the shared contract schema — the single
 *   source of truth — rather than a strictness-duplicating copy).
 * - `contentHash` covers the whole body (database host and uid map
 *   included, mirroring `computeArtifactHash`'s review rationale: a
 *   foreign-env or wrong-map artifact must not pass on matching counts).
 * - `rowSetHash` per account covers the CONTENT identity of the derived
 *   row set — with `provenance.importedAtMs` stripped, because that member
 *   is a first-import stamp resolved at write time (dry-run seeds it with
 *   its own clock for not-yet-existing rows), and hashing it would make an
 *   honest apply/compare spuriously drift from its own reviewed manifest.
 *   The planned ACTION buckets (creates/updates/…) are reviewable plain
 *   fields instead, cross-checked for partition consistency below and
 *   compared bucket-by-bucket at apply time by the CLI.
 */

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const registryWorkspaceKeys = ['hbox', 'mkleo', 'sparg0', 'izaw'] as const;
export type RegistryWorkspaceKey = (typeof registryWorkspaceKeys)[number];
export type RegistryUidMap = Record<RegistryWorkspaceKey, string>;

const uidSchema = z
  .string()
  .min(20)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const uidMapSchema = z
  .object({
    hbox: uidSchema,
    mkleo: uidSchema,
    sparg0: uidSchema,
    izaw: uidSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Canonicalization + hashing
// ---------------------------------------------------------------------------

/** Deterministic canonical JSON: object keys sorted recursively, array order preserved. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A derived row with the write-time-resolved first-import stamp removed — the hashable content identity. */
function stripImportedAtMs(row: TournamentRegistryRow): Omit<
  TournamentRegistryRow,
  'provenance'
> & {
  provenance: Omit<TournamentRegistryRow['provenance'], 'importedAtMs'>;
} {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `importedAtMs` is intentionally discarded
  const { importedAtMs: _importedAtMs, ...provenance } = row.provenance;
  return { ...row, provenance };
}

/**
 * Content identity of one account's derived row set: uid + rows sorted by
 * entryId with `provenance.importedAtMs` stripped. Stable across
 * dry-run/apply/compare for identical source data and identical
 * destination content.
 */
export function computeRegistryRowSetHash(uid: string, rows: TournamentRegistryRow[]): string {
  const canonicalRows = [...rows]
    .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
    .map(stripImportedAtMs);
  return createHash('sha256')
    .update(canonicalize({ uid, rows: canonicalRows }))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const hashHexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const registryAccountManifestSchema = z
  .object({
    label: z.string().min(1),
    uid: uidSchema,
    sourceSetCount: z.number().int().nonnegative(),
    corruptSourceRecords: z.number().int().nonnegative(),
    skippedNoEventId: z.number().int().nonnegative(),
    skippedUnsafeEventId: z.number().int().nonnegative(),
    skippedExcludedClassification: z.number().int().nonnegative(),
    derivedRowCount: z.number().int().nonnegative(),
    creates: z.array(z.string()),
    updates: z.array(z.string()),
    unchanged: z.array(z.string()),
    collisions: z.array(z.string()),
    orphanRemovals: z.array(z.string()),
    preservedForeignCount: z.number().int().nonnegative(),
    /** The full derived rows — the reviewable payload apply would write. */
    rows: z.array(tournamentRegistryRowSchema),
    rowSetHash: hashHexSchema,
  })
  .strict();
export type RegistryAccountManifest = z.infer<typeof registryAccountManifestSchema>;

const manifestBodySchema = z
  .object({
    formatVersion: z.literal(1),
    generatedAtMs: z.number().int().nonnegative(),
    databaseHost: z.string().min(1),
    targetUids: uidMapSchema,
    /** Structural dry-run guarantee: the planner performs no writes. */
    writesPerformed: z.literal(0),
    accounts: z
      .object({
        hbox: registryAccountManifestSchema,
        mkleo: registryAccountManifestSchema,
        sparg0: registryAccountManifestSchema,
        izaw: registryAccountManifestSchema,
      })
      .strict(),
  })
  .strict();
export type RegistryManifestBody = z.infer<typeof manifestBodySchema>;

export const registryManifestSchema = manifestBodySchema.extend({
  contentHash: hashHexSchema,
});
export type RegistryManifest = z.infer<typeof registryManifestSchema>;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Distills one read-only plan into the reviewable per-account manifest —
 * the SAME function the CLI uses at dry-run time and at apply-preflight
 * time, so the drift check compares like with like.
 */
export function buildRegistryAccountManifest(
  label: string,
  plan: TournamentRegistryPlan,
): RegistryAccountManifest {
  return registryAccountManifestSchema.parse({
    label,
    uid: plan.uid,
    sourceSetCount: plan.sourceSetCount,
    corruptSourceRecords: plan.corruptSourceRecords,
    skippedNoEventId: plan.skippedNoEventId,
    skippedUnsafeEventId: plan.skippedUnsafeEventId,
    skippedExcludedClassification: plan.skippedExcludedClassification,
    derivedRowCount: plan.derivedRows.length,
    creates: plan.creates,
    updates: plan.updates,
    unchanged: plan.unchanged,
    collisions: plan.collisions,
    orphanRemovals: plan.orphanRemovals,
    preservedForeignCount: plan.preservedForeignCount,
    rows: plan.derivedRows,
    rowSetHash: computeRegistryRowSetHash(plan.uid, plan.derivedRows),
  });
}

export function computeRegistryManifestHash(body: RegistryManifestBody): string {
  return createHash('sha256')
    .update(canonicalize(manifestBodySchema.parse(body)))
    .digest('hex');
}

export function createRegistryManifest(body: RegistryManifestBody): RegistryManifest {
  const parsed = manifestBodySchema.parse(body);
  return { ...parsed, contentHash: computeRegistryManifestHash(parsed) };
}

// ---------------------------------------------------------------------------
// Validation — the apply/compare gate
// ---------------------------------------------------------------------------

/**
 * Parses and integrity-checks a manifest artifact against the CLI's own
 * uid flags and clock. Throws a descriptive `Error` on the first
 * violation; returns the fully-typed manifest only when every check holds:
 * strict schema, content hash, uid-map equality and uniqueness,
 * staleness bounds, per-account uid match, per-account row-set hash, and
 * bucket-partition consistency (every derived row in exactly one of
 * creates/updates/unchanged/collisions).
 */
export function validateRegistryManifest(
  raw: unknown,
  expectedUids: RegistryUidMap,
  nowMs: number,
  maxAgeMs: number,
): RegistryManifest {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('Manifest max age must be a positive finite number');
  }
  const manifest = registryManifestSchema.parse(raw);
  const { contentHash, ...body } = manifest;
  if (computeRegistryManifestHash(body) !== contentHash) {
    throw new Error('Manifest content hash mismatch');
  }
  const expected = uidMapSchema.parse(expectedUids);
  if (canonicalize(manifest.targetUids) !== canonicalize(expected)) {
    throw new Error('Manifest target UIDs do not match the supplied demo accounts');
  }
  if (new Set(Object.values(expected)).size !== registryWorkspaceKeys.length) {
    throw new Error('Every demo account UID must be unique');
  }
  if (manifest.generatedAtMs > nowMs || nowMs - manifest.generatedAtMs > maxAgeMs) {
    throw new Error('Manifest is stale or dated in the future');
  }
  for (const key of registryWorkspaceKeys) {
    const account = manifest.accounts[key];
    if (account.uid !== expected[key]) {
      throw new Error(`Manifest account UID mismatch for ${key}`);
    }
    if (computeRegistryRowSetHash(account.uid, account.rows) !== account.rowSetHash) {
      throw new Error(`Manifest row-set hash mismatch for ${key}`);
    }
    if (account.derivedRowCount !== account.rows.length) {
      throw new Error(`Manifest derived row count mismatch for ${key}`);
    }
    const partitioned =
      account.creates.length +
      account.updates.length +
      account.unchanged.length +
      account.collisions.length;
    if (partitioned !== account.rows.length) {
      throw new Error(`Manifest action-bucket partition mismatch for ${key}`);
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Compare support
// ---------------------------------------------------------------------------

export interface RegistryComparisonRow {
  workspace: RegistryWorkspaceKey;
  label: string;
  reviewedRowCount: number;
  currentRowCount: number;
  rowSetMatches: boolean;
  pendingCreates: number;
  pendingUpdates: number;
  pendingRemovals: number;
  collisions: number;
  exactMatch: boolean;
}

/**
 * One compare verdict per workspace, from a FRESH read-only plan taken
 * after apply: `exactMatch` requires the current derivation to hash to the
 * reviewed row set AND the destination to need zero further writes —
 * i.e., the live registry holds exactly the reviewed rows.
 */
export function buildRegistryComparisonRow(
  workspace: RegistryWorkspaceKey,
  reviewed: RegistryAccountManifest,
  currentPlan: TournamentRegistryPlan,
): RegistryComparisonRow {
  const rowSetMatches =
    computeRegistryRowSetHash(currentPlan.uid, currentPlan.derivedRows) === reviewed.rowSetHash;
  const pendingCreates = currentPlan.creates.length;
  const pendingUpdates = currentPlan.updates.length;
  const pendingRemovals = currentPlan.orphanRemovals.length;
  const collisions = currentPlan.collisions.length;
  return {
    workspace,
    label: reviewed.label,
    reviewedRowCount: reviewed.rows.length,
    currentRowCount: currentPlan.derivedRows.length,
    rowSetMatches,
    pendingCreates,
    pendingUpdates,
    pendingRemovals,
    collisions,
    exactMatch:
      rowSetMatches &&
      pendingCreates === 0 &&
      pendingUpdates === 0 &&
      pendingRemovals === 0 &&
      collisions === 0,
  };
}

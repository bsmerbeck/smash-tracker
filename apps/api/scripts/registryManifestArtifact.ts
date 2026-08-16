import { z } from 'zod';
import { tournamentRegistryRowSchema, type TournamentRegistryRow } from '@smash-tracker/shared';
import { canonicalDigest, canonicalJson } from '../src/research/registry/canonical.js';
import { describeForeignRowDigestDelta } from '../src/research/registry/foreignDigest.js';
import {
  registryWorkspaceKeySchema,
  registryWorkspaceKeys,
  registryWorkspaceLabels,
  type RegistryUidMap,
  type RegistryWorkspaceKey,
} from '../src/research/registry/workspaces.js';
import type { TournamentRegistryPlan } from '../src/research/registry/reconcile.js';

/**
 * Phase 30.3 (Tournament Registry Backfill): the PURE, unit-tested half of
 * the owner-run `deriveTournamentRegistry.ts` CLI — the same split
 * `migrateManifestArtifact.ts` and `enrichManifestArtifact.ts` establish
 * (the CLI shell ends in `void main()` and is never unit-tested; every
 * decision that matters lives here instead).
 *
 * Runtime dependencies are zod + the shared row schema + this repo's shared
 * registry canonicalization ONLY — the plan type is imported `type`-only, so
 * parsing/validating a manifest artifact never pulls in firebase-admin.
 *
 * The artifact is the ONLY thing standing between "owner reviewed the
 * dry-run" and "apply writes the demo registries", so:
 * - `.strict()` at every object level this module owns (a stray key fails
 *   loudly; the row level reuses the shared contract schema — the single
 *   source of truth — rather than a strictness-duplicating copy).
 * - `contentHash` covers the whole body (database host, uid map and scope
 *   included, mirroring `computeArtifactHash`'s review rationale: a
 *   foreign-env or wrong-map artifact must not pass on matching counts).
 * - `rowSetHash` per account covers the CONTENT identity of the derived
 *   row set — with `provenance.importedAtMs` stripped, because that member
 *   is a first-import stamp resolved at write time (dry-run seeds it with
 *   its own clock for not-yet-existing rows), and hashing it would make an
 *   honest apply/compare spuriously drift from its own reviewed manifest.
 *   The planned ACTION buckets (creates/updates/…) are reviewable plain
 *   fields instead, cross-checked for partition consistency below and
 *   classified bucket-by-bucket at apply time by `classifyRegistryDrift`.
 * - `foreignDigest` per account pins the content of the children this
 *   projector does NOT own, so apply and compare can prove preservation
 *   rather than merely counting it.
 *
 * FORMAT VERSION 2 (30.3 operator hardening): a manifest now declares an
 * explicit `scope` — the accounts it covers — so the owner can review and
 * apply ONE ACCOUNT AT A TIME. `targetUids` still carries all four uids
 * (that is what makes the uniqueness cross-check meaningful), but
 * `accounts` holds exactly the scoped subset.
 */

// ---------------------------------------------------------------------------
// Workspaces (re-exported from the projector-side module so scripts and the
// importable `src/research/registry/**` half never drift apart)
// ---------------------------------------------------------------------------

export {
  registryWorkspaceKeys,
  registryWorkspaceLabels,
  type RegistryUidMap,
  type RegistryWorkspaceKey,
};

export const REGISTRY_MANIFEST_FORMAT_VERSION = 2;

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
  return canonicalDigest({ uid, rows: canonicalRows });
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
    /** Child keys of the NON-registry-owned entries at review time. */
    preservedForeignKeys: z.array(z.string()),
    /** Content digest over those entries — see `src/research/registry/foreignDigest.ts`. */
    foreignDigest: hashHexSchema,
    /** The full derived rows — the reviewable payload apply would write. */
    rows: z.array(tournamentRegistryRowSchema),
    rowSetHash: hashHexSchema,
  })
  .strict();
export type RegistryAccountManifest = z.infer<typeof registryAccountManifestSchema>;

const manifestBodySchema = z
  .object({
    formatVersion: z.literal(REGISTRY_MANIFEST_FORMAT_VERSION),
    generatedAtMs: z.number().int().nonnegative(),
    databaseHost: z.string().min(1),
    /** All four uids, always — the uniqueness cross-check is only meaningful over the whole set. */
    targetUids: uidMapSchema,
    /** The accounts this manifest actually covers, in canonical workspace order. */
    scope: z.array(registryWorkspaceKeySchema).min(1),
    /** Structural dry-run guarantee: the planner performs no writes. */
    writesPerformed: z.literal(0),
    /** Exactly the scoped accounts — cross-checked against `scope` in `validateRegistryManifest`. */
    accounts: z
      .object({
        hbox: registryAccountManifestSchema.optional(),
        mkleo: registryAccountManifestSchema.optional(),
        sparg0: registryAccountManifestSchema.optional(),
        izaw: registryAccountManifestSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type RegistryManifestBody = z.infer<typeof manifestBodySchema>;

export const registryManifestSchema = manifestBodySchema.extend({
  contentHash: hashHexSchema,
});
export type RegistryManifest = z.infer<typeof registryManifestSchema>;

/** `scope` in canonical workspace order, deduplicated. */
export function canonicalScope(
  workspaces: readonly RegistryWorkspaceKey[],
): RegistryWorkspaceKey[] {
  const wanted = new Set(workspaces);
  return registryWorkspaceKeys.filter((key) => wanted.has(key));
}

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
    preservedForeignKeys: plan.foreignDigest.keys,
    foreignDigest: plan.foreignDigest.digest,
    rows: plan.derivedRows,
    rowSetHash: computeRegistryRowSetHash(plan.uid, plan.derivedRows),
  });
}

export function computeRegistryManifestHash(body: RegistryManifestBody): string {
  return canonicalDigest(manifestBodySchema.parse(body));
}

export function createRegistryManifest(body: RegistryManifestBody): RegistryManifest {
  const parsed = manifestBodySchema.parse(body);
  return { ...parsed, contentHash: computeRegistryManifestHash(parsed) };
}

/** The scoped accounts present in a manifest, in canonical order. Never `undefined` members. */
export function manifestScopedAccounts(
  manifest: RegistryManifest,
): { workspace: RegistryWorkspaceKey; account: RegistryAccountManifest }[] {
  return canonicalScope(manifest.scope).map((workspace) => {
    const account = manifest.accounts[workspace];
    if (!account) {
      throw new Error(`Manifest scope names ${workspace} but carries no account for it`);
    }
    return { workspace, account };
  });
}

// ---------------------------------------------------------------------------
// Validation — the apply/compare gate
// ---------------------------------------------------------------------------

/**
 * Parses and integrity-checks a manifest artifact against the CLI's own
 * uid flags and clock. Throws a descriptive `Error` on the first
 * violation; returns the fully-typed manifest only when every check holds:
 * strict schema, content hash, uid-map equality and uniqueness,
 * scope/accounts agreement, staleness bounds, per-account uid match,
 * per-account row-set hash, and bucket-partition consistency (every derived
 * row in exactly one of creates/updates/unchanged/collisions).
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
  if (canonicalJson(manifest.targetUids) !== canonicalJson(expected)) {
    throw new Error('Manifest target UIDs do not match the supplied demo accounts');
  }
  if (new Set(Object.values(expected)).size !== registryWorkspaceKeys.length) {
    throw new Error('Every demo account UID must be unique');
  }
  if (manifest.generatedAtMs > nowMs || nowMs - manifest.generatedAtMs > maxAgeMs) {
    throw new Error('Manifest is stale or dated in the future');
  }

  // Scope and accounts must describe the same set — a manifest that claims
  // to cover mkleo but carries no mkleo plan (or carries an unscoped hbox
  // plan the owner never reviewed under this scope) is not reviewable.
  const scope = manifest.scope;
  if (new Set(scope).size !== scope.length) {
    throw new Error('Manifest scope contains duplicate workspaces');
  }
  const presentKeys = registryWorkspaceKeys.filter((key) => manifest.accounts[key] !== undefined);
  if (canonicalJson(canonicalScope(scope)) !== canonicalJson(presentKeys)) {
    throw new Error(
      `Manifest scope [${canonicalScope(scope).join(',')}] does not match its account set [${presentKeys.join(',')}]`,
    );
  }

  for (const { workspace, account } of manifestScopedAccounts(manifest)) {
    if (account.uid !== expected[workspace]) {
      throw new Error(`Manifest account UID mismatch for ${workspace}`);
    }
    if (computeRegistryRowSetHash(account.uid, account.rows) !== account.rowSetHash) {
      throw new Error(`Manifest row-set hash mismatch for ${workspace}`);
    }
    if (account.derivedRowCount !== account.rows.length) {
      throw new Error(`Manifest derived row count mismatch for ${workspace}`);
    }
    if (account.preservedForeignKeys.length !== account.preservedForeignCount) {
      throw new Error(`Manifest preserved-foreign count mismatch for ${workspace}`);
    }
    const partitioned =
      account.creates.length +
      account.updates.length +
      account.unchanged.length +
      account.collisions.length;
    if (partitioned !== account.rows.length) {
      throw new Error(`Manifest action-bucket partition mismatch for ${workspace}`);
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Drift classification — the interrupted-recovery gate
// ---------------------------------------------------------------------------

/**
 * Why a fresh read-only plan may differ from the reviewed manifest.
 *
 * `partially-applied` is the one this whole mechanism exists for. After an
 * interrupted apply, some of the manifest's `creates`/`updates` are already
 * in the destination and now re-plan as `unchanged`. The DERIVED CONTENT is
 * unchanged, so a naive "row set still matches, just resume" reading looks
 * safe — and is exactly the advice that must never be given: the manifest
 * the owner reviewed no longer describes the writes that would be
 * performed, so it can no longer authorize them. The only correct recovery
 * is a fresh dry-run.
 */
export const registryDriftKinds = [
  'none',
  'foreign-drift',
  'source-drift',
  'partially-applied',
  'destination-drift',
] as const;
export type RegistryDriftKind = (typeof registryDriftKinds)[number];

export interface RegistryDriftVerdict {
  workspace: RegistryWorkspaceKey;
  kind: RegistryDriftKind;
  /** True only for `kind === 'none'`. Apply proceeds on nothing else. */
  safeToApply: boolean;
  message: string;
  /** Entry ids the manifest planned to create/update that are already applied. */
  alreadyApplied: string[];
}

function bucketsEqual(a: readonly string[], b: readonly string[]): boolean {
  return canonicalJson([...a]) === canonicalJson([...b]);
}

/**
 * Compares a FRESH read-only plan (already distilled through
 * `buildRegistryAccountManifest`, so like is compared with like) against the
 * reviewed manifest account, and names the reason for any difference.
 *
 * Priority order is deliberate — the most alarming cause is reported first:
 * a foreign row changing (something else is writing to this account) beats
 * source drift, which beats a partial apply, which beats any other
 * destination change.
 */
export function classifyRegistryDrift(
  workspace: RegistryWorkspaceKey,
  reviewed: RegistryAccountManifest,
  fresh: RegistryAccountManifest,
): RegistryDriftVerdict {
  const appliedSet = new Set(fresh.unchanged);
  const alreadyApplied = [...reviewed.creates, ...reviewed.updates]
    .filter((entryId) => appliedSet.has(entryId))
    .sort();

  const verdict = (kind: RegistryDriftKind, message: string): RegistryDriftVerdict => ({
    workspace,
    kind,
    safeToApply: kind === 'none',
    message,
    alreadyApplied,
  });

  if (fresh.foreignDigest !== reviewed.foreignDigest) {
    return verdict(
      'foreign-drift',
      `Apply refused for ${workspace}: the NON-registry rows changed since the dry-run ` +
        `(${describeForeignRowDigestDelta(
          {
            version: 1,
            uid: reviewed.uid,
            count: reviewed.preservedForeignCount,
            keys: reviewed.preservedForeignKeys,
            digest: reviewed.foreignDigest,
          },
          {
            version: 1,
            uid: fresh.uid,
            count: fresh.preservedForeignCount,
            keys: fresh.preservedForeignKeys,
            digest: fresh.foreignDigest,
          },
        )}). Something other than this operator is writing to tournamentEntries/${reviewed.uid}. ` +
        'Investigate before running any apply; do NOT reuse this manifest.',
    );
  }

  if (fresh.rowSetHash !== reviewed.rowSetHash) {
    return verdict(
      'source-drift',
      `Apply refused for ${workspace}: the derived row set no longer matches the reviewed manifest ` +
        '(the researchSource records changed since the dry-run). Re-run dry-run and review the new manifest.',
    );
  }

  const sameBuckets =
    bucketsEqual(fresh.creates, reviewed.creates) &&
    bucketsEqual(fresh.updates, reviewed.updates) &&
    bucketsEqual(fresh.unchanged, reviewed.unchanged) &&
    bucketsEqual(fresh.collisions, reviewed.collisions) &&
    bucketsEqual(fresh.orphanRemovals, reviewed.orphanRemovals);
  if (sameBuckets) {
    return verdict('none', `${workspace}: fresh plan matches the reviewed manifest exactly.`);
  }

  if (alreadyApplied.length > 0) {
    return verdict(
      'partially-applied',
      `Apply refused for ${workspace}: this manifest is PARTIALLY APPLIED. ` +
        `${alreadyApplied.length} row(s) it planned to create/update are already in the destination ` +
        `and now re-plan as unchanged (${alreadyApplied.slice(0, 5).join(', ')}${
          alreadyApplied.length > 5 ? ', …' : ''
        }). ` +
        'The create/update classification the owner reviewed no longer describes what apply would do, ' +
        'so this manifest can no longer authorize it. Do NOT re-run this manifest: regenerate a fresh ' +
        'one with dry-run, review it, and apply that.',
    );
  }

  return verdict(
    'destination-drift',
    `Apply refused for ${workspace}: the derived rows still match, but the destination's action ` +
      'buckets changed since the dry-run (registry rows were edited, removed, or newly collided). ' +
      'Re-run dry-run and review the new manifest.',
  );
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
  /** The non-registry rows still hash to the reviewed digest — nothing foreign was touched. */
  foreignDigestMatches: boolean;
  exactMatch: boolean;
}

/**
 * One compare verdict per workspace, from a FRESH read-only plan taken
 * after apply: `exactMatch` requires the current derivation to hash to the
 * reviewed row set, the destination to need zero further writes — i.e. the
 * live registry holds exactly the reviewed rows — AND the foreign rows to
 * still digest to their reviewed value.
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
  const foreignDigestMatches = currentPlan.foreignDigest.digest === reviewed.foreignDigest;
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
    foreignDigestMatches,
    exactMatch:
      rowSetMatches &&
      foreignDigestMatches &&
      pendingCreates === 0 &&
      pendingUpdates === 0 &&
      pendingRemovals === 0 &&
      collisions === 0,
  };
}

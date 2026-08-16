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
 *
 * FORMAT VERSION 3 (owner/Codex hard gate #4, B8 — the SOURCE CENSUS FREEZE):
 * the apply gate's MEANING changed, so the artifact version had to move with
 * it. Under v2 an apply was authorized by the derived-row hash and the action
 * buckets alone, which left a real hole: the source census could move
 * underneath a manifest — hundreds of newly corrupt source records, a swing
 * in `skippedExcludedClassification`, a different `sourceSetCount` — and the
 * apply would still pass because the surviving derived rows happened to hash
 * the same. v3 closes it by making the WHOLE census a first-class part of
 * both the drift classification and the compare verdict, and by adding
 * `reviewedExceptions`: the ONLY way a corrupt-record or collision condition
 * can be applied over. A v2 manifest was reviewed against the weaker gate and
 * therefore cannot authorize an apply under this one; it is refused by the
 * `formatVersion` literal rather than migrated.
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

export const REGISTRY_MANIFEST_FORMAT_VERSION = 3;

/**
 * THE OWNER-FROZEN SOURCE CENSUS (hard gate #4, B8).
 *
 * `sourceSetCount` is the number of children stored under
 * `researchSource/{uid}/sets` — the entire input population the projector
 * derives from. The owner froze these four figures against the 2026-08-16
 * read-only production audit, and they live in COMMITTED SOURCE for the same
 * reason the Gate-6 expectation table does: a census whose expected value
 * arrives as a CLI parameter proves only that the operator typed a number
 * matching the database.
 *
 * A fresh plan whose `sourceSetCount` differs from the frozen figure means
 * the input population moved. That is never a thing to apply over silently;
 * it is refused PRE-WRITE unless the reviewed manifest carries a
 * `reviewedExceptions` entry naming the exact observed count.
 */
export const REGISTRY_FROZEN_SOURCE_SET_COUNTS: Record<RegistryWorkspaceKey, number> = {
  hbox: 8413,
  mkleo: 5314,
  sparg0: 6187,
  izaw: 640,
};

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

/**
 * THE REVIEWED EXCEPTION (hard gate #4, B8) — the ONLY thing that can
 * authorize an apply over a corrupt-source-record, collision, or
 * frozen-census condition.
 *
 * WHY IT IS MANIFEST CONTENT AND NOT A CLI FLAG. A flag is typed by whoever
 * is running the command, at the moment they are trying to get past a
 * refusal — which is the worst possible moment to be granting one. This field
 * lives INSIDE the per-account manifest, is therefore covered by the
 * manifest's `contentHash`, and is written by `dry-run` from a reviewed
 * exceptions file BEFORE the plan is inspected. The owner reads the sealed
 * manifest with the exception and the observed figures side by side and then
 * applies it; `apply` itself has no override of any kind.
 *
 * IT MUST COVER THE CONDITION EXACTLY. `acceptedCorruptSourceRecords` and
 * `acceptedCollisions` are exact values, not ceilings, and
 * `acceptedSourceSetCount` names one specific count (or `null` — "I am not
 * excepting the frozen census"). An exception written for 3 corrupt records
 * does not authorize an apply that now faces 4: the deviation the owner
 * reviewed is not the deviation in front of the operator, so the refusal
 * stands. Both `buildRegistryAccountManifest` (dry-run) and
 * `validateRegistryManifest` (apply/compare) enforce that coverage, so a
 * hand-authored exception that does not describe its own manifest fails
 * loudly at both ends.
 */
export const registryReviewedExceptionSchema = z
  .object({
    /** The owner's written justification. Long enough that it cannot be a shrug. */
    reason: z.string().min(20),
    reviewedAtMs: z.number().int().nonnegative(),
    /** The exact `sourceSetCount` accepted in place of the frozen figure, or `null` to except nothing. */
    acceptedSourceSetCount: z.number().int().nonnegative().nullable(),
    /** The exact number of corrupt source records accepted. */
    acceptedCorruptSourceRecords: z.number().int().nonnegative(),
    /** The exact set of colliding entry ids accepted, sorted. */
    acceptedCollisions: z.array(z.string()),
  })
  .strict();
export type RegistryReviewedException = z.infer<typeof registryReviewedExceptionSchema>;

/** One exceptions file: at most one reviewed exception per workspace. */
export const registryReviewedExceptionFileSchema = z
  .object({
    hbox: registryReviewedExceptionSchema.optional(),
    mkleo: registryReviewedExceptionSchema.optional(),
    sparg0: registryReviewedExceptionSchema.optional(),
    izaw: registryReviewedExceptionSchema.optional(),
  })
  .strict();
export type RegistryReviewedExceptionFile = z.infer<typeof registryReviewedExceptionFileSchema>;

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
    /** Absent on every ordinary manifest — see {@link registryReviewedExceptionSchema}. */
    reviewedExceptions: registryReviewedExceptionSchema.optional(),
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
 *
 * `exception`, when supplied (only `dry-run` supplies one, from the reviewed
 * `--exceptions-in` file), is checked against THIS plan before it is embedded:
 * an exception that does not exactly describe the condition it claims to
 * authorize is a dry-run failure, not something to discover at apply time.
 */
export function buildRegistryAccountManifest(
  label: string,
  plan: TournamentRegistryPlan,
  exception?: RegistryReviewedException,
): RegistryAccountManifest {
  if (exception !== undefined) {
    assertExceptionIsGrounded(label, exception, sourceCensusOf(plan));
  }
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
    // Conditional spread, per the house RTDB rule: an absent exception must
    // be an ABSENT member, never an explicit `undefined`. `canonicalJson`
    // treats the two identically, but the artifact is also written to disk
    // and read by humans.
    ...(exception !== undefined ? { reviewedExceptions: exception } : {}),
  });
}

// ---------------------------------------------------------------------------
// The source census (hard gate #4, B8)
// ---------------------------------------------------------------------------

/**
 * THE COMPLETE SOURCE CENSUS — every figure that describes what the projector
 * read and what it decided to ignore, plus the two destination-side outcomes
 * a derived-row hash cannot express.
 *
 * The hole this closes: `rowSetHash` covers the rows that SURVIVED derivation.
 * Everything that did not survive — a source record that failed its schema, a
 * set with no event id, a set whose event id is not path-safe, a set whose
 * classification excludes it — is invisible to that hash, and so is a
 * collision (a derived row that exists but is NOT written) and an orphan
 * removal (a stored row that would be deleted). Two runs can therefore agree
 * on every derived row while disagreeing about hundreds of source records, and
 * under the pre-B8 gate the second one applied cleanly.
 */
export interface RegistrySourceCensus {
  sourceSetCount: number;
  corruptSourceRecords: number;
  skippedNoEventId: number;
  skippedUnsafeEventId: number;
  skippedExcludedClassification: number;
  collisions: string[];
  orphanRemovals: string[];
}

/** Normalizes any census-bearing value (a plan or a reviewed account) to the comparable shape. */
export function sourceCensusOf(source: RegistrySourceCensus): RegistrySourceCensus {
  return {
    sourceSetCount: source.sourceSetCount,
    corruptSourceRecords: source.corruptSourceRecords,
    skippedNoEventId: source.skippedNoEventId,
    skippedUnsafeEventId: source.skippedUnsafeEventId,
    skippedExcludedClassification: source.skippedExcludedClassification,
    collisions: [...source.collisions].sort(),
    orphanRemovals: [...source.orphanRemovals].sort(),
  };
}

/**
 * Field-by-field census delta, empty when the two agree. Naming the exact
 * members that moved is the point: "census changed" is not an actionable
 * refusal, "corruptSourceRecords 0 -> 412" is.
 */
export function describeSourceCensusDelta(
  reviewed: RegistrySourceCensus,
  fresh: RegistrySourceCensus,
): string[] {
  const left = sourceCensusOf(reviewed);
  const right = sourceCensusOf(fresh);
  const deltas: string[] = [];
  for (const field of [
    'sourceSetCount',
    'corruptSourceRecords',
    'skippedNoEventId',
    'skippedUnsafeEventId',
    'skippedExcludedClassification',
  ] as const) {
    if (left[field] !== right[field]) {
      deltas.push(`${field} ${left[field]} -> ${right[field]}`);
    }
  }
  for (const field of ['collisions', 'orphanRemovals'] as const) {
    if (canonicalJson(left[field]) !== canonicalJson(right[field])) {
      deltas.push(`${field} [${left[field].join(',')}] -> [${right[field].join(',')}]`);
    }
  }
  return deltas;
}

/**
 * GROUNDING, not authorization. An exception may accept LESS than the plan
 * shows (it then simply fails to authorize, and the pre-write gate refuses);
 * it may never accept a condition the plan does not exhibit, because such an
 * exception describes a corpus that does not exist and could only ever
 * pre-authorize a future deviation. The exact-match requirement that turns a
 * grounded exception into an authorization lives in
 * {@link assessRegistryPreWriteGate}, deliberately separate: the two answer
 * "is this text about this manifest?" and "does it let the apply through?",
 * and conflating them made it impossible to author an exception that covers
 * one census condition without also covering the others.
 */
function assertExceptionIsGrounded(
  label: string,
  exception: RegistryReviewedException,
  census: RegistrySourceCensus,
): void {
  if (exception.acceptedCorruptSourceRecords > census.corruptSourceRecords) {
    throw new Error(
      `Reviewed exception for ${label} accepts ${exception.acceptedCorruptSourceRecords} corrupt source ` +
        `record(s) but the plan has ${census.corruptSourceRecords}`,
    );
  }
  const present = new Set(census.collisions);
  const ungrounded = [...exception.acceptedCollisions].filter((entryId) => !present.has(entryId));
  if (ungrounded.length > 0) {
    throw new Error(
      `Reviewed exception for ${label} accepts collision(s) [${ungrounded.sort().join(',')}] that the ` +
        `plan does not have (its collisions are [${census.collisions.join(',')}])`,
    );
  }
  if (
    exception.acceptedSourceSetCount !== null &&
    exception.acceptedSourceSetCount !== census.sourceSetCount
  ) {
    throw new Error(
      `Reviewed exception for ${label} accepts sourceSetCount ${exception.acceptedSourceSetCount} ` +
        `but the plan has ${census.sourceSetCount}`,
    );
  }
}

/** Why a fresh plan may not be applied even though it matches its reviewed manifest. */
export const registryPreWriteGateKinds = [
  'none',
  'frozen-source-set-drift',
  'corrupt-source-records',
  'collisions',
] as const;
export type RegistryPreWriteGateKind = (typeof registryPreWriteGateKinds)[number];

export interface RegistryPreWriteGateVerdict {
  workspace: RegistryWorkspaceKey;
  kind: RegistryPreWriteGateKind;
  /** True only for `kind === 'none'`. Apply proceeds on nothing else. */
  ok: boolean;
  message: string;
}

/**
 * THE PRE-WRITE CENSUS GATE. Evaluated against the FRESH plan (what apply
 * would actually face), authorized only by the reviewed manifest's own
 * `reviewedExceptions`.
 *
 * Three refusals, in order of how badly they mean "the input is not what was
 * frozen":
 *  1. `frozen-source-set-drift` — the source population is not the
 *     owner-frozen figure for this account.
 *  2. `corrupt-source-records`  — at least one stored source record no longer
 *     parses. Those records are SKIPPED by the projector, so their content is
 *     silently missing from the derived rows; applying over that is applying a
 *     knowingly incomplete registry.
 *  3. `collisions`             — a derived row's `histimport:` key is occupied
 *     by a foreign value. Nothing is clobbered (the projector never writes
 *     one), but the apply cannot deliver the reviewed row set.
 */
export function assessRegistryPreWriteGate(
  workspace: RegistryWorkspaceKey,
  reviewed: RegistryAccountManifest,
  fresh: RegistrySourceCensus,
): RegistryPreWriteGateVerdict {
  const census = sourceCensusOf(fresh);
  const exception = reviewed.reviewedExceptions;
  const verdict = (
    kind: RegistryPreWriteGateKind,
    message: string,
  ): RegistryPreWriteGateVerdict => ({ workspace, kind, ok: kind === 'none', message });
  const authorize =
    'Authorize it by regenerating the manifest with a reviewed exception ' +
    '(`dry-run --exceptions-in <file>`) that names this exact condition, and reviewing that manifest.';

  const frozen = REGISTRY_FROZEN_SOURCE_SET_COUNTS[workspace];
  if (
    census.sourceSetCount !== frozen &&
    exception?.acceptedSourceSetCount !== census.sourceSetCount
  ) {
    return verdict(
      'frozen-source-set-drift',
      `Apply refused for ${workspace}: sourceSetCount is ${census.sourceSetCount}, but the owner-frozen ` +
        `census for this account is ${frozen}. The input population moved. ${authorize}`,
    );
  }

  if (
    census.corruptSourceRecords > 0 &&
    exception?.acceptedCorruptSourceRecords !== census.corruptSourceRecords
  ) {
    return verdict(
      'corrupt-source-records',
      `Apply refused for ${workspace}: ${census.corruptSourceRecords} stored source record(s) failed the ` +
        'source-record schema and were SKIPPED, so the derived row set is knowingly incomplete. ' +
        authorize,
    );
  }

  if (
    census.collisions.length > 0 &&
    canonicalJson([...(exception?.acceptedCollisions ?? [])].sort()) !==
      canonicalJson(census.collisions)
  ) {
    return verdict(
      'collisions',
      `Apply refused for ${workspace}: ${census.collisions.length} derived row(s) collide with a FOREIGN ` +
        `value on their histimport: key (${census.collisions.slice(0, 5).join(', ')}${
          census.collisions.length > 5 ? ', …' : ''
        }) and can never be written. ${authorize}`,
    );
  }

  return verdict('none', `${workspace}: source census matches the frozen contract.`);
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
    // A reviewed exception must describe ITS OWN manifest. A hand-authored
    // one that accepts a condition the manifest does not record is not an
    // authorization for anything — refuse the whole artifact rather than let
    // it reach the pre-write gate and quietly fail to apply there.
    if (account.reviewedExceptions !== undefined) {
      assertExceptionIsGrounded(workspace, account.reviewedExceptions, sourceCensusOf(account));
    }
  }
  return manifest;
}

/**
 * Schema + seal ONLY, with no clock, uid-map or staleness binding.
 *
 * The Gate-6 audit needs the manifest's IDENTITY (its `contentHash` and the
 * per-account figures a receipt claims to have been authorized by), not a
 * fresh-enough manifest to apply — by audit time the reviewed manifest is
 * hours old ON PURPOSE. Using {@link validateRegistryManifest} there would
 * refuse every honest artifact for staleness; restating the schema in the
 * audit would let the two drift. This is the third option: one parse, one
 * seal check, no policy.
 */
export function parseSealedRegistryManifest(raw: unknown): RegistryManifest {
  const manifest = registryManifestSchema.parse(raw);
  const { contentHash, ...body } = manifest;
  if (computeRegistryManifestHash(body) !== contentHash) {
    throw new Error('Manifest content hash mismatch');
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
  'census-drift',
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
 * source drift, which beats CENSUS drift, which beats a partial apply, which
 * beats any other destination change.
 *
 * `census-drift` is checked BEFORE the bucket comparison because that is
 * where the pre-B8 hole was: a census change that leaves every derived row
 * identical also leaves every action bucket identical, so the old
 * `sameBuckets` early-return classified it `none` and applied.
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

  const censusDelta = describeSourceCensusDelta(sourceCensusOf(reviewed), sourceCensusOf(fresh));
  if (censusDelta.length > 0) {
    return verdict(
      'census-drift',
      `Apply refused for ${workspace}: the SOURCE CENSUS moved since the dry-run even though the derived ` +
        `rows may not have (${censusDelta.join('; ')}). The reviewed manifest describes a different input ` +
        'population than the one apply would read. Re-run dry-run and review the new manifest.',
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
  /** The FULL source census still equals the reviewed one (hard gate #4, B8). */
  censusMatches: boolean;
  /** Named census members that moved; empty when `censusMatches`. */
  censusDelta: string[];
  /** The live census still satisfies the frozen contract (or its reviewed exception). */
  frozenCensusOk: boolean;
  exactMatch: boolean;
}

/**
 * One compare verdict per workspace, from a FRESH read-only plan taken
 * after apply: `exactMatch` requires the current derivation to hash to the
 * reviewed row set, the destination to need zero further writes — i.e. the
 * live registry holds exactly the reviewed rows — the foreign rows to still
 * digest to their reviewed value, AND (hard gate #4, B8) the complete source
 * census to still equal the reviewed one and satisfy the frozen contract.
 *
 * The census clauses are load-bearing, not decorative: without them a compare
 * passes on an account whose source population has since gained hundreds of
 * corrupt records, because the surviving derived rows still hash the same.
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
  const censusDelta = describeSourceCensusDelta(
    sourceCensusOf(reviewed),
    sourceCensusOf(currentPlan),
  );
  const frozenCensusOk = assessRegistryPreWriteGate(
    workspace,
    reviewed,
    sourceCensusOf(currentPlan),
  ).ok;
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
    censusMatches: censusDelta.length === 0,
    censusDelta,
    frozenCensusOk,
    exactMatch:
      rowSetMatches &&
      foreignDigestMatches &&
      censusDelta.length === 0 &&
      frozenCensusOk &&
      pendingCreates === 0 &&
      pendingUpdates === 0 &&
      pendingRemovals === 0 &&
      collisions === 0,
  };
}

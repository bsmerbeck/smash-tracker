import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Phase 30.1 Plan 04 (Demo Account Topology & Migration, review C3-M2): the
 * PURE, unit-tested half of the owner-run `migrateDemoAccounts.ts` CLI —
 * `migrateDemoAccounts.ts` ends with a top-level `void main()` (mirroring
 * `seedDemo.ts`'s posture), so any logic that must be independently
 * unit-testable lives here instead, exactly like `scripts/seed/manifest.ts`
 * is the tested helper behind the untested `seedDemo.ts` shell.
 *
 * This module has ZERO firebase-admin/RTDB dependency — it operates only on
 * plain JSON values read from (or about to be written to) the manifest
 * artifact file the `copy` subcommand produces and the `archive` subcommand
 * consumes. That artifact is the ONLY thing standing between "clean copy
 * confirmed" and "archive the four real production sources", so its schema
 * is `.strict()` (unknown/extra keys rejected) at every level, and
 * `validateArchiveTargets` is the single authority the CLI must call before
 * deriving the list of source tenant ids to archive — never a decoupled
 * hardcoded constant (review C3-M2: a partial/substituted/duplicated map
 * must never authorize archiving the four real sources on a vacuous/subset
 * verify).
 */

// ---------------------------------------------------------------------------
// Artifact shape
// ---------------------------------------------------------------------------

export interface DbIdentity {
  /** `new URL(env.FIREBASE_DATABASE_URL).host` at artifact-generation time. */
  host: string;
  /** `firebase.app.options.projectId`, or `null` when the Admin SDK never resolved one. */
  projectId: string | null;
}

export interface SourceToDestMapping {
  sourceId: string;
  destUid: string;
  label: string;
}

/**
 * Mirrors `CompareResult`/`CopyResult`/`MigrationManifest`
 * (`apps/api/src/research/migration/manifest.ts`) structurally. This module
 * intentionally does NOT import those types/runtime code — it stays a
 * standalone, dependency-free artifact contract so it can be parsed and
 * validated by `migrateDemoAccounts.ts` without pulling in firebase-admin.
 */
export interface WorkspaceCompareResult {
  tree: string;
  sourceCount: number;
  destCount: number;
  missingIds: string[];
  extraIds: string[];
  valueMismatchIds: string[];
  match: boolean;
}

export interface WorkspaceCopyResult {
  tree: string;
  copied: number;
  skipped: number;
  conflicts: string[];
}

export interface WorkspaceManifest {
  sourceId: string;
  destUid: string;
  trees: WorkspaceCompareResult[];
  copies: WorkspaceCopyResult[];
  assertEmptyViolations: string[];
  ok: boolean;
}

export interface ManifestArtifact {
  generatedAtMs: number;
  dbIdentity: DbIdentity;
  sourceToDestMap: SourceToDestMapping[];
  workspaces: WorkspaceManifest[];
  ok: boolean;
  sha256: string;
}

/** `ManifestArtifact` minus the `sha256` field it does not cover — the exact input `computeArtifactHash` hashes. */
export type ManifestArtifactWithoutHash = Omit<ManifestArtifact, 'sha256'>;

// ---------------------------------------------------------------------------
// Strict zod schema — unknown/extra keys rejected at every level
// ---------------------------------------------------------------------------

const dbIdentitySchema = z
  .object({
    host: z.string().min(1),
    projectId: z.string().min(1).nullable(),
  })
  .strict();

const sourceToDestMappingSchema = z
  .object({
    sourceId: z.string().min(1),
    destUid: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

const workspaceCompareResultSchema = z
  .object({
    tree: z.string(),
    sourceCount: z.number(),
    destCount: z.number(),
    missingIds: z.array(z.string()),
    extraIds: z.array(z.string()),
    valueMismatchIds: z.array(z.string()),
    match: z.boolean(),
  })
  .strict();

const workspaceCopyResultSchema = z
  .object({
    tree: z.string(),
    copied: z.number(),
    skipped: z.number(),
    conflicts: z.array(z.string()),
  })
  .strict();

const workspaceManifestSchema = z
  .object({
    sourceId: z.string().min(1),
    destUid: z.string().min(1),
    trees: z.array(workspaceCompareResultSchema),
    copies: z.array(workspaceCopyResultSchema),
    assertEmptyViolations: z.array(z.string()),
    ok: z.boolean(),
  })
  .strict();

/**
 * STRICT schema for the manifest artifact `copy` writes and `archive`
 * consumes. `.strict()` at the top level AND on every nested object means a
 * stray extra field anywhere in the artifact fails validation outright
 * rather than being silently ignored.
 */
export const manifestArtifactSchema = z
  .object({
    generatedAtMs: z.number(),
    dbIdentity: dbIdentitySchema,
    sourceToDestMap: z.array(sourceToDestMappingSchema),
    workspaces: z.array(workspaceManifestSchema),
    ok: z.boolean(),
    sha256: z.string().min(1),
  })
  .strict();

export type ManifestArtifactParsed = z.infer<typeof manifestArtifactSchema>;

// ---------------------------------------------------------------------------
// Canonicalization + hash (shared by copy-time write and archive-time
// recompute — the SAME function must produce the SAME hash for the SAME
// logical content on both ends, or a genuine artifact would spuriously fail
// its own integrity check).
// ---------------------------------------------------------------------------

/**
 * Deterministic canonicalization: recursively sorts object keys (arrays
 * keep their order — order IS meaningful there) so `JSON.stringify` produces
 * an identical string regardless of the original key insertion order. This
 * is what makes `computeArtifactHash` reproducible across two independently
 * constructed JS objects carrying the same logical content.
 */
export function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForHash(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalizeForHash(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Hashes the canonicalized artifact — EXCLUDING the `sha256` field itself,
 * but INCLUDING `dbIdentity` and `sourceToDestMap` (review cycle-2 MEDIUM:
 * a foreign-env or wrong-map artifact must not be able to pass the hash
 * check just because its per-tree counts happen to match). Callers pass the
 * full artifact object minus its `sha256` key.
 */
export function computeArtifactHash(artifact: ManifestArtifactWithoutHash): string {
  const canonical = JSON.stringify(canonicalizeForHash(artifact));
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// validateArchiveTargets — the C3-M2 guard
// ---------------------------------------------------------------------------

/**
 * Parses `rawArtifact` through the strict schema, then asserts
 * `sourceToDestMap` has EXACTLY four entries, all four `sourceId`s unique,
 * all four `destUid`s unique, and the SET of `sourceId`s equals
 * `expectedSourceIds` EXACTLY. Throws a descriptive `Error` on any
 * violation. Returns the validated array of source ids to archive, derived
 * from the validated `sourceToDestMap` — NEVER a separate constant (review
 * C3-M2): a partial, substituted, duplicated, or mismatched map is rejected
 * rather than allowing a vacuous/subset verify while all four real sources
 * are archived regardless.
 */
export function validateArchiveTargets(
  rawArtifact: unknown,
  expectedSourceIds: readonly string[],
): string[] {
  const parsed = manifestArtifactSchema.safeParse(rawArtifact);
  if (!parsed.success) {
    throw new Error(`manifest artifact failed schema validation: ${parsed.error.message}`);
  }

  const map = parsed.data.sourceToDestMap;
  if (map.length !== 4) {
    throw new Error(`sourceToDestMap must contain exactly 4 entries, found ${map.length}`);
  }

  const sourceIds = map.map((entry) => entry.sourceId);
  const destUids = map.map((entry) => entry.destUid);

  const uniqueSourceIds = new Set(sourceIds);
  if (uniqueSourceIds.size !== sourceIds.length) {
    throw new Error('sourceToDestMap contains a duplicate sourceId');
  }

  const uniqueDestUids = new Set(destUids);
  if (uniqueDestUids.size !== destUids.length) {
    throw new Error('sourceToDestMap contains a duplicate destUid');
  }

  const expectedSet = new Set(expectedSourceIds);
  const missing = [...expectedSet].filter((id) => !uniqueSourceIds.has(id));
  const unexpected = [...uniqueSourceIds].filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `sourceToDestMap sourceId set does not match the expected sources ` +
        `(missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}])`,
    );
  }

  return sourceIds;
}

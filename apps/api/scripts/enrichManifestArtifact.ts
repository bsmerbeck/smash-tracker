import { createHash } from 'node:crypto';
import { z } from 'zod';

export const demoWorkspaceKeys = ['hbox', 'mkleo', 'sparg0', 'izaw'] as const;

/**
 * 30.2 reliability gate: bumped 1 -> 2 when the per-account
 * `observationPersistenceHash` (the canonical digest over every schema-
 * parsed observation, `prepareObservation.ts`) became part of the reviewed
 * write set. A manifest produced by the older parser/validation version has
 * no such digest and MUST be refused by apply — `validateEnrichmentManifest`
 * rejects any other version by name rather than by an opaque parse error.
 */
export const ENRICHMENT_MANIFEST_FORMAT_VERSION = 2;
export type DemoWorkspaceKey = (typeof demoWorkspaceKeys)[number];
export type DemoUidMap = Record<DemoWorkspaceKey, string>;

const uidSchema = z
  .string()
  .min(20)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const uidMapSchema = z.object({
  hbox: uidSchema,
  mkleo: uidSchema,
  sparg0: uidSchema,
  izaw: uidSchema,
});

const sourceRevisionSchema = z.object({
  sourcePageTitle: z.string(),
  sourcePageUrl: z.string().url(),
  sourceRevisionId: z.number().int(),
  fetchedAtMs: z.number().int().nonnegative(),
  parserVersion: z.string(),
});

const reviewCandidateSchema = z.object({
  observationId: z.string(),
  sourcePageTitle: z.string(),
  outcome: z.enum(['ambiguous', 'conflicting']),
  candidateTargetSetIds: z.array(z.string()),
  evidence: z.array(z.string()),
  reasons: z.array(z.string()),
});

const matchedCandidateSchema = z.object({
  observationId: z.string(),
  sourcePageTitle: z.string(),
  targetSetId: z.string(),
  evidence: z.array(z.string()),
});

export const enrichmentAccountManifestSchema = z.object({
  label: z.string(),
  uid: uidSchema,
  pagesFetched: z.number().int().nonnegative(),
  pagesFromCache: z.number().int().nonnegative(),
  networkRequestsOperationalOnly: z.number().int().nonnegative(),
  observationsExtracted: z.number().int().nonnegative(),
  vodPageRows: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  conflicting: z.number().int().nonnegative(),
  gamesWithCanonicalStage: z.number().int().nonnegative(),
  gamesWithStageForm: z.number().int().nonnegative(),
  gamesWithoutCanonicalStage: z.number().int().nonnegative(),
  stageWouldEnrich: z.number().int().nonnegative(),
  vodWouldFillEmpty: z.number().int().nonnegative(),
  vodWouldSkipUserOwned: z.number().int().nonnegative(),
  sourceRevisions: z.array(sourceRevisionSchema),
  extractorVersions: z.array(z.string()),
  /** The canonical digest over every schema-parsed observation this account's dry run gathered (`computeObservationPersistenceHash`). */
  observationPersistenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** How many schema-parsed records `observationPersistenceHash` covers. */
  observationsValidated: z.number().int().nonnegative(),
  matchedCandidates: z.array(matchedCandidateSchema),
  reviewCandidates: z.array(reviewCandidateSchema),
  missingSourcePages: z.array(
    z.object({ playerLabel: z.string(), pageTitle: z.string(), reason: z.string() }),
  ),
  beforeCoverage: z.object({
    asOfMs: z.number().int().nonnegative().nullable(),
    matched: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
    conflicting: z.number().int().nonnegative(),
    stageEnriched: z.number().int().nonnegative(),
    vodFilledEmpty: z.number().int().nonnegative(),
    vodSkippedUserOwned: z.number().int().nonnegative(),
    sourceRevisionCount: z.number().int().nonnegative(),
  }),
  writeSetHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EnrichmentAccountManifest = z.infer<typeof enrichmentAccountManifestSchema>;
export type EnrichmentCoverageMetrics = EnrichmentAccountManifest['beforeCoverage'];

const manifestBodySchema = z.object({
  formatVersion: z.literal(ENRICHMENT_MANIFEST_FORMAT_VERSION),
  generatedAtMs: z.number().int().nonnegative(),
  databaseHost: z.string().min(1),
  sinceYear: z.number().int().min(2000).max(2100),
  targetUids: uidMapSchema,
  writesPerformed: z.literal(0),
  networkRequestCountIsSuccessMetric: z.literal(false),
  accounts: z.object({
    hbox: enrichmentAccountManifestSchema,
    mkleo: enrichmentAccountManifestSchema,
    sparg0: enrichmentAccountManifestSchema,
    izaw: enrichmentAccountManifestSchema,
  }),
});
export type EnrichmentManifestBody = z.infer<typeof manifestBodySchema>;

export const enrichmentManifestSchema = manifestBodySchema.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EnrichmentManifest = z.infer<typeof enrichmentManifestSchema>;

export function computeAccountWriteSetHash(
  account: Omit<EnrichmentAccountManifest, 'writeSetHash'>,
): string {
  const sourceRevisions = account.sourceRevisions
    .map(({ sourcePageTitle, sourcePageUrl, sourceRevisionId, parserVersion }) => ({
      sourcePageTitle,
      sourcePageUrl,
      sourceRevisionId,
      parserVersion,
    }))
    .sort((a, b) =>
      `${a.sourcePageTitle}:${a.sourceRevisionId}`.localeCompare(
        `${b.sourcePageTitle}:${b.sourceRevisionId}`,
      ),
    );
  const matchedCandidates = [...account.matchedCandidates].sort((a, b) =>
    a.observationId.localeCompare(b.observationId),
  );
  const reviewCandidates = [...account.reviewCandidates].sort((a, b) =>
    a.observationId.localeCompare(b.observationId),
  );
  const missingSourcePages = [...account.missingSourcePages].sort((a, b) =>
    `${a.playerLabel}:${a.pageTitle}`.localeCompare(`${b.playerLabel}:${b.pageTitle}`),
  );
  return createHash('sha256')
    .update(
      canonicalize({
        uid: account.uid,
        sinceIndependentCounts: {
          matched: account.matched,
          ambiguous: account.ambiguous,
          unmatched: account.unmatched,
          conflicting: account.conflicting,
          gamesWithCanonicalStage: account.gamesWithCanonicalStage,
          gamesWithStageForm: account.gamesWithStageForm,
          gamesWithoutCanonicalStage: account.gamesWithoutCanonicalStage,
          stageWouldEnrich: account.stageWouldEnrich,
          vodWouldFillEmpty: account.vodWouldFillEmpty,
          vodWouldSkipUserOwned: account.vodWouldSkipUserOwned,
        },
        sourceRevisions,
        extractorVersions: [...account.extractorVersions].sort(),
        // 30.2 reliability gate: the reviewed write set covers the EXACT
        // schema-parsed observation records, not merely their counts.
        observationPersistenceHash: account.observationPersistenceHash,
        observationsValidated: account.observationsValidated,
        matchedCandidates,
        reviewCandidates,
        missingSourcePages,
      }),
    )
    .digest('hex');
}

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

export function computeEnrichmentManifestHash(body: EnrichmentManifestBody): string {
  return createHash('sha256')
    .update(canonicalize(manifestBodySchema.parse(body)))
    .digest('hex');
}

export function createEnrichmentManifest(body: EnrichmentManifestBody): EnrichmentManifest {
  const parsed = manifestBodySchema.parse(body);
  return { ...parsed, contentHash: computeEnrichmentManifestHash(parsed) };
}

export function validateEnrichmentManifest(
  raw: unknown,
  expectedUids: DemoUidMap,
  nowMs: number,
  maxAgeMs: number,
): EnrichmentManifest {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('Manifest max age must be a positive finite number');
  }
  // 30.2 reliability gate: refuse a manifest produced by an older parser/
  // validation version BY NAME, before the schema parse turns it into an
  // opaque literal-mismatch error.
  const declaredVersion =
    raw !== null && typeof raw === 'object'
      ? (raw as { formatVersion?: unknown }).formatVersion
      : undefined;
  if (declaredVersion !== ENRICHMENT_MANIFEST_FORMAT_VERSION) {
    throw new Error(
      `Manifest formatVersion ${String(declaredVersion)} was produced by an older ` +
        `parser/validation version (current: ${ENRICHMENT_MANIFEST_FORMAT_VERSION}); ` +
        'regenerate the manifest with dry-run before applying',
    );
  }
  const manifest = enrichmentManifestSchema.parse(raw);
  const { contentHash, ...body } = manifest;
  if (computeEnrichmentManifestHash(body) !== contentHash) {
    throw new Error('Manifest content hash mismatch');
  }
  const expected = uidMapSchema.parse(expectedUids);
  if (canonicalize(manifest.targetUids) !== canonicalize(expected)) {
    throw new Error('Manifest target UIDs do not match the supplied demo accounts');
  }
  if (new Set(Object.values(expected)).size !== demoWorkspaceKeys.length) {
    throw new Error('Every demo account UID must be unique');
  }
  if (manifest.generatedAtMs > nowMs || nowMs - manifest.generatedAtMs > maxAgeMs) {
    throw new Error('Manifest is stale or dated in the future');
  }
  for (const key of demoWorkspaceKeys) {
    if (manifest.accounts[key].uid !== expected[key]) {
      throw new Error(`Manifest account UID mismatch for ${key}`);
    }
    const { writeSetHash, ...account } = manifest.accounts[key];
    if (computeAccountWriteSetHash(account) !== writeSetHash) {
      throw new Error(`Manifest write-set hash mismatch for ${key}`);
    }
    if (manifest.accounts[key].matchedCandidates.length !== manifest.accounts[key].matched) {
      throw new Error(`Manifest matched candidate count mismatch for ${key}`);
    }
    if (
      manifest.accounts[key].reviewCandidates.length !==
      manifest.accounts[key].ambiguous + manifest.accounts[key].conflicting
    ) {
      throw new Error(`Manifest review candidate count mismatch for ${key}`);
    }
  }
  return manifest;
}

export interface EnrichmentComparisonRow {
  workspace: DemoWorkspaceKey;
  label: string;
  metric: keyof EnrichmentCoverageMetrics;
  before: number | null;
  after: number | null;
}

export function buildEnrichmentComparison(
  manifest: EnrichmentManifest,
  after: Record<DemoWorkspaceKey, EnrichmentCoverageMetrics>,
): EnrichmentComparisonRow[] {
  const rows: EnrichmentComparisonRow[] = [];
  for (const workspace of demoWorkspaceKeys) {
    const before = manifest.accounts[workspace].beforeCoverage;
    for (const metric of Object.keys(before) as (keyof EnrichmentCoverageMetrics)[]) {
      rows.push({
        workspace,
        label: manifest.accounts[workspace].label,
        metric,
        before: before[metric],
        after: after[workspace][metric],
      });
    }
  }
  return rows;
}

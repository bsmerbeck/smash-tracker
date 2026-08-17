import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
  isSourceOwnedVodValue,
  researchEnrichmentAttachmentRecordSchema,
  researchEnrichmentObservationRecordSchema,
  researchEnrichmentProjectionStateRecordSchema,
  researchEnrichmentResolutionReceiptRecordSchema,
  researchEnrichmentRunRecordSchema,
  type ResearchEnrichmentAttachmentRecord,
  type ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';
import { z } from 'zod';
import {
  buildLiquipediaVodCorroborationIdentity,
  normalizeLiquipediaVodUrl,
} from '../src/liquipedia/vodUrl.js';
import { liquipediaPageCacheRecordSchema } from '../src/liquipedia/revisionCache.js';
import { withRegistryDeadline } from '../src/research/registry/deadline.js';
import type { CandidateIndex } from '../src/research/enrichment/candidateIndex.js';
import {
  buildResolutionReceipt,
  deriveReceiptId,
  RESOLVER_VERSION,
  resolveObservation,
} from '../src/research/enrichment/resolution.js';
import {
  applyEnrichmentProjection,
  buildEnrichmentOverlay,
  previewEnrichmentProjection,
} from '../src/research/enrichment/projection.js';
import {
  enrichmentObservationFingerprintMatches,
  listAttachmentsForSet,
  readEnrichmentObservation,
  removeReplacedObservationAfterSuccessor,
} from '../src/research/enrichment/store.js';
import {
  acquireTerminalEnrichmentRunLease,
  releaseEnrichmentRunLease,
  renewEnrichmentRunLease,
  type EnrichmentRunLeaseHolder,
} from '../src/research/enrichment/runState.js';

/** The only production RTDB this bounded repair is allowed to mutate. */
export const ENRICHMENT_REPAIR_PRODUCTION_HOST = 'smash-tracker-f97b7.firebaseio.com';
export const ENRICHMENT_REPAIR_PRODUCTION_PROJECT = 'smash-tracker-f97b7';
export const ENRICHMENT_REPAIR_FORMAT_VERSION = 2;
export const ENRICHMENT_REPAIR_MAX_ACTIONS = 100;
export const ENRICHMENT_REPAIR_DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export const ENRICHMENT_REPAIR_TARGETS = {
  mkleo: {
    uid: 'eVJih9SgfJVk5oMPAQydPGbEBpU2',
    sourcePageTitle: 'MKLeo/VODs',
    currentCohortCount: 173,
    staleAuthorizationCount: 22,
    successorPairCount: 3,
  },
  sparg0: {
    uid: 'cosPe2wagVZsTWprGKnpjrcUEsb2',
    sourcePageTitle: 'Sparg0/VODs',
    currentCohortCount: 240,
    staleAuthorizationCount: 27,
    successorPairCount: 0,
  },
} as const;

const fingerprintSchema = z.object({
  sourceRevisionId: z.number().int(),
  sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  parserVersion: z.string().min(1),
});

const digestSchema = z.object({
  count: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

const staleAuthorizationSchema = z.object({
  observationId: z.string().min(1).max(200),
  sourcePageTitle: z.string().min(1),
  targetSetId: z.string().min(1).max(200),
  priorReceiptId: z.string().min(1).max(200),
  priorFingerprint: fingerprintSchema,
  currentFingerprint: fingerprintSchema,
});

const successorPairSchema = z.object({
  sourcePageTitle: z.string().min(1),
  predecessorObservationId: z.string().min(1).max(200),
  successorObservationId: z.string().min(1).max(200),
  semanticSignature: z.string().regex(/^[a-f0-9]{64}$/),
  targetSetId: z.string().min(1).max(200).nullable(),
});

const pageCohortSchema = z.object({
  sourcePageTitle: z.string().min(1),
  cacheContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  cacheObservationCount: z.number().int().nonnegative(),
  currentCohortCount: z.number().int().nonnegative(),
  largestPriorCohortCount: z.number().int().nonnegative(),
});

const repairPlanBodySchema = z.object({
  formatVersion: z.literal(ENRICHMENT_REPAIR_FORMAT_VERSION),
  generatedAtMs: z.number().int().nonnegative(),
  databaseHost: z.literal(ENRICHMENT_REPAIR_PRODUCTION_HOST),
  projectId: z.literal(ENRICHMENT_REPAIR_PRODUCTION_PROJECT),
  environment: z.literal('production'),
  databaseEmulatorHost: z.null(),
  account: z.enum(['mkleo', 'sparg0']),
  uid: z
    .string()
    .min(20)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  writesPerformed: z.literal(0),
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  protectedStateHash: z.string().regex(/^[a-f0-9]{64}$/),
  terminalRunId: z.string().uuid(),
  immutableVod: z.object({ manual: digestSchema, provider: digestSchema }),
  pageCohorts: z.array(pageCohortSchema),
  staleAuthorizations: z.array(staleAuthorizationSchema).max(ENRICHMENT_REPAIR_MAX_ACTIONS),
  successorPairs: z.array(successorPairSchema).max(ENRICHMENT_REPAIR_MAX_ACTIONS),
  blockedReasons: z.array(z.string()),
});

export type EnrichmentRepairPlanBody = z.infer<typeof repairPlanBodySchema>;
export const enrichmentRepairPlanSchema = repairPlanBodySchema.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EnrichmentRepairPlan = z.infer<typeof enrichmentRepairPlanSchema>;

interface RepairState {
  observationsRaw: Record<string, unknown>;
  receiptsRaw: Record<string, unknown>;
  attachmentsRaw: Record<string, Record<string, unknown>>;
  matchesRaw: Record<string, unknown>;
  projectionsRaw: Record<string, unknown>;
  sourceSetsRaw: Record<string, unknown>;
  runRaw: unknown;
  pageCaches: Record<string, unknown>;
  stateHash: string;
}

export interface EnrichmentRepairOptions {
  database: Database;
  databaseHost: string;
  projectId: string | null;
  environment: 'development' | 'test' | 'production';
  databaseEmulatorHost: string | null;
  account: 'mkleo' | 'sparg0';
  uid: string;
  nowMs: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (label: string) => void;
  /** Test seam and lifecycle clock; production CLI supplies Date.now. */
  now?: () => number;
  /** Test-only crash injection seam. Production leaves this undefined. */
  onCheckpoint?: (checkpoint: string) => void | Promise<void>;
}

export interface EnrichmentRepairApplyResult {
  staleAuthorizationsReauthorized: number;
  successorsAuthorized: number;
  predecessorsRemoved: number;
  targetSetsReprojected: number;
}

export interface EnrichmentRepairCompareResult extends EnrichmentRepairApplyResult {
  ok: boolean;
  findings: string[];
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

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function pageCacheKey(uid: string, title: string): string {
  return createHash('sha256').update(`${uid}\n${title}`).digest('hex').slice(0, 48);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function bounded<T>(
  options: EnrichmentRepairOptions,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  options.onProgress?.(label);
  return withRegistryDeadline(label, operation, {
    requestTimeoutMs: options.requestTimeoutMs,
    signal: options.signal,
  });
}

async function readValue(options: EnrichmentRepairOptions, path: string): Promise<unknown> {
  const snapshot = await bounded(options, `read ${path}`, () => options.database.ref(path).get());
  return snapshot.val();
}

function observationFingerprint(
  record: Pick<
    ResearchEnrichmentObservationRecord,
    'sourceRevisionId' | 'sourceContentHash' | 'parserVersion'
  >,
) {
  return {
    sourceRevisionId: record.sourceRevisionId,
    sourceContentHash: record.sourceContentHash,
    parserVersion: record.parserVersion,
  };
}

function semanticSignature(record: ResearchEnrichmentObservationRecord): string {
  const canonicalVod = record.rawVodUrl
    ? normalizeLiquipediaVodUrl(record.rawVodUrl).vodUrl
    : (record.vodUrl ?? null);
  return sha256({
    sourcePageTitle: record.sourcePageTitle,
    templateFamily: record.templateFamily,
    contentType: record.contentType,
    tournamentPageTitle: record.tournamentPageTitle ?? null,
    game: record.game?.toLowerCase() ?? null,
    canonicalVod,
    players:
      record.players?.map((player) => ({
        rawTag: player.rawTag.trim().toLowerCase(),
        canonicalPage: player.canonicalPage?.trim().toLowerCase() ?? null,
      })) ?? null,
  });
}

function validResolverAttachment(
  attachment: ResearchEnrichmentAttachmentRecord,
  observation: ResearchEnrichmentObservationRecord,
  rawReceipt: unknown,
): boolean {
  if (
    attachment.attachmentSource !== 'resolver' ||
    !enrichmentObservationFingerprintMatches(attachment, observation)
  ) {
    return false;
  }
  const parsed = researchEnrichmentResolutionReceiptRecordSchema.safeParse(rawReceipt);
  if (!parsed.success) {
    return false;
  }
  const receipt = parsed.data;
  return (
    receipt.observationId === observation.observationId &&
    receipt.targetSetId === attachment.targetSetId &&
    receipt.receiptId === attachment.receiptId &&
    enrichmentObservationFingerprintMatches(receipt, observation) &&
    deriveReceiptId({
      observationId: receipt.observationId,
      resolverVersion: receipt.resolverVersion,
      sourceContentHash: receipt.sourceContentHash,
    }) === receipt.receiptId
  );
}

function emptyCandidateIndex(): CandidateIndex {
  return {
    byTournamentSlug: new Map(),
    byCompetitorPair: new Map(),
    byCalendarDay: new Map(),
    getByTargetSetId: () => undefined,
    all: [],
    size: 0,
    skippedCount: 0,
  };
}

interface BracketCorroboration {
  exact: Map<string, string>;
  identities: Map<string, string>;
}

function buildBracketCorroboration(
  observations: Map<string, ResearchEnrichmentObservationRecord>,
  receiptsRaw: Record<string, unknown>,
  attachmentsRaw: Record<string, Record<string, unknown>>,
): BracketCorroboration {
  const exactCandidates = new Map<string, Set<string>>();
  const identityCandidates = new Map<string, Set<string>>();
  const exactContenderCounts = new Map<string, number>();
  const identityContenderCounts = new Map<string, number>();
  for (const observation of observations.values()) {
    if (
      observation.contentType === 'vod-reference' ||
      !observation.vodUrl ||
      !observation.tournamentPageTitle
    ) {
      continue;
    }
    const exactKey = `${observation.tournamentPageTitle}::${observation.vodUrl}`;
    exactContenderCounts.set(exactKey, (exactContenderCounts.get(exactKey) ?? 0) + 1);
    const identity = buildLiquipediaVodCorroborationIdentity(observation.vodUrl);
    if (identity) {
      const identityKey = `${observation.tournamentPageTitle}::${identity}`;
      identityContenderCounts.set(identityKey, (identityContenderCounts.get(identityKey) ?? 0) + 1);
    }
  }
  for (const [targetSetId, children] of Object.entries(attachmentsRaw)) {
    for (const [observationId, rawAttachment] of Object.entries(asRecord(children))) {
      const attachmentParsed = researchEnrichmentAttachmentRecordSchema.safeParse(rawAttachment);
      const observation = observations.get(observationId);
      if (
        !attachmentParsed.success ||
        !observation ||
        observation.contentType === 'vod-reference'
      ) {
        continue;
      }
      const attachment = attachmentParsed.data;
      const authorized =
        attachment.attachmentSource === 'admin'
          ? enrichmentObservationFingerprintMatches(attachment, observation)
          : validResolverAttachment(attachment, observation, receiptsRaw[observationId]);
      if (!authorized || !observation.vodUrl || !observation.tournamentPageTitle) {
        continue;
      }
      const key = `${observation.tournamentPageTitle}::${observation.vodUrl}`;
      const targets = exactCandidates.get(key) ?? new Set<string>();
      targets.add(targetSetId);
      exactCandidates.set(key, targets);
      const identity = buildLiquipediaVodCorroborationIdentity(observation.vodUrl);
      if (identity) {
        const identityKey = `${observation.tournamentPageTitle}::${identity}`;
        const identityTargets = identityCandidates.get(identityKey) ?? new Set<string>();
        identityTargets.add(targetSetId);
        identityCandidates.set(identityKey, identityTargets);
      }
    }
  }
  const unique = (
    candidates: Map<string, Set<string>>,
    contenderCounts: Map<string, number>,
  ): Map<string, string> => {
    const resolved = new Map<string, string>();
    for (const [key, targets] of candidates) {
      // One resolved target is insufficient when another bracket row on the
      // same broadcast remains unresolved. Every bracket observation is a
      // contender; fallback is authorized only by one row total, resolved
      // to one target.
      if (targets.size === 1 && contenderCounts.get(key) === 1) {
        resolved.set(key, [...targets][0]!);
      }
    }
    return resolved;
  };
  // Ambiguity is a normal abstention for the offset-insensitive fallback,
  // not a plan-wide error (GF/reset often share a video). Exact duplicates
  // are likewise omitted rather than last-writer-wins.
  return {
    exact: unique(exactCandidates, exactContenderCounts),
    identities: unique(identityCandidates, identityContenderCounts),
  };
}

function resolveVodTarget(
  observation: ResearchEnrichmentObservationRecord,
  corroboration: BracketCorroboration,
): string | null {
  const outcome = resolveObservation(observation, emptyCandidateIndex(), {
    matchedBracketVodUrls: corroboration.exact,
    matchedBracketVodIdentities: corroboration.identities,
  });
  return outcome.type === 'matched' ? outcome.targetSetId : null;
}

function digest(entries: { key: string; value: string }[]) {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  return { count: sorted.length, digest: sha256(sorted) };
}

function immutableVodDigests(
  state: Pick<RepairState, 'matchesRaw' | 'projectionsRaw' | 'sourceSetsRaw'>,
) {
  const providerExpected = new Map<string, string>();
  for (const value of Object.values(state.sourceSetsRaw)) {
    const row = asRecord(value);
    const vodUrl = typeof row.vodUrl === 'string' ? row.vodUrl : null;
    const keys = Array.isArray(row.projectedMatchKeys) ? row.projectedMatchKeys : [];
    if (!vodUrl) continue;
    for (const key of keys) {
      if (typeof key === 'string') providerExpected.set(key, vodUrl);
    }
  }
  const provider: { key: string; value: string }[] = [];
  for (const [key, expected] of providerExpected) {
    const actual = asRecord(state.matchesRaw[key]).vodUrl;
    if (actual !== expected) {
      throw new Error(`provider VOD ${key} does not equal its lossless source-set value`);
    }
    provider.push({ key, value: expected });
  }
  const manual: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(state.matchesRaw)) {
    const vodUrl = asRecord(value).vodUrl;
    if (typeof vodUrl !== 'string' || providerExpected.has(key)) continue;
    const witnessParsed = researchEnrichmentProjectionStateRecordSchema.safeParse(
      state.projectionsRaw[key],
    );
    const witness = witnessParsed.success ? witnessParsed.data : null;
    if (!isSourceOwnedVodValue(vodUrl, witness)) manual.push({ key, value: vodUrl });
  }
  return { manual: digest(manual), provider: digest(provider) };
}

async function loadState(options: EnrichmentRepairOptions): Promise<RepairState> {
  const uid = options.uid;
  const [observations, receipts, attachments, matches, projections, sourceSets, run] =
    await Promise.all([
      readValue(options, `researchEnrichmentObservations/${uid}`),
      readValue(options, `researchEnrichmentReceipts/${uid}`),
      readValue(options, `researchEnrichmentAttachments/${uid}`),
      readValue(options, `matches/${uid}`),
      readValue(options, `researchEnrichmentProjection/${uid}`),
      readValue(options, `researchSource/${uid}/sets`),
      readValue(options, `researchEnrichmentRuns/${uid}`),
    ]);
  const observationsRaw = asRecord(observations);
  const pageTitles = new Set<string>();
  for (const value of Object.values(observationsRaw)) {
    const parsed = researchEnrichmentObservationRecordSchema.safeParse(value);
    if (parsed.success && parsed.data.templateFamily === 'vodlist') {
      pageTitles.add(parsed.data.sourcePageTitle);
    }
  }
  const pageCaches: Record<string, unknown> = {};
  for (const title of [...pageTitles].sort()) {
    pageCaches[title] = await readValue(options, `liquipediaPageCache/${pageCacheKey(uid, title)}`);
  }
  const rawState = {
    observationsRaw,
    receiptsRaw: asRecord(receipts),
    attachmentsRaw: asRecord(attachments) as Record<string, Record<string, unknown>>,
    matchesRaw: asRecord(matches),
    projectionsRaw: asRecord(projections),
    sourceSetsRaw: asRecord(sourceSets),
    runRaw: run,
    pageCaches,
  };
  return { ...rawState, stateHash: sha256(rawState) };
}

function mutableRepairIds(
  staleAuthorizations: EnrichmentRepairPlanBody['staleAuthorizations'],
  successorPairs: EnrichmentRepairPlanBody['successorPairs'],
) {
  const observationIds = new Set<string>();
  const predecessorIds = new Set<string>();
  const targetSetIds = new Set<string>();
  for (const action of staleAuthorizations) {
    observationIds.add(action.observationId);
    targetSetIds.add(action.targetSetId);
  }
  for (const pair of successorPairs) {
    observationIds.add(pair.predecessorObservationId);
    observationIds.add(pair.successorObservationId);
    predecessorIds.add(pair.predecessorObservationId);
    if (pair.targetSetId) targetSetIds.add(pair.targetSetId);
  }
  return { observationIds, predecessorIds, targetSetIds };
}

/**
 * Hashes every live member the reviewed repair is not allowed to change.
 * The mutable authorization rows, predecessor rows, and projections for the
 * explicitly sealed target sets are removed first. A crash/resume may move
 * only within that monotonic subset; any unrelated RTDB drift invalidates
 * the reviewed plan.
 */
function computeProtectedStateHash(
  state: RepairState,
  staleAuthorizations: EnrichmentRepairPlanBody['staleAuthorizations'],
  successorPairs: EnrichmentRepairPlanBody['successorPairs'],
): string {
  const { observationIds, predecessorIds, targetSetIds } = mutableRepairIds(
    staleAuthorizations,
    successorPairs,
  );
  const observations = Object.fromEntries(
    Object.entries(state.observationsRaw).filter(([id]) => !predecessorIds.has(id)),
  );
  const receipts = Object.fromEntries(
    Object.entries(state.receiptsRaw).filter(([id]) => !observationIds.has(id)),
  );
  const attachments = Object.fromEntries(
    Object.entries(state.attachmentsRaw).map(([targetSetId, children]) => [
      targetSetId,
      Object.fromEntries(
        Object.entries(asRecord(children)).filter(([id]) => !observationIds.has(id)),
      ),
    ]),
  );
  const matches = Object.fromEntries(
    Object.entries(state.matchesRaw).filter(
      ([key]) => ![...targetSetIds].some((target) => key.startsWith(`sgg-${target}-g`)),
    ),
  );
  const projections = Object.fromEntries(
    Object.entries(state.projectionsRaw).filter(([, raw]) => {
      const parsed = researchEnrichmentProjectionStateRecordSchema.safeParse(raw);
      return !parsed.success || !targetSetIds.has(parsed.data.targetSetId);
    }),
  );
  // Maintenance lease acquisition changes only these two fencing members.
  // Every other terminal-run member remains protected.
  const protectedRun = { ...asRecord(state.runRaw) };
  delete protectedRun.lease;
  delete protectedRun.leaseFenceCounter;
  return sha256({
    observations,
    receipts,
    attachments,
    matches,
    projections,
    sourceSetsRaw: state.sourceSetsRaw,
    runRaw: protectedRun,
    pageCaches: state.pageCaches,
  });
}

function assertProductionScope(options: EnrichmentRepairOptions): void {
  if (options.environment !== 'production') {
    throw new Error(`repair requires NODE_ENV=production; received ${options.environment}`);
  }
  if (options.databaseHost !== ENRICHMENT_REPAIR_PRODUCTION_HOST) {
    throw new Error(
      `repair requires exact production host ${ENRICHMENT_REPAIR_PRODUCTION_HOST}; received ${options.databaseHost}`,
    );
  }
  if (options.projectId !== ENRICHMENT_REPAIR_PRODUCTION_PROJECT) {
    throw new Error(
      `repair requires Firebase project ${ENRICHMENT_REPAIR_PRODUCTION_PROJECT}; received ${String(options.projectId)}`,
    );
  }
  if (options.databaseEmulatorHost !== null) {
    throw new Error(
      `repair refuses FIREBASE_DATABASE_EMULATOR_HOST=${options.databaseEmulatorHost}; effective target would not be production`,
    );
  }
  const expected = ENRICHMENT_REPAIR_TARGETS[options.account];
  if (options.uid !== expected.uid) {
    throw new Error(
      `${options.account} repair is bound to demo uid ${expected.uid}; received ${options.uid}`,
    );
  }
}

function analyzeState(
  options: EnrichmentRepairOptions,
  state: RepairState,
): EnrichmentRepairPlanBody {
  // Re-validated here (not only in assertProductionScope) so the plan body
  // can carry the literal the schema demands without ever widening it: a
  // non-production process must be REFUSED, never encoded into a plan.
  const { environment } = options;
  if (environment !== 'production') {
    throw new Error(`repair plan bodies are production-only; received environment ${environment}`);
  }
  const blockedReasons: string[] = [];
  const runParsed = researchEnrichmentRunRecordSchema.safeParse(state.runRaw);
  const terminalRunId = runParsed.success
    ? runParsed.data.runId
    : '00000000-0000-4000-8000-000000000000';
  if (!runParsed.success) {
    blockedReasons.push(
      'a parseable terminal enrichment run is required for the maintenance lease',
    );
  } else if (runParsed.data.status === 'running') {
    blockedReasons.push('an enrichment run is currently active');
  }

  const observations = new Map<string, ResearchEnrichmentObservationRecord>();
  for (const [id, raw] of Object.entries(state.observationsRaw)) {
    const parsed = researchEnrichmentObservationRecordSchema.safeParse(raw);
    if (parsed.success) observations.set(id, parsed.data);
  }
  const corroboration = buildBracketCorroboration(
    observations,
    state.receiptsRaw,
    state.attachmentsRaw,
  );

  const staleAuthorizations: EnrichmentRepairPlanBody['staleAuthorizations'] = [];
  const attachmentsByObservation = new Map<
    string,
    { targetSetId: string; attachment: ResearchEnrichmentAttachmentRecord }[]
  >();
  for (const [targetSetId, children] of Object.entries(state.attachmentsRaw)) {
    for (const [observationId, rawAttachment] of Object.entries(asRecord(children))) {
      const parsed = researchEnrichmentAttachmentRecordSchema.safeParse(rawAttachment);
      if (!parsed.success) continue;
      const list = attachmentsByObservation.get(observationId) ?? [];
      list.push({ targetSetId, attachment: parsed.data });
      attachmentsByObservation.set(observationId, list);
    }
  }

  for (const [observationId, entries] of attachmentsByObservation) {
    const observation = observations.get(observationId);
    if (!observation || observation.templateFamily !== 'vodlist') continue;
    const stale = entries.filter(
      ({ attachment }) => !enrichmentObservationFingerprintMatches(attachment, observation),
    );
    if (stale.length === 0) continue;
    if (entries.length !== 1 || stale.length !== 1) {
      blockedReasons.push(`${observationId} has multiple attachments; repair will not guess`);
      continue;
    }
    const { targetSetId, attachment } = stale[0]!;
    if (attachment.attachmentSource !== 'resolver' || !attachment.receiptId) {
      blockedReasons.push(`${observationId} has a stale non-resolver attachment`);
      continue;
    }
    const receiptParsed = researchEnrichmentResolutionReceiptRecordSchema.safeParse(
      state.receiptsRaw[observationId],
    );
    if (
      !receiptParsed.success ||
      receiptParsed.data.receiptId !== attachment.receiptId ||
      receiptParsed.data.targetSetId !== targetSetId ||
      !enrichmentObservationFingerprintMatches(receiptParsed.data, attachment) ||
      deriveReceiptId({
        observationId,
        resolverVersion: receiptParsed.data.resolverVersion,
        sourceContentHash: receiptParsed.data.sourceContentHash,
      }) !== receiptParsed.data.receiptId
    ) {
      blockedReasons.push(`${observationId} lacks a self-consistent prior resolver receipt`);
      continue;
    }
    const resolvedTarget = resolveVodTarget(observation, corroboration);
    if (resolvedTarget !== targetSetId) {
      blockedReasons.push(
        `${observationId} now resolves to ${resolvedTarget ?? 'abstain'}, not prior target ${targetSetId}`,
      );
      continue;
    }
    staleAuthorizations.push({
      observationId,
      sourcePageTitle: observation.sourcePageTitle,
      targetSetId,
      priorReceiptId: receiptParsed.data.receiptId,
      priorFingerprint: observationFingerprint(attachment),
      currentFingerprint: observationFingerprint(observation),
    });
  }

  const successorPairs: EnrichmentRepairPlanBody['successorPairs'] = [];
  const pageCohorts: EnrichmentRepairPlanBody['pageCohorts'] = [];
  const byPage = new Map<string, ResearchEnrichmentObservationRecord[]>();
  for (const observation of observations.values()) {
    if (
      observation.templateFamily !== 'vodlist' ||
      observation.parserVersion !== LIQUIPEDIA_PARSER_VERSION_VOD_LIST
    ) {
      continue;
    }
    const rows = byPage.get(observation.sourcePageTitle) ?? [];
    rows.push(observation);
    byPage.set(observation.sourcePageTitle, rows);
  }
  for (const [sourcePageTitle, rows] of byPage) {
    const cacheParsed = liquipediaPageCacheRecordSchema.safeParse(
      state.pageCaches[sourcePageTitle],
    );
    if (
      !cacheParsed.success ||
      cacheParsed.data.pageClass !== 'generated' ||
      cacheParsed.data.parserVersion !== LIQUIPEDIA_PARSER_VERSION_VOD_LIST ||
      !cacheParsed.data.contentHash ||
      cacheParsed.data.observationCount == null
    ) {
      blockedReasons.push(`${sourcePageTitle} has no valid current generated-page cache contract`);
      continue;
    }
    const cacheContentHash = cacheParsed.data.contentHash as string;
    const cacheObservationCount = cacheParsed.data.observationCount as number;
    const current = rows.filter((row) => row.sourceContentHash === cacheContentHash);
    const priorCohorts = new Map<string, number>();
    for (const row of rows.filter(
      (candidate) => candidate.sourceContentHash !== cacheContentHash,
    )) {
      priorCohorts.set(row.sourceContentHash, (priorCohorts.get(row.sourceContentHash) ?? 0) + 1);
    }
    const largestPriorCohortCount = Math.max(0, ...priorCohorts.values());
    pageCohorts.push({
      sourcePageTitle,
      cacheContentHash,
      cacheObservationCount,
      currentCohortCount: current.length,
      largestPriorCohortCount,
    });
    if (current.length !== cacheObservationCount) {
      blockedReasons.push(
        `${sourcePageTitle} current cohort ${current.length} != cache observationCount ${cacheObservationCount}`,
      );
      continue;
    }
    // The non-current cohort is only the surviving OBSOLETE tail, not the
    // previous full-page extraction (stable ids were overwritten in place),
    // so comparing its size with the current full count would be a false
    // shrink test (production: 3 leftovers beside 173 current MkLeo rows).
    // The load-bearing no-shrink bound is the cache's own reviewed full-page
    // observationCount above; obsolete rows are eligible only one-for-one
    // against an exact semantic successor and unmatched rows are retained.
    const currentBySignature = new Map<string, ResearchEnrichmentObservationRecord[]>();
    for (const row of current) {
      const signature = semanticSignature(row);
      const matches = currentBySignature.get(signature) ?? [];
      matches.push(row);
      currentBySignature.set(signature, matches);
    }
    for (const predecessor of rows.filter((row) => row.sourceContentHash !== cacheContentHash)) {
      const signature = semanticSignature(predecessor);
      const successors = currentBySignature.get(signature) ?? [];
      if (successors.length !== 1 || successors[0]!.observationId === predecessor.observationId) {
        continue;
      }
      const successor = successors[0]!;
      const predecessorAttachments = attachmentsByObservation.get(predecessor.observationId) ?? [];
      let targetSetId: string | null = null;
      if (predecessorAttachments.length > 1) {
        blockedReasons.push(`${predecessor.observationId} has multiple attachments`);
        continue;
      }
      if (predecessorAttachments.length === 1) {
        const prior = predecessorAttachments[0]!;
        if (
          !validResolverAttachment(
            prior.attachment,
            predecessor,
            state.receiptsRaw[predecessor.observationId],
          )
        ) {
          blockedReasons.push(
            `${predecessor.observationId} is attached without valid resolver evidence`,
          );
          continue;
        }
        targetSetId = prior.targetSetId;
        if (resolveVodTarget(successor, corroboration) !== targetSetId) {
          blockedReasons.push(
            `${successor.observationId} does not independently resolve to predecessor target ${targetSetId}`,
          );
          continue;
        }
      } else if (state.receiptsRaw[predecessor.observationId] != null) {
        blockedReasons.push(`${predecessor.observationId} is unattached but still has a receipt`);
        continue;
      }
      successorPairs.push({
        sourcePageTitle,
        predecessorObservationId: predecessor.observationId,
        successorObservationId: successor.observationId,
        semanticSignature: signature,
        targetSetId,
      });
    }
  }

  if (staleAuthorizations.length + successorPairs.length > ENRICHMENT_REPAIR_MAX_ACTIONS) {
    blockedReasons.push(`repair exceeds ${ENRICHMENT_REPAIR_MAX_ACTIONS} bounded actions`);
  }

  const expected = ENRICHMENT_REPAIR_TARGETS[options.account];
  const expectedCohort = pageCohorts.find(
    (cohort) => cohort.sourcePageTitle === expected.sourcePageTitle,
  );
  if (!expectedCohort || expectedCohort.currentCohortCount !== expected.currentCohortCount) {
    blockedReasons.push(
      `${options.account} anti-vacuity: expected ${expected.currentCohortCount} current rows on ${expected.sourcePageTitle}`,
    );
  }
  if (staleAuthorizations.length !== expected.staleAuthorizationCount) {
    blockedReasons.push(
      `${options.account} anti-vacuity: expected ${expected.staleAuthorizationCount} stale authorizations, found ${staleAuthorizations.length}`,
    );
  }
  if (successorPairs.length !== expected.successorPairCount) {
    blockedReasons.push(
      `${options.account} anti-vacuity: expected ${expected.successorPairCount} successor pairs, found ${successorPairs.length}`,
    );
  }

  const sortedStaleAuthorizations = staleAuthorizations.sort((a, b) =>
    a.observationId.localeCompare(b.observationId),
  );
  const sortedSuccessorPairs = successorPairs.sort((a, b) =>
    a.predecessorObservationId.localeCompare(b.predecessorObservationId),
  );
  return {
    formatVersion: ENRICHMENT_REPAIR_FORMAT_VERSION,
    generatedAtMs: options.nowMs,
    databaseHost: ENRICHMENT_REPAIR_PRODUCTION_HOST,
    projectId: ENRICHMENT_REPAIR_PRODUCTION_PROJECT,
    environment,
    databaseEmulatorHost: null,
    account: options.account,
    uid: options.uid,
    writesPerformed: 0,
    stateHash: state.stateHash,
    protectedStateHash: computeProtectedStateHash(
      state,
      sortedStaleAuthorizations,
      sortedSuccessorPairs,
    ),
    terminalRunId,
    immutableVod: immutableVodDigests(state),
    pageCohorts: pageCohorts.sort((a, b) => a.sourcePageTitle.localeCompare(b.sourcePageTitle)),
    staleAuthorizations: sortedStaleAuthorizations,
    successorPairs: sortedSuccessorPairs,
    blockedReasons: [...new Set(blockedReasons)].sort(),
  };
}

export function computeEnrichmentRepairPlanHash(body: EnrichmentRepairPlanBody): string {
  return sha256(repairPlanBodySchema.parse(body));
}

export async function createEnrichmentRepairPlan(
  options: EnrichmentRepairOptions,
): Promise<EnrichmentRepairPlan> {
  assertProductionScope(options);
  const body = analyzeState(options, await loadState(options));
  return { ...body, contentHash: computeEnrichmentRepairPlanHash(body) };
}

export function validateEnrichmentRepairPlan(
  raw: unknown,
  options: EnrichmentRepairOptions,
  maxAgeMs = ENRICHMENT_REPAIR_DEFAULT_MAX_AGE_MS,
): EnrichmentRepairPlan {
  assertProductionScope(options);
  const parsed = enrichmentRepairPlanSchema.parse(raw);
  const { contentHash, ...body } = parsed;
  if (computeEnrichmentRepairPlanHash(body) !== contentHash) {
    throw new Error('repair plan content hash mismatch');
  }
  if (parsed.uid !== options.uid || parsed.account !== options.account) {
    throw new Error('repair plan account scope does not match the requested account');
  }
  if (
    parsed.projectId !== options.projectId ||
    parsed.environment !== options.environment ||
    options.databaseEmulatorHost !== null
  ) {
    throw new Error('repair plan effective environment does not match this process');
  }
  if (parsed.generatedAtMs > options.nowMs || options.nowMs - parsed.generatedAtMs > maxAgeMs) {
    throw new Error('repair plan is stale or dated in the future');
  }
  if (parsed.blockedReasons.length > 0) {
    throw new Error(`repair plan is blocked: ${parsed.blockedReasons.join('; ')}`);
  }
  return parsed;
}

async function projectTargetSet(
  options: EnrichmentRepairOptions,
  targetSetId: string,
): Promise<void> {
  const attachments = await bounded(options, `list attachments ${targetSetId}`, () =>
    listAttachmentsForSet(options.database, options.uid, targetSetId),
  );
  const observations: Record<string, ResearchEnrichmentObservationRecord> = {};
  for (const attachment of attachments) {
    const observation = await bounded(options, `read observation ${attachment.observationId}`, () =>
      readEnrichmentObservation(options.database, options.uid, attachment.observationId),
    );
    if (observation) observations[attachment.observationId] = observation;
  }
  const overlay = buildEnrichmentOverlay({ targetSetId, attachments, observations });
  await bounded(options, `project ${targetSetId}`, () =>
    applyEnrichmentProjection(options.database, options.uid, targetSetId, overlay, options.nowMs),
  );
}

/**
 * Successor-first convergence proof for one repaired target set: the stored
 * rows AND witness must already equal what the set's CURRENT authorized
 * attachments project. Read-only — it reuses the projection module's own
 * preview (never a reimplementation), so "converged" here can never drift
 * from what apply would do; any row the preview would still change is a
 * finding, and the caller refuses the predecessor cascade on any finding.
 */
async function compareTargetProjection(
  options: EnrichmentRepairOptions,
  targetSetId: string,
): Promise<{ ok: boolean; findings: string[] }> {
  const attachments = await bounded(options, `list attachments ${targetSetId}`, () =>
    listAttachmentsForSet(options.database, options.uid, targetSetId),
  );
  const observations: Record<string, ResearchEnrichmentObservationRecord> = {};
  for (const attachment of attachments) {
    const observation = await bounded(options, `read observation ${attachment.observationId}`, () =>
      readEnrichmentObservation(options.database, options.uid, attachment.observationId),
    );
    if (observation) observations[attachment.observationId] = observation;
  }
  const overlay = buildEnrichmentOverlay({ targetSetId, attachments, observations });
  const preview = await bounded(options, `compare projection ${targetSetId}`, () =>
    previewEnrichmentProjection(options.database, options.uid, targetSetId, overlay),
  );
  const findings: string[] = [];
  for (const row of preview.rows) {
    if (row.wouldChangeRow === true) {
      findings.push(`${targetSetId} row ${row.matchKey} stored values differ from its projection`);
    }
    if (row.wouldChangeWitness === true) {
      findings.push(`${targetSetId} row ${row.matchKey} witness differs from its projection`);
    }
  }
  return { ok: findings.length === 0, findings };
}

function fingerprintEquals(
  value: Pick<
    ResearchEnrichmentObservationRecord,
    'sourceRevisionId' | 'sourceContentHash' | 'parserVersion'
  >,
  expected: z.infer<typeof fingerprintSchema>,
): boolean {
  return (
    value.sourceRevisionId === expected.sourceRevisionId &&
    value.sourceContentHash === expected.sourceContentHash &&
    value.parserVersion === expected.parserVersion
  );
}

function attachmentsForObservation(state: RepairState, observationId: string) {
  const found: { targetSetId: string; attachment: ResearchEnrichmentAttachmentRecord }[] = [];
  for (const [targetSetId, children] of Object.entries(state.attachmentsRaw)) {
    const parsed = researchEnrichmentAttachmentRecordSchema.safeParse(
      asRecord(children)[observationId],
    );
    if (parsed.success) found.push({ targetSetId, attachment: parsed.data });
  }
  return found;
}

function hasFreshAuthorization(
  state: RepairState,
  observation: ResearchEnrichmentObservationRecord,
  targetSetId: string,
): boolean {
  const attachments = attachmentsForObservation(state, observation.observationId);
  if (attachments.length !== 1 || attachments[0]!.targetSetId !== targetSetId) return false;
  const receipt = researchEnrichmentResolutionReceiptRecordSchema.safeParse(
    state.receiptsRaw[observation.observationId],
  );
  return (
    receipt.success &&
    receipt.data.resolverVersion === RESOLVER_VERSION &&
    validResolverAttachment(attachments[0]!.attachment, observation, receipt.data)
  );
}

function hasReviewedPriorAuthorization(
  state: RepairState,
  action: EnrichmentRepairPlanBody['staleAuthorizations'][number],
): boolean {
  const attachments = attachmentsForObservation(state, action.observationId);
  const receipt = researchEnrichmentResolutionReceiptRecordSchema.safeParse(
    state.receiptsRaw[action.observationId],
  );
  if (
    attachments.length !== 1 ||
    attachments[0]!.targetSetId !== action.targetSetId ||
    !receipt.success
  ) {
    return false;
  }
  const attachment = attachments[0]!.attachment;
  return (
    attachment.attachmentSource === 'resolver' &&
    attachment.receiptId === action.priorReceiptId &&
    receipt.data.receiptId === action.priorReceiptId &&
    receipt.data.targetSetId === action.targetSetId &&
    fingerprintEquals(attachment, action.priorFingerprint) &&
    fingerprintEquals(receipt.data, action.priorFingerprint) &&
    deriveReceiptId({
      observationId: receipt.data.observationId,
      resolverVersion: receipt.data.resolverVersion,
      sourceContentHash: receipt.data.sourceContentHash,
    }) === receipt.data.receiptId
  );
}

function assertMonotonicReviewedState(plan: EnrichmentRepairPlan, state: RepairState): void {
  if (
    computeProtectedStateHash(state, plan.staleAuthorizations, plan.successorPairs) !==
    plan.protectedStateHash
  ) {
    throw new Error('live state changed outside the reviewed repair paths');
  }
  if (canonicalize(immutableVodDigests(state)) !== canonicalize(plan.immutableVod)) {
    throw new Error('provider/manual VOD digest differs from the reviewed pre-state');
  }
  const run = researchEnrichmentRunRecordSchema.safeParse(state.runRaw);
  if (!run.success || run.data.runId !== plan.terminalRunId || run.data.status === 'running') {
    throw new Error('reviewed terminal enrichment run changed');
  }
  for (const action of plan.staleAuthorizations) {
    const observation = researchEnrichmentObservationRecordSchema.safeParse(
      state.observationsRaw[action.observationId],
    );
    if (!observation.success || !fingerprintEquals(observation.data, action.currentFingerprint)) {
      throw new Error(`${action.observationId} current observation drifted`);
    }
    if (
      !hasFreshAuthorization(state, observation.data, action.targetSetId) &&
      !hasReviewedPriorAuthorization(state, action)
    ) {
      throw new Error(`${action.observationId} is not in a reviewed prior-or-fresh state`);
    }
  }
  for (const pair of plan.successorPairs) {
    const successor = researchEnrichmentObservationRecordSchema.safeParse(
      state.observationsRaw[pair.successorObservationId],
    );
    if (!successor.success || semanticSignature(successor.data) !== pair.semanticSignature) {
      throw new Error(`${pair.successorObservationId} successor drifted`);
    }
    const predecessor = researchEnrichmentObservationRecordSchema.safeParse(
      state.observationsRaw[pair.predecessorObservationId],
    );
    if (predecessor.success && semanticSignature(predecessor.data) !== pair.semanticSignature) {
      throw new Error(`${pair.predecessorObservationId} predecessor drifted`);
    }
    const successorFresh = pair.targetSetId
      ? hasFreshAuthorization(state, successor.data, pair.targetSetId)
      : attachmentsForObservation(state, pair.successorObservationId).length === 0 &&
        state.receiptsRaw[pair.successorObservationId] == null;
    const successorHasPartial =
      attachmentsForObservation(state, pair.successorObservationId).length > 0 ||
      state.receiptsRaw[pair.successorObservationId] != null;
    if (!successorFresh && successorHasPartial) {
      throw new Error(`${pair.successorObservationId} has a non-monotonic partial authorization`);
    }
    if (!predecessor.success && !successorFresh) {
      throw new Error(`${pair.predecessorObservationId} was removed before successor convergence`);
    }
  }
}

function freshAuthorizationPatch(
  uid: string,
  observation: ResearchEnrichmentObservationRecord,
  targetSetId: string,
  corroboration: BracketCorroboration,
  nowMs: number,
): Record<string, unknown> {
  const outcome = resolveObservation(observation, emptyCandidateIndex(), {
    matchedBracketVodUrls: corroboration.exact,
    matchedBracketVodIdentities: corroboration.identities,
  });
  if (outcome.type !== 'matched' || outcome.targetSetId !== targetSetId) {
    throw new Error(`${observation.observationId} no longer resolves to ${targetSetId}`);
  }
  const receipt = buildResolutionReceipt(observation, outcome, nowMs);
  if (!receipt || receipt.resolverVersion !== RESOLVER_VERSION) {
    throw new Error(`${observation.observationId} did not produce a current resolver receipt`);
  }
  const attachment = researchEnrichmentAttachmentRecordSchema.parse({
    observationId: observation.observationId,
    targetSetId,
    attachmentSource: 'resolver',
    attachedAtMs: nowMs,
    sourceRevisionId: observation.sourceRevisionId,
    sourceContentHash: observation.sourceContentHash,
    parserVersion: observation.parserVersion,
    receiptId: receipt.receiptId,
    matchEvidence: receipt.evidence,
  });
  return {
    [`researchEnrichmentReceipts/${uid}/${observation.observationId}`]: receipt,
    [`researchEnrichmentAttachments/${uid}/${targetSetId}/${observation.observationId}`]:
      attachment,
  };
}

async function renewRepairLease(
  options: EnrichmentRepairOptions,
  runId: string,
  holder: EnrichmentRunLeaseHolder,
): Promise<void> {
  const renewed = await renewEnrichmentRunLease(
    options.database,
    options.uid,
    runId,
    holder,
    options.now?.() ?? options.nowMs,
  );
  if (!renewed) throw new Error('repair maintenance lease was lost');
}

async function executeEnrichmentRepairPlan(
  rawPlan: unknown,
  options: EnrichmentRepairOptions,
  mode: 'apply' | 'resume',
  maxAgeMs: number,
): Promise<EnrichmentRepairApplyResult> {
  const plan = validateEnrichmentRepairPlan(rawPlan, options, maxAgeMs);
  const initial = await loadState(options);
  if (mode === 'apply' && initial.stateHash !== plan.stateHash) {
    throw new Error(
      'initial apply requires the exact reviewed state; use resume after an interruption',
    );
  }
  assertMonotonicReviewedState(plan, initial);
  const ownerId = `enrichment-repair:${randomUUID()}`;
  const acquired = await acquireTerminalEnrichmentRunLease(
    options.database,
    options.uid,
    plan.terminalRunId,
    ownerId,
    options.now?.() ?? options.nowMs,
  );
  if (!acquired.acquired || !acquired.holder) {
    throw new Error(
      `could not acquire terminal maintenance lease (held by ${acquired.heldBy ?? 'unknown'})`,
    );
  }
  const holder = acquired.holder;
  try {
    let state = await loadState(options);
    assertMonotonicReviewedState(plan, state);
    const observations = new Map<string, ResearchEnrichmentObservationRecord>();
    for (const [id, raw] of Object.entries(state.observationsRaw)) {
      const parsed = researchEnrichmentObservationRecordSchema.safeParse(raw);
      if (parsed.success) observations.set(id, parsed.data);
    }
    const corroboration = buildBracketCorroboration(
      observations,
      state.receiptsRaw,
      state.attachmentsRaw,
    );

    const authorizationPatch: Record<string, unknown> = {};
    for (const action of plan.staleAuthorizations) {
      const observation = observations.get(action.observationId)!;
      if (!hasFreshAuthorization(state, observation, action.targetSetId)) {
        Object.assign(
          authorizationPatch,
          freshAuthorizationPatch(
            options.uid,
            observation,
            action.targetSetId,
            corroboration,
            options.now?.() ?? options.nowMs,
          ),
        );
      }
    }
    for (const pair of plan.successorPairs) {
      if (!pair.targetSetId) continue;
      const successor = observations.get(pair.successorObservationId)!;
      if (!hasFreshAuthorization(state, successor, pair.targetSetId)) {
        Object.assign(
          authorizationPatch,
          freshAuthorizationPatch(
            options.uid,
            successor,
            pair.targetSetId,
            corroboration,
            options.now?.() ?? options.nowMs,
          ),
        );
      }
    }
    if (Object.keys(authorizationPatch).length > 0) {
      await renewRepairLease(options, plan.terminalRunId, holder);
      await bounded(options, 'atomic authorization repair', () =>
        options.database.ref().update(authorizationPatch),
      );
    }
    await options.onCheckpoint?.('after-authorization');

    state = await loadState(options);
    assertMonotonicReviewedState(plan, state);
    const touchedTargets = new Set<string>([
      ...plan.staleAuthorizations.map((action) => action.targetSetId),
      ...plan.successorPairs.flatMap((pair) => (pair.targetSetId ? [pair.targetSetId] : [])),
    ]);
    for (const targetSetId of touchedTargets) {
      await renewRepairLease(options, plan.terminalRunId, holder);
      await projectTargetSet(options, targetSetId);
      await options.onCheckpoint?.(`after-projection:${targetSetId}`);
    }

    for (const pair of plan.successorPairs) {
      const predecessor = await readEnrichmentObservation(
        options.database,
        options.uid,
        pair.predecessorObservationId,
      );
      if (!predecessor) continue;
      if (pair.targetSetId) {
        const check = await compareTargetProjection(options, pair.targetSetId);
        if (!check.ok) {
          throw new Error(`successor projection is not converged: ${check.findings.join('; ')}`);
        }
      }
      await renewRepairLease(options, plan.terminalRunId, holder);
      const removed = await removeReplacedObservationAfterSuccessor(
        options.database,
        options.uid,
        pair.predecessorObservationId,
        pair.successorObservationId,
      );
      if (removed.outcome !== 'removed') {
        throw new Error(`${pair.predecessorObservationId} repair-only cascade was refused`);
      }
      await options.onCheckpoint?.(`after-cascade:${pair.predecessorObservationId}`);
    }
    for (const targetSetId of touchedTargets) {
      await renewRepairLease(options, plan.terminalRunId, holder);
      await projectTargetSet(options, targetSetId);
    }
    const compared = await compareEnrichmentRepairPlan(plan, options, maxAgeMs);
    if (!compared.ok) throw new Error(`repair compare failed: ${compared.findings.join('; ')}`);
    return compared;
  } finally {
    await releaseEnrichmentRunLease(options.database, options.uid, plan.terminalRunId, holder);
  }
}

export async function applyEnrichmentRepairPlan(
  rawPlan: unknown,
  options: EnrichmentRepairOptions,
  maxAgeMs = ENRICHMENT_REPAIR_DEFAULT_MAX_AGE_MS,
): Promise<EnrichmentRepairApplyResult> {
  return executeEnrichmentRepairPlan(rawPlan, options, 'apply', maxAgeMs);
}

export async function resumeEnrichmentRepairPlan(
  rawPlan: unknown,
  options: EnrichmentRepairOptions,
  maxAgeMs = ENRICHMENT_REPAIR_DEFAULT_MAX_AGE_MS,
): Promise<EnrichmentRepairApplyResult> {
  return executeEnrichmentRepairPlan(rawPlan, options, 'resume', maxAgeMs);
}

export async function compareEnrichmentRepairPlan(
  rawPlan: unknown,
  options: EnrichmentRepairOptions,
  maxAgeMs = ENRICHMENT_REPAIR_DEFAULT_MAX_AGE_MS,
): Promise<EnrichmentRepairCompareResult> {
  const plan = validateEnrichmentRepairPlan(rawPlan, options, maxAgeMs);
  const state = await loadState(options);
  const findings: string[] = [];
  if (canonicalize(immutableVodDigests(state)) !== canonicalize(plan.immutableVod)) {
    findings.push('provider/manual VOD digest differs from the reviewed pre-state');
  }
  let staleAuthorizationsReauthorized = 0;
  for (const action of plan.staleAuthorizations) {
    const observationParsed = researchEnrichmentObservationRecordSchema.safeParse(
      state.observationsRaw[action.observationId],
    );
    const attachmentParsed = researchEnrichmentAttachmentRecordSchema.safeParse(
      state.attachmentsRaw[action.targetSetId]?.[action.observationId],
    );
    if (
      !observationParsed.success ||
      !attachmentParsed.success ||
      !enrichmentObservationFingerprintMatches(attachmentParsed.data, observationParsed.data) ||
      !validResolverAttachment(
        attachmentParsed.data,
        observationParsed.data,
        state.receiptsRaw[action.observationId],
      )
    ) {
      findings.push(`${action.observationId} is not freshly authorized`);
    } else {
      staleAuthorizationsReauthorized += 1;
    }
  }
  let successorsAuthorized = 0;
  let predecessorsRemoved = 0;
  for (const pair of plan.successorPairs) {
    if (state.observationsRaw[pair.predecessorObservationId] != null) {
      findings.push(`${pair.predecessorObservationId} predecessor still exists`);
    } else {
      predecessorsRemoved += 1;
    }
    if (pair.targetSetId) {
      const successorParsed = researchEnrichmentObservationRecordSchema.safeParse(
        state.observationsRaw[pair.successorObservationId],
      );
      const attachmentParsed = researchEnrichmentAttachmentRecordSchema.safeParse(
        state.attachmentsRaw[pair.targetSetId]?.[pair.successorObservationId],
      );
      if (
        successorParsed.success &&
        attachmentParsed.success &&
        validResolverAttachment(
          attachmentParsed.data,
          successorParsed.data,
          state.receiptsRaw[pair.successorObservationId],
        )
      ) {
        successorsAuthorized += 1;
      } else {
        findings.push(`${pair.successorObservationId} successor is not freshly authorized`);
      }
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    staleAuthorizationsReauthorized,
    successorsAuthorized,
    predecessorsRemoved,
    targetSetsReprojected: new Set([
      ...plan.staleAuthorizations.map((action) => action.targetSetId),
      ...plan.successorPairs.flatMap((pair) => (pair.targetSetId ? [pair.targetSetId] : [])),
    ]).size,
  };
}

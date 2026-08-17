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
export const ENRICHMENT_REPAIR_FORMAT_VERSION = 3;
export const ENRICHMENT_REPAIR_MAX_ACTIONS = 100;
export const ENRICHMENT_REPAIR_DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export const ENRICHMENT_REPAIR_TARGETS = {
  mkleo: {
    uid: 'eVJih9SgfJVk5oMPAQydPGbEBpU2',
    sourcePageTitle: 'MKLeo/VODs',
    currentCohortCount: 173,
  },
  sparg0: {
    uid: 'cosPe2wagVZsTWprGKnpjrcUEsb2',
    sourcePageTitle: 'Sparg0/VODs',
    currentCohortCount: 240,
  },
} as const;

/**
 * THE REVIEWED ID SETS — exact-id anti-vacuity (formatVersion 3, superseding
 * v2's count-based expectations, which went stale the moment the corrected
 * resolver changed what a handful of the reviewed rows resolve to). The plan
 * must classify EVERY id below into exactly one disposition — nothing left
 * over, nothing extra — and an id outside these sets is never actionable in
 * any disposition (enforced at plan time AND re-checked by
 * `validateEnrichmentRepairPlan`).
 *
 * PROVENANCE. The quarantined Gate-6 P3 baseline/receipt this review came
 * from (`apps/api/gate6-baseline.failed.<stamp>.json` per the committed 30.3
 * runbook's failed-record recovery) is NOT present in this working tree, so
 * these ids are reconstructed from the available evidence and cross-checked
 * three ways:
 * - `apps/api/enrichment-repair-plan.mkleo.json` / `.sparg0.json` — the
 *   read-only production plan run at 77e886f1 — carry 21 + 25 stale entries
 *   with exact ids/targets/prior fingerprints, plus 2 replacement pairs;
 * - those plans' own `blockedReasons` name the remaining reviewed ids
 *   verbatim (aa0baa79… whose prior target was 106049033; 25e8c8bf… →
 *   80387417; 665117a2… → 91113130; and the pair successor 801570fa… →
 *   predecessor target 102512871), completing 21+1=22 and 25+2=27 (=49);
 * - the `apps/api/enrichment-manifest*.json` lineage: the three pre-offset
 *   predecessors (4c3aaa92…, 77fe89bc…, 0ebbadd3…) are present through v5
 *   and vanish exactly at v6 where their successors (678dbbdb…, df7ccdc7…,
 *   801570fa…) first appear, and v5 shows 0ebbadd3… matched to 102512871 —
 *   binding it as the deferred pair's predecessor.
 */
export const ENRICHMENT_REPAIR_REVIEWED_STALE_OBSERVATION_IDS = {
  mkleo: [
    '029da334382074151c55d6315f53c272',
    '085ee026b1b19fd1a4906e1e34ac28d9',
    '097f5163adbb3c6256639f4c50258cfd',
    '1af969317587d0d2ccfa581be97bd013',
    '398ce547ab7dd7d630ef4ffe5a82f078',
    '3d3a2f9bcbd78b766d08682fb41fb8de',
    '46dfb58f162999d96fc2ed55d9ecfc56',
    '4ec3e70ef4f5a239e06776bb5294a9ee',
    '7de4922e4bf299e4d74a8b890a36a0e8',
    '98b619adeb420d90bc5085d64d736290',
    '9a5e822459f00ae25e4209b9fc0b446c',
    '9ef7da14287b0894c6ca15c25d20985b',
    'aa0baa79aaf76f91484d5ac46abe33f9',
    'bf24efe8f149358b93ae9f40ef047773',
    'c346167c1638433e0cd26b8eb185a7e4',
    'c6c6ec67f600f98dc6bc875e4e3400b5',
    'ca76862cd4855843526b5561b1a28012',
    'cafbec6797b6c71c1672528214208fdc',
    'd936719250dcac8305af8ec0e78aa2c8',
    'e8c19ee89d9a69b0e4037faa1a677154',
    'f24ccf0fbc0e8562b6e858c5e03019fa',
    'fa525cde0667aac3a359027476dbac09',
  ],
  sparg0: [
    '12da3b0db22c6468b45b04825cd95078',
    '1663f3bd3f2b647465a4cdb38fe9f858',
    '1b6640f74afd42f44cf5eaaab048138b',
    '25e8c8bf8640a17d92f481b23e00cbb8',
    '3b58c89ffd8560f14e561ed7e8af49ce',
    '420b588d7746c65cce4db8fe63810574',
    '42d7b1086967691e237f5d2ca36b4cf4',
    '4ab6957f113451384850fe6f64b303ef',
    '5b7e9b209f4d9f2d7319b4d1e203f100',
    '665117a27ce26f531b92ef61ab8082d3',
    '7369f7a0980ca727d1c73a9d3e5a8f6b',
    '808a6014e4696f56a86c4bf647cfe968',
    '8b0a46708fddccce38e13f938e6a0e7b',
    'a164af17f5ae05bc7c5e46a85fb10bcf',
    'a466d7b81f195f01babaf56c89e2e9f7',
    'bddfc29727dd1ce663b122875976a4f7',
    'c49cb54acd0e2acc374045e4adb631ef',
    'ca1a0079416970f0a60d4c0a88a56dac',
    'd1874b8116d7c3f16eeef1387065dc41',
    'db8c40c30ef7736d0ce123973ffa5526',
    'e40e7e449fe4377ee98948e49db1efb9',
    'e93768c415d3092e6653635bd6c17b40',
    'efcbc191c3e47d54fbd3a6b33f07a2f5',
    'f0cbc9c34f3a9566e69637c446a1c9eb',
    'f1da6070d1da56186928f20004ffcc66',
    'f4b9646a6def2eb35155134928abefe0',
    'fe1965950fac40bf919a088ca0bb29af',
  ],
} as const;

/** See the provenance note above — the three MkLeo pre-offset pairs; sparg0 has none. */
export const ENRICHMENT_REPAIR_REVIEWED_SUCCESSOR_PAIRS = {
  mkleo: [
    {
      predecessorObservationId: '4c3aaa92f662255c73fd807e89eba49c',
      successorObservationId: '678dbbdb0d04d31dd35119dacaad0130',
    },
    {
      predecessorObservationId: '77fe89bcd5efe6ba10c0b59d637a843a',
      successorObservationId: 'df7ccdc76e4837b5a70a78db2cc43a27',
    },
    {
      predecessorObservationId: '0ebbadd338a7c1551661544a5ffaf184',
      successorObservationId: '801570faf6adcacda9cdf04575bd71bb',
    },
  ],
  sparg0: [],
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

const staleAuthorizationSchema = z
  .object({
    observationId: z.string().min(1).max(200),
    sourcePageTitle: z.string().min(1),
    /** `reauthorize` — the row still independently resolves to its prior target; `revoke-only` — the corrected resolver abstains or resolves elsewhere, so the stale authorization is revoked and the row lands in the admin review queue. */
    disposition: z.enum(['reauthorize', 'revoke-only']),
    /** `null` only when the reviewed row was found already fully revoked (nothing left to address). */
    targetSetId: z.string().min(1).max(200).nullable(),
    priorReceiptId: z.string().min(1).max(200).nullable(),
    priorFingerprint: fingerprintSchema.nullable(),
    currentFingerprint: fingerprintSchema,
    /** REQUIRED for revoke-only: the resolver-derived reason the prior authorization may not be re-issued. */
    reason: z.string().max(500).nullish(),
  })
  .superRefine((value, ctx) => {
    if (
      value.disposition === 'reauthorize' &&
      (!value.targetSetId || !value.priorReceiptId || !value.priorFingerprint)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a reauthorize action requires its target set and the prior authorization evidence',
        path: ['disposition'],
      });
    }
    if (value.disposition === 'revoke-only' && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a revoke-only action must name the resolver-derived reason',
        path: ['disposition'],
      });
    }
  });

const successorPairSchema = z
  .object({
    sourcePageTitle: z.string().min(1),
    predecessorObservationId: z.string().min(1).max(200),
    successorObservationId: z.string().min(1).max(200),
    semanticSignature: z.string().regex(/^[a-f0-9]{64}$/),
    targetSetId: z.string().min(1).max(200).nullable(),
    /** `replace` — successor-first removal proceeds; `defer` — the successor fails to independently re-resolve to the predecessor's target, so the predecessor is left COMPLETELY untouched and the residue stays visible. */
    disposition: z.enum(['replace', 'defer']),
    /** REQUIRED for defer: why the replacement may not proceed. */
    reason: z.string().max(500).nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.disposition === 'defer' && (!value.reason || !value.targetSetId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a defer pair must name its reason and the predecessor target it declined to replace',
        path: ['disposition'],
      });
    }
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
  /** Reviewed revoke-only actions proven revoked (receipt and attachment gone; observation untouched, back in the review queue). */
  staleAuthorizationsRevoked: number;
  successorsAuthorized: number;
  predecessorsRemoved: number;
  /** Reviewed defer pairs — visible residue: the predecessor was deliberately left untouched. */
  successorPairsDeferred: number;
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
    if (action.targetSetId) targetSetIds.add(action.targetSetId);
  }
  for (const pair of successorPairs) {
    if (pair.disposition === 'defer') {
      // A deferred pair is a reviewed NO-OP: its predecessor, receipt,
      // attachment, target rows and witness all remain PROTECTED state, so
      // any change to them invalidates the plan instead of being smoothed
      // over as repair activity.
      continue;
    }
    observationIds.add(pair.predecessorObservationId);
    observationIds.add(pair.successorObservationId);
    predecessorIds.add(pair.predecessorObservationId);
    if (pair.targetSetId) targetSetIds.add(pair.targetSetId);
  }
  return { observationIds, predecessorIds, targetSetIds };
}

/** Every target set the reviewed plan may legitimately reproject: reauthorize and revoke-only targets plus replace-pair targets — never a deferred pair's. */
function repairTouchedTargetSetIds(
  plan: Pick<EnrichmentRepairPlanBody, 'staleAuthorizations' | 'successorPairs'>,
): Set<string> {
  return new Set<string>([
    ...plan.staleAuthorizations.flatMap((action) =>
      action.targetSetId ? [action.targetSetId] : [],
    ),
    ...plan.successorPairs.flatMap((pair) =>
      pair.disposition === 'replace' && pair.targetSetId ? [pair.targetSetId] : [],
    ),
  ]);
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

  // DISCOVERY half of exact-id anti-vacuity: a stale authorization on any id
  // OUTSIDE the reviewed set is never actionable in any disposition — it is
  // evidence the world moved past the review, so it blocks the whole plan.
  const reviewedStaleIds = ENRICHMENT_REPAIR_REVIEWED_STALE_OBSERVATION_IDS[options.account];
  const reviewedStaleIdSet = new Set<string>(reviewedStaleIds);
  for (const [observationId, entries] of attachmentsByObservation) {
    const observation = observations.get(observationId);
    if (!observation || observation.templateFamily !== 'vodlist') continue;
    if (reviewedStaleIdSet.has(observationId)) continue;
    if (
      entries.some(
        ({ attachment }) => !enrichmentObservationFingerprintMatches(attachment, observation),
      )
    ) {
      blockedReasons.push(
        `${observationId} carries a stale authorization but is outside the reviewed id set; repair will not act on it`,
      );
    }
  }

  // CLASSIFICATION half: EVERY reviewed id receives exactly one disposition,
  // or the plan blocks. `reauthorize` requires the row to independently
  // re-resolve to its prior target under the CURRENT resolver; a row the
  // corrected resolver now abstains on (or resolves elsewhere) is
  // `revoke-only` — forcing it through reauthorization would fabricate
  // authorization for evidence the resolver refuses.
  for (const observationId of reviewedStaleIds) {
    const observation = observations.get(observationId);
    if (!observation || observation.templateFamily !== 'vodlist') {
      blockedReasons.push(
        `${observationId} reviewed id is missing or not a VOD-list row; cannot classify`,
      );
      continue;
    }
    const entries = attachmentsByObservation.get(observationId) ?? [];
    if (entries.length === 0) {
      if (state.receiptsRaw[observationId] != null) {
        blockedReasons.push(
          `${observationId} reviewed id is unattached but still has a receipt; cannot classify`,
        );
        continue;
      }
      // Already fully revoked (a previously executed revoke-only, or manual
      // review): the terminal state of the revoke-only disposition.
      staleAuthorizations.push({
        observationId,
        sourcePageTitle: observation.sourcePageTitle,
        disposition: 'revoke-only',
        targetSetId: null,
        priorReceiptId: null,
        priorFingerprint: null,
        currentFingerprint: observationFingerprint(observation),
        reason: 'already fully revoked; no live authorization remains',
      });
      continue;
    }
    if (entries.length !== 1) {
      blockedReasons.push(`${observationId} has multiple attachments; repair will not guess`);
      continue;
    }
    const { targetSetId, attachment } = entries[0]!;
    if (attachment.attachmentSource !== 'resolver' || !attachment.receiptId) {
      blockedReasons.push(`${observationId} has a non-resolver attachment; cannot classify`);
      continue;
    }
    if (enrichmentObservationFingerprintMatches(attachment, observation)) {
      // Fingerprint-current: either an already-executed reauthorization or
      // otherwise-fresh evidence. Accept only the fully self-consistent
      // fresh state (the reauthorize disposition's own terminal state).
      if (hasFreshAuthorization(state, observation, targetSetId)) {
        staleAuthorizations.push({
          observationId,
          sourcePageTitle: observation.sourcePageTitle,
          disposition: 'reauthorize',
          targetSetId,
          priorReceiptId: attachment.receiptId,
          priorFingerprint: observationFingerprint(attachment),
          currentFingerprint: observationFingerprint(observation),
        });
      } else {
        blockedReasons.push(
          `${observationId} is fingerprint-current but not self-consistently authorized; cannot classify`,
        );
      }
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
    if (resolvedTarget === targetSetId) {
      staleAuthorizations.push({
        observationId,
        sourcePageTitle: observation.sourcePageTitle,
        disposition: 'reauthorize',
        targetSetId,
        priorReceiptId: receiptParsed.data.receiptId,
        priorFingerprint: observationFingerprint(attachment),
        currentFingerprint: observationFingerprint(observation),
      });
    } else {
      staleAuthorizations.push({
        observationId,
        sourcePageTitle: observation.sourcePageTitle,
        disposition: 'revoke-only',
        targetSetId,
        priorReceiptId: receiptParsed.data.receiptId,
        priorFingerprint: observationFingerprint(attachment),
        currentFingerprint: observationFingerprint(observation),
        reason: `now resolves to ${resolvedTarget ?? 'abstain'}, not prior target ${targetSetId}; stale authorization is revoked, row returns to review`,
      });
    }
  }

  const successorPairs: EnrichmentRepairPlanBody['successorPairs'] = [];
  const pageCohorts: EnrichmentRepairPlanBody['pageCohorts'] = [];
  const currentBySignatureByPage = new Map<
    string,
    Map<string, ResearchEnrichmentObservationRecord[]>
  >();
  const obsoleteRows: {
    sourcePageTitle: string;
    predecessor: ResearchEnrichmentObservationRecord;
  }[] = [];
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
    currentBySignatureByPage.set(sourcePageTitle, currentBySignature);
    for (const predecessor of rows.filter((row) => row.sourceContentHash !== cacheContentHash)) {
      obsoleteRows.push({ sourcePageTitle, predecessor });
    }
  }

  // DISCOVERY half of the exact-pair anti-vacuity: an obsolete row with a
  // unique semantic successor OUTSIDE the reviewed pair set blocks the plan
  // (never silently actioned); obsolete rows with no unique successor are
  // simply retained, as before.
  const reviewedPairs = ENRICHMENT_REPAIR_REVIEWED_SUCCESSOR_PAIRS[options.account];
  const reviewedPairPredecessorIds = new Set<string>(
    reviewedPairs.map((pair) => pair.predecessorObservationId),
  );
  for (const { sourcePageTitle, predecessor } of obsoleteRows) {
    const signature = semanticSignature(predecessor);
    const successors = currentBySignatureByPage.get(sourcePageTitle)?.get(signature) ?? [];
    if (successors.length !== 1 || successors[0]!.observationId === predecessor.observationId) {
      continue;
    }
    if (!reviewedPairPredecessorIds.has(predecessor.observationId)) {
      blockedReasons.push(
        `${predecessor.observationId} pairs with successor ${successors[0]!.observationId} but is outside the reviewed pair set; repair will not act on it`,
      );
    }
  }

  // CLASSIFICATION half: every reviewed pair receives exactly one
  // disposition. `replace` proceeds successor-first; `defer` (the successor
  // fails to independently re-resolve to the predecessor's target) leaves
  // the predecessor COMPLETELY untouched, with the residue named rather
  // than smoothed over.
  for (const reviewedPair of reviewedPairs) {
    const predecessor = observations.get(reviewedPair.predecessorObservationId);
    const successor = observations.get(reviewedPair.successorObservationId);
    if (!successor || successor.templateFamily !== 'vodlist') {
      blockedReasons.push(
        `${reviewedPair.successorObservationId} reviewed successor is missing; cannot classify pair`,
      );
      continue;
    }
    const sourcePageTitle = successor.sourcePageTitle;
    const signature = semanticSignature(successor);
    if (!predecessor) {
      // Already replaced (a previously executed cascade): the terminal
      // state of the replace disposition.
      successorPairs.push({
        sourcePageTitle,
        predecessorObservationId: reviewedPair.predecessorObservationId,
        successorObservationId: reviewedPair.successorObservationId,
        semanticSignature: signature,
        targetSetId: null,
        disposition: 'replace',
      });
      continue;
    }
    if (semanticSignature(predecessor) !== signature) {
      blockedReasons.push(
        `${reviewedPair.predecessorObservationId} and ${reviewedPair.successorObservationId} no longer share a semantic identity; cannot classify pair`,
      );
      continue;
    }
    const successors = currentBySignatureByPage.get(sourcePageTitle)?.get(signature) ?? [];
    if (
      successors.length !== 1 ||
      successors[0]!.observationId !== reviewedPair.successorObservationId
    ) {
      blockedReasons.push(
        `${reviewedPair.successorObservationId} is not the unique current-cohort successor for its reviewed pair; cannot classify`,
      );
      continue;
    }
    const predecessorAttachments =
      attachmentsByObservation.get(reviewedPair.predecessorObservationId) ?? [];
    if (predecessorAttachments.length > 1) {
      blockedReasons.push(`${reviewedPair.predecessorObservationId} has multiple attachments`);
      continue;
    }
    if (predecessorAttachments.length === 0) {
      if (state.receiptsRaw[reviewedPair.predecessorObservationId] != null) {
        blockedReasons.push(
          `${reviewedPair.predecessorObservationId} is unattached but still has a receipt`,
        );
        continue;
      }
      successorPairs.push({
        sourcePageTitle,
        predecessorObservationId: reviewedPair.predecessorObservationId,
        successorObservationId: reviewedPair.successorObservationId,
        semanticSignature: signature,
        targetSetId: null,
        disposition: 'replace',
      });
      continue;
    }
    const prior = predecessorAttachments[0]!;
    if (
      !validResolverAttachment(
        prior.attachment,
        predecessor,
        state.receiptsRaw[reviewedPair.predecessorObservationId],
      )
    ) {
      blockedReasons.push(
        `${reviewedPair.predecessorObservationId} is attached without valid resolver evidence`,
      );
      continue;
    }
    const resolvedTarget = resolveVodTarget(successor, corroboration);
    if (resolvedTarget === prior.targetSetId) {
      successorPairs.push({
        sourcePageTitle,
        predecessorObservationId: reviewedPair.predecessorObservationId,
        successorObservationId: reviewedPair.successorObservationId,
        semanticSignature: signature,
        targetSetId: prior.targetSetId,
        disposition: 'replace',
      });
    } else {
      successorPairs.push({
        sourcePageTitle,
        predecessorObservationId: reviewedPair.predecessorObservationId,
        successorObservationId: reviewedPair.successorObservationId,
        semanticSignature: signature,
        targetSetId: prior.targetSetId,
        disposition: 'defer',
        reason: `successor resolves to ${resolvedTarget ?? 'abstain'}, not predecessor target ${prior.targetSetId}; predecessor left untouched`,
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
  // Exact-id coverage (belt and braces beside the per-id classification
  // blockers above): a plan may not leave any reviewed id unclassified.
  const classifiedStaleIds = new Set(staleAuthorizations.map((action) => action.observationId));
  if (classifiedStaleIds.size !== reviewedStaleIds.length) {
    blockedReasons.push(
      `${options.account} exact-id anti-vacuity: classified ${classifiedStaleIds.size} of ${reviewedStaleIds.length} reviewed stale authorizations`,
    );
  }
  if (successorPairs.length !== reviewedPairs.length) {
    blockedReasons.push(
      `${options.account} exact-id anti-vacuity: classified ${successorPairs.length} of ${reviewedPairs.length} reviewed successor pairs`,
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
  // Exact-id anti-vacuity, re-checked INDEPENDENTLY of the content hash: a
  // plan may only ever act on the reviewed id sets — full coverage, nothing
  // extra, in any disposition.
  const reviewedStale = ENRICHMENT_REPAIR_REVIEWED_STALE_OBSERVATION_IDS[parsed.account];
  const planStaleIds = new Set(parsed.staleAuthorizations.map((action) => action.observationId));
  if (
    planStaleIds.size !== parsed.staleAuthorizations.length ||
    planStaleIds.size !== reviewedStale.length ||
    !reviewedStale.every((id) => planStaleIds.has(id))
  ) {
    throw new Error('repair plan stale-authorization ids do not equal the reviewed id set exactly');
  }
  const reviewedPairs = ENRICHMENT_REPAIR_REVIEWED_SUCCESSOR_PAIRS[parsed.account];
  const planPairKeys = new Set(
    parsed.successorPairs.map(
      (pair) => `${pair.predecessorObservationId}\n${pair.successorObservationId}`,
    ),
  );
  if (
    planPairKeys.size !== parsed.successorPairs.length ||
    planPairKeys.size !== reviewedPairs.length ||
    !reviewedPairs.every((pair) =>
      planPairKeys.has(`${pair.predecessorObservationId}\n${pair.successorObservationId}`),
    )
  ) {
    throw new Error('repair plan successor pairs do not equal the reviewed pair set exactly');
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
  if (!action.targetSetId || !action.priorReceiptId || !action.priorFingerprint) {
    // No prior authorization was recorded at review time (the already-
    // revoked shape) — there is nothing "prior" this state could match.
    return false;
  }
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
    if (action.disposition === 'reauthorize') {
      if (
        !(action.targetSetId
          ? hasFreshAuthorization(state, observation.data, action.targetSetId)
          : false) &&
        !hasReviewedPriorAuthorization(state, action)
      ) {
        throw new Error(`${action.observationId} is not in a reviewed prior-or-fresh state`);
      }
    } else {
      const revoked =
        attachmentsForObservation(state, action.observationId).length === 0 &&
        state.receiptsRaw[action.observationId] == null;
      if (!revoked && !hasReviewedPriorAuthorization(state, action)) {
        throw new Error(`${action.observationId} is not in a reviewed prior-or-revoked state`);
      }
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
    if (pair.disposition === 'defer') {
      // A deferred pair is a reviewed no-op; its predecessor (and every
      // byte of its derived state, via the protected hash) must survive.
      if (!predecessor.success) {
        throw new Error(
          `${pair.predecessorObservationId} deferred predecessor must remain untouched but is missing`,
        );
      }
      continue;
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
      if (action.disposition === 'revoke-only') {
        // Atomic revocation of exactly the reviewed stale authorization —
        // the observation itself is NEVER touched; it re-enters the admin
        // review queue by attachment absence.
        if (state.receiptsRaw[action.observationId] != null) {
          authorizationPatch[`researchEnrichmentReceipts/${options.uid}/${action.observationId}`] =
            null;
        }
        if (
          action.targetSetId &&
          asRecord(state.attachmentsRaw[action.targetSetId])[action.observationId] !== undefined
        ) {
          authorizationPatch[
            `researchEnrichmentAttachments/${options.uid}/${action.targetSetId}/${action.observationId}`
          ] = null;
        }
        continue;
      }
      if (!hasFreshAuthorization(state, observation, action.targetSetId!)) {
        Object.assign(
          authorizationPatch,
          freshAuthorizationPatch(
            options.uid,
            observation,
            action.targetSetId!,
            corroboration,
            options.now?.() ?? options.nowMs,
          ),
        );
      }
    }
    for (const pair of plan.successorPairs) {
      if (pair.disposition === 'defer' || !pair.targetSetId) continue;
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
    const touchedTargets = repairTouchedTargetSetIds(plan);
    for (const targetSetId of touchedTargets) {
      await renewRepairLease(options, plan.terminalRunId, holder);
      await projectTargetSet(options, targetSetId);
      await options.onCheckpoint?.(`after-projection:${targetSetId}`);
    }

    for (const pair of plan.successorPairs) {
      if (pair.disposition === 'defer') {
        // Reviewed residue, left untouched by design — named, not smoothed
        // over. The monotonic-state proof above already required the
        // predecessor to still exist.
        continue;
      }
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
  let staleAuthorizationsRevoked = 0;
  for (const action of plan.staleAuthorizations) {
    if (action.disposition === 'revoke-only') {
      const revoked =
        attachmentsForObservation(state, action.observationId).length === 0 &&
        state.receiptsRaw[action.observationId] == null &&
        state.observationsRaw[action.observationId] != null;
      if (revoked) {
        staleAuthorizationsRevoked += 1;
      } else {
        findings.push(
          `${action.observationId} revoke-only is not converged (authorization remains or observation vanished)`,
        );
      }
      continue;
    }
    const observationParsed = researchEnrichmentObservationRecordSchema.safeParse(
      state.observationsRaw[action.observationId],
    );
    const attachmentParsed = researchEnrichmentAttachmentRecordSchema.safeParse(
      action.targetSetId
        ? state.attachmentsRaw[action.targetSetId]?.[action.observationId]
        : undefined,
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
  let successorPairsDeferred = 0;
  for (const pair of plan.successorPairs) {
    if (pair.disposition === 'defer') {
      // The deferred residue must remain VISIBLE: the predecessor is
      // required to still exist, untouched.
      if (state.observationsRaw[pair.predecessorObservationId] != null) {
        successorPairsDeferred += 1;
      } else {
        findings.push(
          `${pair.predecessorObservationId} deferred predecessor was removed despite its defer disposition`,
        );
      }
      continue;
    }
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
    staleAuthorizationsRevoked,
    successorsAuthorized,
    predecessorsRemoved,
    successorPairsDeferred,
    targetSetsReprojected: repairTouchedTargetSetIds(plan).size,
  };
}

import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { LIQUIPEDIA_PARSER_VERSION_VOD_LIST, UNKNOWN_STAGE } from '@smash-tracker/shared';
import { LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON } from '../src/liquipedia/adapters/vodList.js';
import { deriveEnrichmentMatchRowKey } from '../src/research/enrichment/projection.js';
import { deriveReceiptId, RESOLVER_VERSION } from '../src/research/enrichment/resolution.js';
import { removeReplacedObservationAfterSuccessor } from '../src/research/enrichment/store.js';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import {
  applyEnrichmentRepairPlan,
  computeEnrichmentRepairPlanHash,
  createEnrichmentRepairPlan,
  ENRICHMENT_REPAIR_MAX_ACTIONS,
  ENRICHMENT_REPAIR_PRODUCTION_HOST,
  ENRICHMENT_REPAIR_PRODUCTION_PROJECT,
  ENRICHMENT_REPAIR_REVIEWED_STALE_OBSERVATION_IDS,
  ENRICHMENT_REPAIR_REVIEWED_SUCCESSOR_PAIRS,
  ENRICHMENT_REPAIR_TARGETS,
  resumeEnrichmentRepairPlan,
  validateEnrichmentRepairPlan,
  type EnrichmentRepairOptions,
  type EnrichmentRepairPlan,
} from './repairEnrichmentAuthorizationsCore.js';

/**
 * The bounded one-time repair operator's own proof, against FakeDatabase
 * only (this file NEVER contacts a real database). The fixture is keyed by
 * the REVIEWED ID SETS themselves (exact-id anti-vacuity): the same 49
 * observation ids and 3 predecessor/successor pairs the operator is bound
 * to, seeded with synthetic content. Every refusal path asserted here is
 * exercised in its FAILING direction (RED) beside the converging one
 * (GREEN), including the disposition split the corrected resolver forces:
 * a reviewed row that no longer resolves to its prior target must be
 * REVOKE-ONLY (never forced through reauthorization), and a reviewed pair
 * whose successor cannot re-prove the predecessor's target must DEFER with
 * the predecessor left byte-untouched.
 */

const ACCOUNT = 'mkleo' as const;
const UID = ENRICHMENT_REPAIR_TARGETS.mkleo.uid;
const PAGE_TITLE = ENRICHMENT_REPAIR_TARGETS.mkleo.sourcePageTitle;
const CURRENT_COUNT = ENRICHMENT_REPAIR_TARGETS.mkleo.currentCohortCount;
const REVIEWED_STALE_IDS = ENRICHMENT_REPAIR_REVIEWED_STALE_OBSERVATION_IDS.mkleo;
const REVIEWED_PAIRS = ENRICHMENT_REPAIR_REVIEWED_SUCCESSOR_PAIRS.mkleo;
const NOW_MS = 1_800_000_000_000;
const RUN_ID = '7f2c9a10-4b3d-4e5f-8a6b-1c2d3e4f5a6b';
const PRIOR_RESOLVER_VERSION = 'liquipedia-resolver@1';
const VOD_PARSER = LIQUIPEDIA_PARSER_VERSION_VOD_LIST;

function sha(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

const CURRENT_HASH = sha('current-vod-page-content');
const STALE_ATTACHMENT_HASH = sha('previous-vod-page-content');
const OBSOLETE_HASH = sha('obsolete-predecessor-cohort');

function pad(index: number): string {
  return String(index).padStart(3, '0');
}

function vodUrlFor(index: number): string {
  return `https://www.youtube.com/watch?v=vid${String(index).padStart(8, '0')}`;
}

interface Fingerprint {
  sourceRevisionId: number;
  sourceContentHash: string;
  parserVersion: string;
}

function vodRowRecord(
  observationId: string,
  tournamentIndex: number,
  fingerprint: Fingerprint,
): Record<string, unknown> {
  return {
    observationId,
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'vod-reference',
    sourcePageTitle: PAGE_TITLE,
    sourcePageUrl: 'https://liquipedia.net/smash/MKLeo/VODs',
    ...fingerprint,
    templateFamily: 'vodlist',
    fetchedAtMs: NOW_MS - 50_000,
    observedAtMs: NOW_MS - 50_000,
    matchingStatus: 'ambiguous',
    tournamentPageTitle: `Tournament_${tournamentIndex}`,
    vodUrl: vodUrlFor(tournamentIndex),
    resolutionReasons: [LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON],
  };
}

function bracketRecord(tournamentIndex: number): Record<string, unknown> {
  return {
    observationId: `bracket-${pad(tournamentIndex)}`,
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: `Tournament_${tournamentIndex}/Bracket`,
    sourcePageUrl: `https://liquipedia.net/smash/Tournament_${tournamentIndex}`,
    sourceRevisionId: 700 + tournamentIndex,
    sourceContentHash: sha(`bracket-${tournamentIndex}`),
    parserVersion: 'liquipedia-bracket-match2@1',
    templateFamily: 'match2',
    fetchedAtMs: NOW_MS - 50_000,
    observedAtMs: NOW_MS - 50_000,
    matchingStatus: 'matched',
    tournamentPageTitle: `Tournament_${tournamentIndex}`,
    vodUrl: vodUrlFor(tournamentIndex),
    games: [{ ordinal: 1 }],
  };
}

/** A mutually-consistent resolver receipt + attachment for `fingerprint` — the same self-derivation `store.ts` revalidates. */
function resolverAuthorization(
  observationId: string,
  targetSetId: string,
  fingerprint: Fingerprint,
  resolverVersion = PRIOR_RESOLVER_VERSION,
) {
  const receiptId = deriveReceiptId({
    observationId,
    resolverVersion,
    sourceContentHash: fingerprint.sourceContentHash,
  });
  return {
    receipt: {
      receiptId,
      observationId,
      targetSetId,
      confidence: 'high',
      resolvedAtMs: NOW_MS - 40_000,
      resolverVersion,
      ...fingerprint,
      candidateTargetSetIds: [targetSetId],
    },
    attachment: {
      observationId,
      targetSetId,
      attachmentSource: 'resolver',
      attachedAtMs: NOW_MS - 39_000,
      ...fingerprint,
      receiptId,
    },
  };
}

function fingerprintOf(record: Record<string, unknown>): Fingerprint {
  return {
    sourceRevisionId: record.sourceRevisionId as number,
    sourceContentHash: record.sourceContentHash as string,
    parserVersion: record.parserVersion as string,
  };
}

function pageCacheKey(uid: string, title: string): string {
  return createHash('sha256').update(`${uid}\n${title}`).digest('hex').slice(0, 48);
}

const CURRENT_FINGERPRINT: Fingerprint = {
  sourceRevisionId: 900,
  sourceContentHash: CURRENT_HASH,
  parserVersion: VOD_PARSER,
};
const STALE_FINGERPRINT: Fingerprint = {
  sourceRevisionId: 800,
  sourceContentHash: STALE_ATTACHMENT_HASH,
  parserVersion: VOD_PARSER,
};
const OBSOLETE_FINGERPRINT: Fingerprint = {
  sourceRevisionId: 800,
  sourceContentHash: OBSOLETE_HASH,
  parserVersion: VOD_PARSER,
};

const PAIR_TARGET_SET_ID = 'set-pair-3';
/** Tournament index for reviewed stale id at 0-based position `i`. */
const staleIndex = (i: number) => i + 1;
/** Tournament index shared by pair `j`'s predecessor and successor. */
const pairIndex = (j: number) => 300 + j;
const staleTarget = (i: number) => `set-${pad(staleIndex(i))}`;

interface FixtureVariant {
  /** Reviewed stale ids whose corroborating bracket is OMITTED — the corrected resolver abstains, so classification must be revoke-only. */
  uncorroboratedStaleIds?: readonly string[];
  /** When true, the attached pair's successor loses its corroborating bracket — classification must be defer. */
  deferAttachedPair?: boolean;
  /** (d) A reviewed id whose observation is missing entirely — the plan must block as unclassifiable. */
  omitReviewedObservationId?: string;
  /** Adds one NON-reviewed current row carrying a stale authorization — the "nothing extra" discovery blocker. */
  extraForeignStaleAuthorization?: boolean;
}

/**
 * Seeds the mkleo repair universe keyed by the reviewed id sets:
 * - the 22 reviewed stale ids as current-cohort rows attached under a
 *   PRIOR-cohort fingerprint with the matching prior receipt, each (unless
 *   the variant says otherwise) corroborated by an authorized bracket row
 *   on its own tournament;
 * - the 3 reviewed pairs: two unattached receiptless predecessors and one
 *   predecessor validly attached at its own obsolete fingerprint, each with
 *   its reviewed successor in the current cohort;
 * - filler rows up to the 173-row cohort contract, the terminal run, the
 *   generated-page cache contract, and one empty match row per repairable
 *   target.
 */
async function seedRepairFixture(
  database: FakeDatabase,
  variant: FixtureVariant = {},
): Promise<void> {
  const uncorroborated = new Set(variant.uncorroboratedStaleIds ?? []);
  const observations: Record<string, unknown> = {};
  const receipts: Record<string, unknown> = {};
  const attachments: Record<string, Record<string, unknown>> = {};
  const matches: Record<string, unknown> = {};

  REVIEWED_STALE_IDS.forEach((observationId, i) => {
    if (observationId !== variant.omitReviewedObservationId) {
      observations[observationId] = vodRowRecord(observationId, staleIndex(i), CURRENT_FINGERPRINT);
    }
    const targetSetId = staleTarget(i);
    const stale = resolverAuthorization(observationId, targetSetId, STALE_FINGERPRINT);
    receipts[observationId] = stale.receipt;
    attachments[targetSetId] = { [observationId]: stale.attachment };
    if (!uncorroborated.has(observationId)) {
      const bracket = bracketRecord(staleIndex(i));
      observations[bracket.observationId as string] = bracket;
      const corroborating = resolverAuthorization(
        bracket.observationId as string,
        targetSetId,
        fingerprintOf(bracket),
      );
      receipts[bracket.observationId as string] = corroborating.receipt;
      attachments[targetSetId]![bracket.observationId as string] = corroborating.attachment;
    }
    matches[deriveEnrichmentMatchRowKey(targetSetId, 1)] = { note: 'seed', map: UNKNOWN_STAGE };
  });

  REVIEWED_PAIRS.forEach((pair, j) => {
    observations[pair.successorObservationId] = vodRowRecord(
      pair.successorObservationId,
      pairIndex(j),
      CURRENT_FINGERPRINT,
    );
    observations[pair.predecessorObservationId] = vodRowRecord(
      pair.predecessorObservationId,
      pairIndex(j),
      OBSOLETE_FINGERPRINT,
    );
  });
  // The third reviewed pair's predecessor is ATTACHED (valid at its own
  // obsolete fingerprint) — the production shape of 0ebbadd3… → 102512871.
  const attachedPair = REVIEWED_PAIRS[2]!;
  const predecessorAuthorization = resolverAuthorization(
    attachedPair.predecessorObservationId,
    PAIR_TARGET_SET_ID,
    OBSOLETE_FINGERPRINT,
  );
  receipts[attachedPair.predecessorObservationId] = predecessorAuthorization.receipt;
  attachments[PAIR_TARGET_SET_ID] = {
    [attachedPair.predecessorObservationId]: predecessorAuthorization.attachment,
  };
  if (!variant.deferAttachedPair) {
    const pairBracket = bracketRecord(pairIndex(2));
    observations[pairBracket.observationId as string] = pairBracket;
    const pairCorroboration = resolverAuthorization(
      pairBracket.observationId as string,
      PAIR_TARGET_SET_ID,
      fingerprintOf(pairBracket),
    );
    receipts[pairBracket.observationId as string] = pairCorroboration.receipt;
    attachments[PAIR_TARGET_SET_ID]![pairBracket.observationId as string] =
      pairCorroboration.attachment;
  }
  matches[deriveEnrichmentMatchRowKey(PAIR_TARGET_SET_ID, 1)] = {
    note: 'seed',
    map: UNKNOWN_STAGE,
  };

  // Fill the current cohort to the exact 173-row contract.
  let fillerCount = CURRENT_COUNT - REVIEWED_STALE_IDS.length - REVIEWED_PAIRS.length;
  if (variant.omitReviewedObservationId) fillerCount += 1;
  if (variant.extraForeignStaleAuthorization) fillerCount -= 1;
  for (let f = 1; f <= fillerCount; f += 1) {
    const id = `filler${pad(f)}filler${pad(f)}`;
    observations[id] = vodRowRecord(id, 400 + f, CURRENT_FINGERPRINT);
  }
  if (variant.extraForeignStaleAuthorization) {
    // A current row OUTSIDE the reviewed set carrying a stale authorization
    // — never actionable, must block the plan.
    const foreignId = 'foreignstale00000000000000000001';
    observations[foreignId] = vodRowRecord(foreignId, 599, CURRENT_FINGERPRINT);
    const foreign = resolverAuthorization(foreignId, 'set-foreign', STALE_FINGERPRINT);
    receipts[foreignId] = foreign.receipt;
    attachments['set-foreign'] = { [foreignId]: foreign.attachment };
  }

  await database.ref(`researchEnrichmentObservations/${UID}`).set(observations);
  await database.ref(`researchEnrichmentReceipts/${UID}`).set(receipts);
  await database.ref(`researchEnrichmentAttachments/${UID}`).set(attachments);
  await database.ref(`matches/${UID}`).set(matches);
  await database.ref(`researchEnrichmentRuns/${UID}`).set({
    runId: RUN_ID,
    status: 'completed',
    startedAtMs: NOW_MS - 600_000,
    completedAtMs: NOW_MS - 60_000,
    leaseFenceCounter: 3,
  });
  await database.ref(`liquipediaPageCache/${pageCacheKey(UID, PAGE_TITLE)}`).set({
    pageId: pageCacheKey(UID, PAGE_TITLE),
    title: PAGE_TITLE,
    pageClass: 'generated',
    parserVersion: VOD_PARSER,
    fetchedAtMs: NOW_MS - 100_000,
    contentHash: CURRENT_HASH,
    observationCount: CURRENT_COUNT,
  });
}

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function makeOptions(
  database: FakeDatabase,
  overrides: Partial<EnrichmentRepairOptions> = {},
): EnrichmentRepairOptions {
  return {
    database: asDatabase(database),
    databaseHost: ENRICHMENT_REPAIR_PRODUCTION_HOST,
    projectId: ENRICHMENT_REPAIR_PRODUCTION_PROJECT,
    environment: 'production',
    databaseEmulatorHost: null,
    account: ACCOUNT,
    uid: UID,
    nowMs: NOW_MS,
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

async function seededPlan(
  database: FakeDatabase,
  variant: FixtureVariant = {},
): Promise<{ plan: EnrichmentRepairPlan; options: EnrichmentRepairOptions }> {
  await seedRepairFixture(database, variant);
  const options = makeOptions(database);
  const plan = await createEnrichmentRepairPlan(options);
  return { plan, options };
}

/** Deep clone of one reviewed pair's ENTIRE live footprint — observation, receipt, and attachment bytes — for untouched-residue proofs. */
function pairFootprint(database: FakeDatabase, predecessorObservationId: string) {
  const dump = database.dump() as Record<string, Record<string, Record<string, unknown>>>;
  return JSON.stringify({
    observation: dump.researchEnrichmentObservations?.[UID]?.[predecessorObservationId] ?? null,
    receipt: dump.researchEnrichmentReceipts?.[UID]?.[predecessorObservationId] ?? null,
    attachment:
      (
        dump.researchEnrichmentAttachments?.[UID]?.[PAIR_TARGET_SET_ID] as
          Record<string, unknown> | undefined
      )?.[predecessorObservationId] ?? null,
    matchRow: dump.matches?.[UID]?.[deriveEnrichmentMatchRowKey(PAIR_TARGET_SET_ID, 1)] ?? null,
    witness:
      dump.researchEnrichmentProjection?.[UID]?.[
        deriveEnrichmentMatchRowKey(PAIR_TARGET_SET_ID, 1)
      ] ?? null,
  });
}

describe('repairEnrichmentAuthorizationsCore — plan/hash/validate cycle', () => {
  it('classifies every reviewed id (nothing left over, nothing extra) and validates against its own hash', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);

    expect(plan.blockedReasons).toEqual([]);
    expect(plan.staleAuthorizations).toHaveLength(REVIEWED_STALE_IDS.length);
    expect(new Set(plan.staleAuthorizations.map((action) => action.observationId))).toEqual(
      new Set(REVIEWED_STALE_IDS),
    );
    expect(plan.staleAuthorizations.every((action) => action.disposition === 'reauthorize')).toBe(
      true,
    );
    expect(plan.successorPairs).toHaveLength(REVIEWED_PAIRS.length);
    expect(plan.successorPairs.every((pair) => pair.disposition === 'replace')).toBe(true);
    expect(
      plan.successorPairs.find(
        (pair) => pair.predecessorObservationId === REVIEWED_PAIRS[2]!.predecessorObservationId,
      )?.targetSetId,
    ).toBe(PAIR_TARGET_SET_ID);
    expect(plan.pageCohorts).toEqual([
      expect.objectContaining({
        sourcePageTitle: PAGE_TITLE,
        currentCohortCount: CURRENT_COUNT,
        cacheObservationCount: CURRENT_COUNT,
      }),
    ]);
    expect(plan.terminalRunId).toBe(RUN_ID);

    const { contentHash, ...body } = plan;
    expect(computeEnrichmentRepairPlanHash(body)).toBe(contentHash);
    // GREEN half of the tamper pair: the untouched plan is accepted.
    expect(validateEnrichmentRepairPlan(plan, options)).toEqual(plan);
  });

  it('planning is a byte-identical no-write dry run', async () => {
    const database = new FakeDatabase();
    await seedRepairFixture(database);
    const before = JSON.stringify(database.dump());

    await createEnrichmentRepairPlan(makeOptions(database));

    expect(JSON.stringify(database.dump())).toBe(before);
  });

  it('RED: a single tampered plan member is rejected by the content hash before any environment or state check', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);

    const tampered: EnrichmentRepairPlan = {
      ...plan,
      staleAuthorizations: plan.staleAuthorizations.map((action, index) =>
        index === 0 ? { ...action, targetSetId: 'set-attacker-controlled' } : action,
      ),
    };
    expect(() => validateEnrichmentRepairPlan(tampered, options)).toThrow(/content hash mismatch/);
    await expect(applyEnrichmentRepairPlan(tampered, options)).rejects.toThrow(
      /content hash mismatch/,
    );
  });

  it('RED: an id outside the reviewed set is never actionable in ANY disposition, even under a recomputed content hash', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);

    // The attacker swaps a reviewed id for a foreign one as REVOKE-ONLY and
    // recomputes the content hash, so the hash gate alone would pass — the
    // reviewed-set equality check must refuse independently.
    const { contentHash: reviewedHash, ...body } = plan;
    expect(reviewedHash).toBe(plan.contentHash);
    const forgedBody = {
      ...body,
      staleAuthorizations: body.staleAuthorizations.map((action, index) =>
        index === 0
          ? {
              ...action,
              observationId: 'ffffffffffffffffffffffffffffffff',
              disposition: 'revoke-only' as const,
              reason: 'attacker-chosen revocation of an unreviewed id',
            }
          : action,
      ),
    };
    const forged = { ...forgedBody, contentHash: computeEnrichmentRepairPlanHash(forgedBody) };
    expect(() => validateEnrichmentRepairPlan(forged, options)).toThrow(
      /do not equal the reviewed id set exactly/,
    );
    await expect(applyEnrichmentRepairPlan(forged, options)).rejects.toThrow(
      /do not equal the reviewed id set exactly/,
    );

    // Same boundary for pairs: a forged extra pair fails set equality.
    const forgedPairBody = {
      ...body,
      successorPairs: body.successorPairs.map((pair, index) =>
        index === 0
          ? {
              ...pair,
              predecessorObservationId: 'ffffffffffffffffffffffffffffffff',
            }
          : pair,
      ),
    };
    const forgedPairs = {
      ...forgedPairBody,
      contentHash: computeEnrichmentRepairPlanHash(forgedPairBody),
    };
    expect(() => validateEnrichmentRepairPlan(forgedPairs, options)).toThrow(
      /do not equal the reviewed pair set exactly/,
    );
  });

  it('RED: an unclassified reviewed id blocks the plan', async () => {
    const database = new FakeDatabase();
    const missingId = REVIEWED_STALE_IDS[0]!;
    const { plan, options } = await seededPlan(database, {
      omitReviewedObservationId: missingId,
    });

    expect(plan.blockedReasons).toContain(
      `${missingId} reviewed id is missing or not a VOD-list row; cannot classify`,
    );
    expect(plan.blockedReasons).toContain(
      `mkleo exact-id anti-vacuity: classified ${REVIEWED_STALE_IDS.length - 1} of ${REVIEWED_STALE_IDS.length} reviewed stale authorizations`,
    );
    expect(() => validateEnrichmentRepairPlan(plan, options)).toThrow(/repair plan is blocked/);
    await expect(applyEnrichmentRepairPlan(plan, options)).rejects.toThrow(
      /repair plan is blocked/,
    );
  });

  it('RED: a stale authorization on a non-reviewed id blocks the plan (nothing extra is ever actionable)', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database, {
      extraForeignStaleAuthorization: true,
    });

    expect(plan.blockedReasons).toContain(
      'foreignstale00000000000000000001 carries a stale authorization but is outside the reviewed id set; repair will not act on it',
    );
    expect(() => validateEnrichmentRepairPlan(plan, options)).toThrow(/repair plan is blocked/);
  });

  it('the plan schema itself refuses more than ENRICHMENT_REPAIR_MAX_ACTIONS entries in one action array', async () => {
    const database = new FakeDatabase();
    const { plan } = await seededPlan(database);
    const { contentHash: reviewedHash, ...body } = plan;
    expect(reviewedHash).toBe(plan.contentHash);
    const oversized = {
      ...body,
      staleAuthorizations: Array.from({ length: ENRICHMENT_REPAIR_MAX_ACTIONS + 1 }, (_, i) => ({
        ...body.staleAuthorizations[0]!,
        observationId: `deadbeef${String(i).padStart(24, '0')}`,
      })),
    };
    expect(() => computeEnrichmentRepairPlanHash(oversized)).toThrow(/100/);
  });

  it('refuses to plan or apply outside the exact production scope', async () => {
    const database = new FakeDatabase();
    const { plan } = await seededPlan(database);

    await expect(
      createEnrichmentRepairPlan(makeOptions(database, { environment: 'test' })),
    ).rejects.toThrow(/NODE_ENV=production/);
    expect(() =>
      validateEnrichmentRepairPlan(plan, makeOptions(database, { environment: 'development' })),
    ).toThrow(/NODE_ENV=production/);
    await expect(
      applyEnrichmentRepairPlan(
        plan,
        makeOptions(database, { databaseEmulatorHost: '127.0.0.1:9000' }),
      ),
    ).rejects.toThrow(/FIREBASE_DATABASE_EMULATOR_HOST/);
    await expect(
      applyEnrichmentRepairPlan(plan, makeOptions(database, { databaseHost: 'localhost:9000' })),
    ).rejects.toThrow(/exact production host/);
    await expect(
      applyEnrichmentRepairPlan(plan, makeOptions(database, { uid: 'some-other-uid-000000000' })),
    ).rejects.toThrow(/bound to demo uid/);
  });
});

describe('repairEnrichmentAuthorizationsCore — apply', () => {
  it('reauthorizes each stale receipt to the SAME target under the current fingerprint and replaces the reviewed pairs successor-first', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);
    const attachedPredecessorId = REVIEWED_PAIRS[2]!.predecessorObservationId;

    const checkpoints: string[] = [];
    let predecessorPresentAtPairProjection = false;
    let successorAuthorizedAtPairProjection = false;
    const result = await applyEnrichmentRepairPlan(plan, {
      ...options,
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
        if (checkpoint === `after-projection:${PAIR_TARGET_SET_ID}`) {
          const dump = database.dump() as Record<string, Record<string, unknown>>;
          predecessorPresentAtPairProjection =
            (dump.researchEnrichmentObservations?.[UID] as Record<string, unknown>)?.[
              attachedPredecessorId
            ] != null;
          successorAuthorizedAtPairProjection =
            (
              (dump.researchEnrichmentAttachments?.[UID] as Record<string, unknown>)?.[
                PAIR_TARGET_SET_ID
              ] as Record<string, unknown>
            )?.[REVIEWED_PAIRS[2]!.successorObservationId] != null;
        }
      },
    });

    expect(result).toEqual({
      ok: true,
      findings: [],
      staleAuthorizationsReauthorized: REVIEWED_STALE_IDS.length,
      staleAuthorizationsRevoked: 0,
      successorsAuthorized: 1,
      predecessorsRemoved: REVIEWED_PAIRS.length,
      successorPairsDeferred: 0,
      targetSetsReprojected: REVIEWED_STALE_IDS.length + 1,
    });

    // Successor-first ordering: at the pair target's projection checkpoint
    // the successor was ALREADY authorized while the predecessor still
    // existed; only the later cascade checkpoint removes it.
    expect(predecessorPresentAtPairProjection).toBe(true);
    expect(successorAuthorizedAtPairProjection).toBe(true);
    expect(checkpoints.indexOf(`after-projection:${PAIR_TARGET_SET_ID}`)).toBeLessThan(
      checkpoints.indexOf(`after-cascade:${attachedPredecessorId}`),
    );

    const dump = database.dump() as Record<string, Record<string, Record<string, unknown>>>;
    const observations = dump.researchEnrichmentObservations![UID]!;
    const receipts = dump.researchEnrichmentReceipts![UID]!;
    const attachmentsTree = dump.researchEnrichmentAttachments![UID]! as Record<
      string,
      Record<string, Record<string, unknown>>
    >;

    // 49-class: same target, new fingerprint, receipt re-derived from the
    // CURRENT content hash by the current resolver.
    REVIEWED_STALE_IDS.forEach((observationId, i) => {
      const targetSetId = staleTarget(i);
      expect(attachmentsTree[targetSetId]![observationId]).toEqual(
        expect.objectContaining({
          targetSetId,
          attachmentSource: 'resolver',
          sourceRevisionId: CURRENT_FINGERPRINT.sourceRevisionId,
          sourceContentHash: CURRENT_HASH,
          parserVersion: VOD_PARSER,
          receiptId: deriveReceiptId({
            observationId,
            resolverVersion: RESOLVER_VERSION,
            sourceContentHash: CURRENT_HASH,
          }),
        }),
      );
      expect(receipts[observationId]).toEqual(
        expect.objectContaining({
          resolverVersion: RESOLVER_VERSION,
          sourceContentHash: CURRENT_HASH,
          targetSetId,
        }),
      );
    });

    // 3-class: predecessors and their derived state are gone; the successor
    // carries the authorization.
    for (const pair of REVIEWED_PAIRS) {
      expect(observations[pair.predecessorObservationId]).toBeUndefined();
      expect(receipts[pair.predecessorObservationId]).toBeUndefined();
    }
    expect(attachmentsTree[PAIR_TARGET_SET_ID]![attachedPredecessorId]).toBeUndefined();
    expect(attachmentsTree[PAIR_TARGET_SET_ID]![REVIEWED_PAIRS[2]!.successorObservationId]).toEqual(
      expect.objectContaining({ sourceContentHash: CURRENT_HASH }),
    );

    // Projection actually converged the repaired rows (fill-empty VOD).
    const matchRow = dump.matches![UID]![deriveEnrichmentMatchRowKey(staleTarget(0), 1)] as Record<
      string,
      unknown
    >;
    expect(matchRow.vodUrl).toBe(vodUrlFor(staleIndex(0)));

    // The maintenance lease was released.
    const run = dump.researchEnrichmentRuns![UID] as Record<string, unknown>;
    expect(run.lease ?? null).toBeNull();
  });

  it('classifies an abstaining reviewed id REVOKE-ONLY (never reauthorize) and a non-re-resolving pair DEFER, then applies exactly that split', async () => {
    const database = new FakeDatabase();
    // The expected live-production split: aa0baa79… abstains under the
    // corrected resolver, and 0ebbadd3…'s successor 801570fa… no longer
    // re-proves target 102512871.
    const abstainingId = 'aa0baa79aaf76f91484d5ac46abe33f9';
    const { plan, options } = await seededPlan(database, {
      uncorroboratedStaleIds: [abstainingId],
      deferAttachedPair: true,
    });
    const abstainingIndex = REVIEWED_STALE_IDS.indexOf(abstainingId);
    const deferredPair = REVIEWED_PAIRS[2]!;

    // (b) RED direction at classification: the abstaining reviewed id is
    // NOT forced through reauthorization.
    expect(plan.blockedReasons).toEqual([]);
    const abstainingAction = plan.staleAuthorizations.find(
      (action) => action.observationId === abstainingId,
    )!;
    expect(abstainingAction.disposition).toBe('revoke-only');
    expect(abstainingAction.reason).toMatch(/abstain/);
    expect(
      plan.staleAuthorizations.filter((action) => action.disposition === 'reauthorize'),
    ).toHaveLength(REVIEWED_STALE_IDS.length - 1);
    const deferredEntry = plan.successorPairs.find(
      (pair) => pair.predecessorObservationId === deferredPair.predecessorObservationId,
    )!;
    expect(deferredEntry.disposition).toBe('defer');
    expect(deferredEntry.reason).toMatch(/abstain.*predecessor target set-pair-3/);
    expect(deferredEntry.targetSetId).toBe(PAIR_TARGET_SET_ID);

    // A fully-classified plan with revoke-only/defer entries is NOT
    // blocked — these are reviewed dispositions, not blockers.
    expect(validateEnrichmentRepairPlan(plan, options)).toEqual(plan);

    const deferredBefore = pairFootprint(database, deferredPair.predecessorObservationId);
    const result = await applyEnrichmentRepairPlan(plan, options);

    expect(result).toEqual({
      ok: true,
      findings: [],
      staleAuthorizationsReauthorized: REVIEWED_STALE_IDS.length - 1,
      staleAuthorizationsRevoked: 1,
      successorsAuthorized: 0,
      predecessorsRemoved: 2,
      successorPairsDeferred: 1,
      targetSetsReprojected: REVIEWED_STALE_IDS.length,
    });

    const dump = database.dump() as Record<string, Record<string, Record<string, unknown>>>;
    // Revoke-only: receipt and attachment atomically gone, observation
    // untouched — the row is back in the review queue by attachment absence.
    expect(dump.researchEnrichmentReceipts![UID]![abstainingId]).toBeUndefined();
    expect(
      (
        dump.researchEnrichmentAttachments![UID]![staleTarget(abstainingIndex)] as
          Record<string, unknown> | undefined
      )?.[abstainingId],
    ).toBeUndefined();
    expect(dump.researchEnrichmentObservations![UID]![abstainingId]).toEqual(
      vodRowRecord(abstainingId, staleIndex(abstainingIndex), CURRENT_FINGERPRINT),
    );

    // (c) Defer leaves the predecessor's ENTIRE footprint byte-untouched.
    expect(pairFootprint(database, deferredPair.predecessorObservationId)).toBe(deferredBefore);
  });

  it('RED: refuses the predecessor cascade when the successor has vanished, leaving the predecessor untouched', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);
    const vanishedSuccessor = REVIEWED_PAIRS[0]!.successorObservationId;

    // The successor of one reviewed pair disappears after review.
    await database.ref(`researchEnrichmentObservations/${UID}/${vanishedSuccessor}`).remove();
    const before = JSON.stringify(database.dump());

    // apply refuses on the exact-state gate; resume (the crash-recovery
    // door, which skips that gate) must STILL refuse: successors are part
    // of the PROTECTED state (only predecessors may lawfully change), so a
    // vanished successor trips the monotonic-state proof before any write.
    await expect(applyEnrichmentRepairPlan(plan, options)).rejects.toThrow(/exact reviewed state/);
    await expect(resumeEnrichmentRepairPlan(plan, options)).rejects.toThrow(
      /outside the reviewed repair paths/,
    );

    expect(JSON.stringify(database.dump())).toBe(before);

    // The store boundary independently refuses a cascade without a present
    // successor — even when addressed directly.
    const removed = await removeReplacedObservationAfterSuccessor(
      asDatabase(database),
      UID,
      REVIEWED_PAIRS[0]!.predecessorObservationId,
      vanishedSuccessor,
    );
    expect(removed.outcome).toBe('rejected');
    expect(
      (database.dump() as Record<string, Record<string, Record<string, unknown>>>)
        .researchEnrichmentObservations![UID]![REVIEWED_PAIRS[0]!.predecessorObservationId],
    ).toBeDefined();
  });

  it('RED: refuses an initial apply against any state other than the reviewed bytes', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);
    // Unrelated drift: a brand-new observation lands after plan review.
    await database
      .ref(`researchEnrichmentObservations/${UID}/driftrow0000000000000000000000dd`)
      .set(vodRowRecord('driftrow0000000000000000000000dd', 999, CURRENT_FINGERPRINT));

    await expect(applyEnrichmentRepairPlan(plan, options)).rejects.toThrow(/exact reviewed state/);
  });
});

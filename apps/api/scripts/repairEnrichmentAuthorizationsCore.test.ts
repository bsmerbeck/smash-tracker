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
  ENRICHMENT_REPAIR_TARGETS,
  resumeEnrichmentRepairPlan,
  validateEnrichmentRepairPlan,
  type EnrichmentRepairOptions,
  type EnrichmentRepairPlan,
} from './repairEnrichmentAuthorizationsCore.js';

/**
 * The bounded one-time repair operator's own proof, against FakeDatabase
 * only (this file NEVER contacts a real database). The fixture is generated
 * FROM `ENRICHMENT_REPAIR_TARGETS.mkleo`'s anti-vacuity contract — 173
 * current rows, 22 stale authorizations, 3 successor pairs — so the fixture
 * and the operator's hard-coded production expectations can never drift
 * apart silently. Every refusal path asserted here is exercised in its
 * FAILING direction (RED) beside the converging one (GREEN).
 */

const ACCOUNT = 'mkleo' as const;
const UID = ENRICHMENT_REPAIR_TARGETS.mkleo.uid;
const PAGE_TITLE = ENRICHMENT_REPAIR_TARGETS.mkleo.sourcePageTitle;
const CURRENT_COUNT = ENRICHMENT_REPAIR_TARGETS.mkleo.currentCohortCount;
const STALE_COUNT = ENRICHMENT_REPAIR_TARGETS.mkleo.staleAuthorizationCount;
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
  index: number,
  fingerprint: Fingerprint,
  observationId = `vodrow-${pad(index)}`,
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
    tournamentPageTitle: `Tournament_${index}`,
    vodUrl: vodUrlFor(index),
    resolutionReasons: [LIQUIPEDIA_VOD_LIST_RESOLUTION_REASON],
  };
}

function bracketRecord(index: number): Record<string, unknown> {
  return {
    observationId: `bracket-${pad(index)}`,
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: `Tournament_${index}/Bracket`,
    sourcePageUrl: `https://liquipedia.net/smash/Tournament_${index}`,
    sourceRevisionId: 700 + index,
    sourceContentHash: sha(`bracket-${index}`),
    parserVersion: 'liquipedia-bracket-match2@1',
    templateFamily: 'match2',
    fetchedAtMs: NOW_MS - 50_000,
    observedAtMs: NOW_MS - 50_000,
    matchingStatus: 'matched',
    tournamentPageTitle: `Tournament_${index}`,
    vodUrl: vodUrlFor(index),
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

/**
 * Seeds the mkleo repair universe:
 * - `CURRENT_COUNT` current-cohort VOD-list rows (`vodrow-001..`);
 * - `staleCount` of them (the 49-class) attached under a PRIOR-cohort
 *   fingerprint with the matching prior receipt, plus one corroborating
 *   authorized bracket row per target so the current row independently
 *   re-resolves to the SAME target;
 * - 3 obsolete predecessors (the 3-class): `pred-1`/`pred-2` unattached and
 *   receiptless, `pred-3` validly attached at its own obsolete fingerprint,
 *   each with a semantic successor in the current cohort;
 * - the terminal run, the generated-page cache contract, and one empty
 *   match row per repaired target.
 */
async function seedRepairFixture(
  database: FakeDatabase,
  staleCount: number = STALE_COUNT,
): Promise<void> {
  const observations: Record<string, unknown> = {};
  const receipts: Record<string, unknown> = {};
  const attachments: Record<string, Record<string, unknown>> = {};
  const matches: Record<string, unknown> = {};

  for (let index = 1; index <= CURRENT_COUNT; index += 1) {
    const row = vodRowRecord(index, CURRENT_FINGERPRINT);
    observations[row.observationId as string] = row;
  }

  for (let index = 1; index <= staleCount; index += 1) {
    const observationId = `vodrow-${pad(index)}`;
    const targetSetId = `set-${pad(index)}`;
    const stale = resolverAuthorization(observationId, targetSetId, STALE_FINGERPRINT);
    receipts[observationId] = stale.receipt;
    attachments[targetSetId] = { [observationId]: stale.attachment };

    const bracket = bracketRecord(index);
    observations[bracket.observationId as string] = bracket;
    const corroborating = resolverAuthorization(
      bracket.observationId as string,
      targetSetId,
      fingerprintOf(bracket),
    );
    receipts[bracket.observationId as string] = corroborating.receipt;
    attachments[targetSetId]![bracket.observationId as string] = corroborating.attachment;

    matches[deriveEnrichmentMatchRowKey(targetSetId, 1)] = { note: 'seed', map: UNKNOWN_STAGE };
  }

  // Successor pairs: predecessors share the semantic identity of the
  // current rows at indices 171/172/173 but carry the obsolete fingerprint.
  for (const pairIndex of [1, 2]) {
    const predecessor = vodRowRecord(170 + pairIndex, OBSOLETE_FINGERPRINT, `pred-${pairIndex}`);
    observations[`pred-${pairIndex}`] = predecessor;
  }
  const attachedPredecessor = vodRowRecord(173, OBSOLETE_FINGERPRINT, 'pred-3');
  observations['pred-3'] = attachedPredecessor;
  const predecessorAuthorization = resolverAuthorization(
    'pred-3',
    PAIR_TARGET_SET_ID,
    OBSOLETE_FINGERPRINT,
  );
  receipts['pred-3'] = predecessorAuthorization.receipt;
  attachments[PAIR_TARGET_SET_ID] = { 'pred-3': predecessorAuthorization.attachment };

  const pairBracket = bracketRecord(173);
  observations[pairBracket.observationId as string] = pairBracket;
  const pairCorroboration = resolverAuthorization(
    pairBracket.observationId as string,
    PAIR_TARGET_SET_ID,
    fingerprintOf(pairBracket),
  );
  receipts[pairBracket.observationId as string] = pairCorroboration.receipt;
  attachments[PAIR_TARGET_SET_ID]![pairBracket.observationId as string] =
    pairCorroboration.attachment;
  matches[deriveEnrichmentMatchRowKey(PAIR_TARGET_SET_ID, 1)] = {
    note: 'seed',
    map: UNKNOWN_STAGE,
  };

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
): Promise<{ plan: EnrichmentRepairPlan; options: EnrichmentRepairOptions }> {
  await seedRepairFixture(database);
  const options = makeOptions(database);
  const plan = await createEnrichmentRepairPlan(options);
  return { plan, options };
}

describe('repairEnrichmentAuthorizationsCore — plan/hash/validate cycle', () => {
  it('plans exactly the reviewed 22+3 bounded actions with no blockers, and the plan validates against its own hash', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);

    expect(plan.blockedReasons).toEqual([]);
    expect(plan.staleAuthorizations).toHaveLength(STALE_COUNT);
    expect(plan.successorPairs).toHaveLength(3);
    expect(plan.pageCohorts).toEqual([
      expect.objectContaining({
        sourcePageTitle: PAGE_TITLE,
        currentCohortCount: CURRENT_COUNT,
        cacheObservationCount: CURRENT_COUNT,
      }),
    ]);
    expect(plan.staleAuthorizations[0]).toEqual(
      expect.objectContaining({
        observationId: 'vodrow-001',
        targetSetId: 'set-001',
        priorFingerprint: expect.objectContaining({ sourceContentHash: STALE_ATTACHMENT_HASH }),
        currentFingerprint: expect.objectContaining({ sourceContentHash: CURRENT_HASH }),
      }),
    );
    expect(plan.successorPairs.map((pair) => pair.targetSetId)).toEqual([
      null,
      null,
      PAIR_TARGET_SET_ID,
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

  it('blocks a plan whose action count exceeds ENRICHMENT_REPAIR_MAX_ACTIONS', async () => {
    const database = new FakeDatabase();
    // 99 fully-valid stale authorizations + 3 successor pairs = 102 > 100,
    // while each individual array stays inside the schema's own 100 cap so
    // the SUM bound (not the per-array bound) is what fires.
    await seedRepairFixture(database, ENRICHMENT_REPAIR_MAX_ACTIONS - 1);
    const options = makeOptions(database);

    const plan = await createEnrichmentRepairPlan(options);
    expect(plan.blockedReasons).toContain(
      `repair exceeds ${ENRICHMENT_REPAIR_MAX_ACTIONS} bounded actions`,
    );
    expect(() => validateEnrichmentRepairPlan(plan, options)).toThrow(/repair plan is blocked/);
    await expect(applyEnrichmentRepairPlan(plan, options)).rejects.toThrow(
      /repair plan is blocked/,
    );
  });

  it('the plan schema itself refuses more than ENRICHMENT_REPAIR_MAX_ACTIONS entries in one action array', async () => {
    const database = new FakeDatabase();
    await seedRepairFixture(database, ENRICHMENT_REPAIR_MAX_ACTIONS + 1);

    // 101 stale entries can never even be ENCODED as a plan — the array cap
    // rejects at hash time, before any blocked-reason review could be argued
    // around.
    await expect(createEnrichmentRepairPlan(makeOptions(database))).rejects.toThrow(/100/);
  });
});

describe('repairEnrichmentAuthorizationsCore — apply', () => {
  it('reauthorizes each stale receipt to the SAME target under the current fingerprint and replaces the 3 obsolete rows successor-first', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);

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
            (dump.researchEnrichmentObservations?.[UID] as Record<string, unknown>)?.['pred-3'] !=
            null;
          successorAuthorizedAtPairProjection =
            (
              (dump.researchEnrichmentAttachments?.[UID] as Record<string, unknown>)?.[
                PAIR_TARGET_SET_ID
              ] as Record<string, unknown>
            )?.['vodrow-173'] != null;
        }
      },
    });

    expect(result).toEqual({
      ok: true,
      findings: [],
      staleAuthorizationsReauthorized: STALE_COUNT,
      successorsAuthorized: 1,
      predecessorsRemoved: 3,
      targetSetsReprojected: STALE_COUNT + 1,
    });

    // Successor-first ordering: at the pair target's projection checkpoint
    // the successor was ALREADY authorized while the predecessor still
    // existed; only the later cascade checkpoint removes it.
    expect(predecessorPresentAtPairProjection).toBe(true);
    expect(successorAuthorizedAtPairProjection).toBe(true);
    expect(checkpoints.indexOf(`after-projection:${PAIR_TARGET_SET_ID}`)).toBeLessThan(
      checkpoints.indexOf('after-cascade:pred-3'),
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
    for (let index = 1; index <= STALE_COUNT; index += 1) {
      const observationId = `vodrow-${pad(index)}`;
      const targetSetId = `set-${pad(index)}`;
      const attachment = attachmentsTree[targetSetId]![observationId]!;
      expect(attachment).toEqual(
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
    }

    // 3-class: predecessors and their derived state are gone; the successor
    // carries the authorization.
    for (const predecessorId of ['pred-1', 'pred-2', 'pred-3']) {
      expect(observations[predecessorId]).toBeUndefined();
      expect(receipts[predecessorId]).toBeUndefined();
    }
    expect(attachmentsTree[PAIR_TARGET_SET_ID]!['pred-3']).toBeUndefined();
    expect(attachmentsTree[PAIR_TARGET_SET_ID]!['vodrow-173']).toEqual(
      expect.objectContaining({ sourceContentHash: CURRENT_HASH }),
    );

    // Projection actually converged the repaired rows (fill-empty VOD).
    const matchRow = dump.matches![UID]![deriveEnrichmentMatchRowKey('set-001', 1)] as Record<
      string,
      unknown
    >;
    expect(matchRow.vodUrl).toBe(vodUrlFor(1));

    // The maintenance lease was released.
    const run = dump.researchEnrichmentRuns![UID] as Record<string, unknown>;
    expect(run.lease ?? null).toBeNull();
  });

  it('RED: refuses the predecessor cascade when the successor has vanished, leaving the predecessor untouched', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);

    // The successor of the null-target pair disappears after review.
    await database.ref(`researchEnrichmentObservations/${UID}/vodrow-171`).remove();
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
      'pred-1',
      'vodrow-171',
    );
    expect(removed.outcome).toBe('rejected');
    expect(
      (database.dump() as Record<string, Record<string, Record<string, unknown>>>)
        .researchEnrichmentObservations![UID]!['pred-1'],
    ).toBeDefined();
  });

  it('RED: refuses an initial apply against any state other than the reviewed bytes', async () => {
    const database = new FakeDatabase();
    const { plan, options } = await seededPlan(database);
    // Unrelated drift: a brand-new observation lands after plan review.
    await database
      .ref(`researchEnrichmentObservations/${UID}/vodrow-999`)
      .set(vodRowRecord(999, CURRENT_FINGERPRINT, 'vodrow-999'));

    await expect(applyEnrichmentRepairPlan(plan, options)).rejects.toThrow(/exact reviewed state/);
  });
});

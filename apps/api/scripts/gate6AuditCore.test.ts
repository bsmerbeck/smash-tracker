import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  TOURNAMENT_REGISTRY_ORIGIN,
  TOURNAMENT_REGISTRY_WITNESS_PREFIX,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import {
  GATE6_ASSERTION_IDS,
  GATE6_EXPECTATION_TABLE_VERSION,
  GATE6_EXPECTATIONS,
  GATE6_SPARG0_USER_OWNED_VOD_ROWS,
  GATE6_WORKSPACE_KEYS,
  parseGate6Baseline,
  runGate6Audit,
  type Gate6AssertionId,
  type Gate6AuditReceipt,
  type Gate6Baseline,
  type Gate6UidMap,
  type Gate6WorkspaceKey,
} from './gate6AuditCore.js';

/**
 * Phase 30.3 Gate 6 — the oracle's own proof.
 *
 * AN ORACLE THAT CANNOT FAIL IS NOT AN ORACLE. The rejected ad-hoc probe
 * "generally exits zero"; the only way to know this one does not is to
 * perturb a CORRECT corpus in exactly one way per assertion and require the
 * audit to go red with a NAMED finding code. Every assertion below therefore
 * gets a matched pair: the shared correct tree passes it, and a single-fact
 * perturbation fails it.
 *
 * The correct tree is generated FROM `GATE6_EXPECTATIONS`, not from
 * hand-typed duplicates of it, so the fixture and the contract can never
 * drift apart — a change to the expectation table that the fixture cannot
 * satisfy fails the anti-vacuity checks in the first describe block.
 */

const UIDS: Gate6UidMap = {
  hbox: 'gate6-hbox-uid',
  mkleo: 'gate6-mkleo-uid',
  sparg0: 'gate6-sparg0-uid',
  izaw: 'gate6-izaw-uid',
};
const NOW_MS = 1_800_000_000_000;
const UNRELATED_UID = 'gate6-unrelated-uid';
const IZAW_TENANT = 'gate6-izaw-tenant';
const OTHER_COACH_UID = 'gate6-other-coach-uid';
const OTHER_COACH_TENANT = 'gate6-other-coach-tenant';

const PARSER_VERSION = 'bracket-match2@3';
const RESOLVER_VERSION = 'resolver@1';

function contentHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function observationRecord(observationId: string, revision: number): Record<string, unknown> {
  return {
    observationId,
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: `Tournament ${observationId}`,
    sourcePageUrl: `https://liquipedia.net/smash/Page_${revision}`,
    sourceRevisionId: revision,
    sourceContentHash: contentHash(observationId),
    parserVersion: PARSER_VERSION,
    templateFamily: 'match2',
    fetchedAtMs: NOW_MS - 5_000,
    observedAtMs: NOW_MS - 5_000,
    matchingStatus: 'matched',
  };
}

function receiptRecord(
  observationId: string,
  targetSetId: string,
  revision: number,
): Record<string, unknown> {
  return {
    receiptId: `receipt-${observationId}`,
    observationId,
    targetSetId,
    confidence: 'high',
    resolvedAtMs: NOW_MS - 4_000,
    resolverVersion: RESOLVER_VERSION,
    sourceRevisionId: revision,
    sourceContentHash: contentHash(observationId),
    parserVersion: PARSER_VERSION,
    candidateTargetSetIds: [targetSetId],
  };
}

function attachmentRecord(
  observationId: string,
  targetSetId: string,
  revision: number,
): Record<string, unknown> {
  return {
    observationId,
    targetSetId,
    attachmentSource: 'resolver',
    attachedAtMs: NOW_MS - 3_000,
    sourceRevisionId: revision,
    sourceContentHash: contentHash(observationId),
    parserVersion: PARSER_VERSION,
    receiptId: `receipt-${observationId}`,
  };
}

function ownedRegistryRow(eventId: string): Record<string, unknown> {
  return {
    origin: TOURNAMENT_REGISTRY_ORIGIN,
    registryWitness: `${TOURNAMENT_REGISTRY_WITNESS_PREFIX}${eventId}`,
    startggEventId: eventId,
    eventName: 'Ultimate Singles',
    playedSetCount: 4,
    provenance: { source: 'research-import', importedAtMs: NOW_MS - 100_000 },
    firstSetAt: 1,
    lastSetAt: 2,
    setsPlayed: 4,
  };
}

/** Manual / start.gg-synced / parry.gg-synced children — everything the projector must never touch. */
function foreignRegistryRow(name: string): Record<string, unknown> {
  return { name, firstSetAt: 10, lastSetAt: 20, setsPlayed: 3 };
}

function enrichmentRunRecord(status: 'completed' | 'running'): Record<string, unknown> {
  return {
    runId: 'gate6-run-1',
    status,
    startedAtMs: NOW_MS - 600_000,
    ...(status === 'completed' ? { completedAtMs: NOW_MS - 60_000 } : {}),
    leaseFenceCounter: 7,
  };
}

function ingestionRunState(status: 'completed' | 'running'): Record<string, unknown> {
  return {
    activeRunId: 'ingest-run-1',
    runs: {
      'ingest-run-1': {
        status,
        mode: 'full',
        playerId: '1802316',
        requestedByUid: 'gate6-admin-uid',
        startedAtMs: NOW_MS - 900_000,
        ...(status === 'completed' ? { completedAtMs: NOW_MS - 120_000 } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The correct corpus — generated from the expectation table itself.
// ---------------------------------------------------------------------------

/** The witness rows a workspace's attachments imply: 3 game ordinals per attached target set. */
const WITNESS_ORDINALS_PER_SET = 3;

function targetSetIdFor(workspace: Gate6WorkspaceKey, index: number): string {
  return `set-${workspace}-${index}`;
}

function matchRowKey(targetSetId: string, ordinal: number): string {
  return `sgg-${targetSetId}-g${ordinal}`;
}

interface BuiltWorkspace {
  matches: Record<string, unknown>;
  observations: Record<string, unknown>;
  receipts: Record<string, unknown>;
  attachments: Record<string, Record<string, unknown>>;
  witnesses: Record<string, unknown>;
  tournamentEntries: Record<string, unknown>;
}

function buildWorkspace(workspace: Gate6WorkspaceKey): BuiltWorkspace {
  const expectation = GATE6_EXPECTATIONS[workspace];
  const built: BuiltWorkspace = {
    matches: {},
    observations: {},
    receipts: {},
    attachments: {},
    witnesses: {},
    tournamentEntries: {
      [`histimport:${workspace}-1`]: ownedRegistryRow(`${workspace}-1`),
      [`histimport:${workspace}-2`]: ownedRegistryRow(`${workspace}-2`),
      [`manual-${workspace}-a`]: foreignRegistryRow(`${workspace} manual A`),
      [`pgg-${workspace}-b`]: foreignRegistryRow(`${workspace} parry B`),
    },
  };

  for (let index = 0; index < expectation.observations; index += 1) {
    const observationId = `obs-${workspace}-${index}`;
    built.observations[observationId] = observationRecord(observationId, 1000 + index);
  }

  // Attachments: one per target set, each authorized by its own receipt, and
  // each target set carrying `WITNESS_ORDINALS_PER_SET` real match rows.
  for (let index = 0; index < expectation.attachments; index += 1) {
    const observationId = `obs-${workspace}-${index}`;
    const targetSetId = targetSetIdFor(workspace, index);
    const revision = 1000 + index;
    built.receipts[observationId] = receiptRecord(observationId, targetSetId, revision);
    built.attachments[targetSetId] = {
      [observationId]: attachmentRecord(observationId, targetSetId, revision),
    };
  }

  // Hungrybox has observations but zero receipts by contract; every other
  // workspace's receipt population is exactly its attachment population.
  if (expectation.receipts !== null && expectation.receipts !== expectation.attachments) {
    expect(expectation.receipts).toBe(0);
  }

  let witnessIndex = 0;
  for (let index = 0; index < expectation.attachments; index += 1) {
    const targetSetId = targetSetIdFor(workspace, index);
    const observationId = `obs-${workspace}-${index}`;
    for (let ordinal = 1; ordinal <= WITNESS_ORDINALS_PER_SET; ordinal += 1) {
      const matchKey = matchRowKey(targetSetId, ordinal);
      built.matches[matchKey] = { fighter_id: 1, opponent_id: 8, time: 1, win: true };
      built.witnesses[matchKey] = {
        matchKey,
        targetSetId,
        // Every witness carries at least a stage claim, so none is inert.
        projectedStageId: 31,
        projectedStageName: 'Battlefield',
        stageObservationId: observationId,
        stageProjectedAtMs: NOW_MS - 2_000,
        ...(witnessIndex < expectation.characterWitnesses
          ? {
              projectedSubjectSeat: 1,
              projectedSubjectCharRaw: 'Joker',
              charsObservationId: observationId,
              charsProjectedAtMs: NOW_MS - 2_000,
            }
          : {}),
        ...(witnessIndex < expectation.stockWitnesses
          ? {
              projectedStocksLeft: 2,
              stocksObservationId: observationId,
              stocksProjectedAtMs: NOW_MS - 2_000,
            }
          : {}),
      };
      witnessIndex += 1;
    }
  }

  // Sparg0's protected user-entered VODs: rows whose stored `vodUrl` no
  // witness vouches for. Paired with source-OWNED VOD rows below so the
  // discriminator is genuinely exercised rather than trivially satisfied.
  if (workspace === 'sparg0') {
    for (let index = 1; index <= GATE6_SPARG0_USER_OWNED_VOD_ROWS; index += 1) {
      const key = `user-vod-${String(index).padStart(2, '0')}`;
      built.matches[key] = {
        fighter_id: 1,
        opponent_id: 8,
        time: 1,
        win: true,
        vodUrl: `https://youtu.be/user-entered-${index}`,
      };
    }
    for (let index = 0; index < 5; index += 1) {
      const matchKey = matchRowKey(targetSetIdFor('sparg0', index), 1);
      const projectedVodUrl = `https://youtu.be/source-owned-${index}`;
      (built.matches[matchKey] as Record<string, unknown>).vodUrl = projectedVodUrl;
      (built.witnesses[matchKey] as Record<string, unknown>).projectedVodUrl = projectedVodUrl;
      (built.witnesses[matchKey] as Record<string, unknown>).vodObservationId =
        `obs-sparg0-${index}`;
    }
  }

  // Track the running count rather than re-deriving `Object.keys().length`
  // per iteration — at 8,582 rows the naive form is quadratic.
  let rowCount = Object.keys(built.matches).length;
  for (let filler = 0; rowCount < expectation.matches; filler += 1) {
    built.matches[`m-${workspace}-${filler}`] = {
      fighter_id: 1,
      opponent_id: 8,
      time: 1,
      win: false,
    };
    rowCount += 1;
  }

  return built;
}

/** The whole correct RTDB root. Built once; every test seeds a fresh FakeDatabase from it. */
function buildCorrectTree(): Record<string, unknown> {
  const tree: Record<string, unknown> = {
    matches: {},
    researchEnrichmentObservations: {},
    researchEnrichmentReceipts: {},
    researchEnrichmentAttachments: {},
    researchEnrichmentProjection: {},
    tournamentEntries: {},
    researchEnrichmentRuns: {},
    researchIngestionRuns: {},
    clientMembers: {
      [IZAW_TENANT]: { [UIDS.izaw]: { role: 'custodian', joinedAt: 1 } },
      [OTHER_COACH_TENANT]: { [OTHER_COACH_UID]: { role: 'custodian', joinedAt: 1 } },
    },
    coachClients: {
      [UIDS.izaw]: { [IZAW_TENANT]: { label: 'IzAw client', createdAt: 1 } },
      [OTHER_COACH_UID]: { [OTHER_COACH_TENANT]: { label: 'Other client', createdAt: 1 } },
    },
    // Zero-trace POSITIVE CONTROL: unrelated rows in every scanned tree, so
    // the zero-trace assertion is proven to be scanning a non-empty
    // population rather than passing on emptiness.
    eventLedger: {
      '2026-01-01': {
        evt1: {
          eventId: 'e1',
          eventName: 'signup_completed',
          schemaVersion: 1,
          occurredAt: 1,
          receivedAt: 1,
          actorKind: 'user',
          actorId: UNRELATED_UID,
          sessionId: 's1',
          source: 'api',
          causationId: `${UNRELATED_UID}:c1`,
          consentState: 'granted',
          payload: {},
        },
      },
    },
    outboxPending: { '2026-01-01': { evt1: { attempt: 0 } } },
    eventDedup: { signup_completed: { 1: { [`${UNRELATED_UID}:c1`]: true } } },
    shareTokens: { tok1: { shareId: 's1', ownerUid: UNRELATED_UID, permissions: 'view' } },
    creditLedger: { [UNRELATED_UID]: { l1: { delta: -1 } } },
    credits: { [UNRELATED_UID]: { balance: 5 } },
    reportJobs: { [UNRELATED_UID]: { j1: { status: 'complete' } } },
    reportJobsByStatus: { running: { [UNRELATED_UID]: { j1: true } } },
  };

  for (const workspace of GATE6_WORKSPACE_KEYS) {
    const uid = UIDS[workspace];
    const built = buildWorkspace(workspace);
    (tree.matches as Record<string, unknown>)[uid] = built.matches;
    (tree.researchEnrichmentObservations as Record<string, unknown>)[uid] = built.observations;
    (tree.researchEnrichmentReceipts as Record<string, unknown>)[uid] = built.receipts;
    (tree.researchEnrichmentAttachments as Record<string, unknown>)[uid] = built.attachments;
    (tree.researchEnrichmentProjection as Record<string, unknown>)[uid] = built.witnesses;
    (tree.tournamentEntries as Record<string, unknown>)[uid] = built.tournamentEntries;
    if (workspace !== 'izaw') {
      (tree.researchEnrichmentRuns as Record<string, unknown>)[uid] =
        enrichmentRunRecord('completed');
    }
  }
  (tree.researchIngestionRuns as Record<string, unknown>)[UIDS.mkleo] =
    ingestionRunState('completed');

  return tree;
}

let CORRECT_TREE: Record<string, unknown>;
beforeAll(() => {
  CORRECT_TREE = buildCorrectTree();
});

/** A fresh FakeDatabase holding a private deep copy of the correct tree (`seed` clones on write). */
function makeDatabase(): FakeDatabase {
  const database = new FakeDatabase();
  database.seed('', CORRECT_TREE);
  return database;
}

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

async function audit(
  database: FakeDatabase,
  overrides: { baseline?: Gate6Baseline | null; strict?: boolean } = {},
): Promise<Gate6AuditReceipt> {
  return runGate6Audit(asDatabase(database), {
    uids: UIDS,
    nowMs: NOW_MS,
    baseline: overrides.baseline ?? null,
    strictWitnessObservationRefs: overrides.strict === true,
  });
}

function assertionOf(receipt: Gate6AuditReceipt, id: Gate6AssertionId) {
  const found = receipt.assertions.find((assertion) => assertion.id === id);
  if (!found) {
    throw new Error(`no assertion ${id} in receipt`);
  }
  return found;
}

function codesOf(receipt: Gate6AuditReceipt, id: Gate6AssertionId): string[] {
  return assertionOf(receipt, id).findings.map((finding) => finding.code);
}

/**
 * The perturbation contract every negative test below asserts: the audit
 * fails overall, the NAMED assertion is the one that went red, and it carries
 * the expected machine code. `alsoRed` names assertions a perturbation is
 * legitimately allowed to trip as well (e.g. deleting a record moves a count).
 */
function expectPerturbed(
  receipt: Gate6AuditReceipt,
  id: Gate6AssertionId,
  code: string,
  alsoRed: Gate6AssertionId[] = [],
): void {
  expect(receipt.ok).toBe(false);
  expect(receipt.findingCount).toBeGreaterThan(0);
  expect(assertionOf(receipt, id).ok).toBe(false);
  expect(codesOf(receipt, id)).toContain(code);
  const allowedRed = new Set<Gate6AssertionId>([id, ...alsoRed]);
  for (const assertion of receipt.assertions) {
    if (!assertion.ok) {
      expect(allowedRed).toContain(assertion.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture integrity — the anti-vacuity guard for every test below.
// ---------------------------------------------------------------------------

describe('the correct fixture actually realizes the expectation table', () => {
  it('materializes each workspace at exactly its contracted counts', () => {
    for (const workspace of GATE6_WORKSPACE_KEYS) {
      const expectation = GATE6_EXPECTATIONS[workspace];
      const built = buildWorkspace(workspace);
      expect(Object.keys(built.matches).length).toBe(expectation.matches);
      expect(Object.keys(built.observations).length).toBe(expectation.observations);
      expect(Object.keys(built.attachments).length).toBe(expectation.attachments);
      expect(expectation.attachments * WITNESS_ORDINALS_PER_SET).toBeGreaterThanOrEqual(
        Math.max(expectation.characterWitnesses, expectation.stockWitnesses),
      );
    }
  });

  it('gives the zero-trace scan a non-empty unrelated population to walk past', async () => {
    const receipt = await audit(makeDatabase());
    expect(assertionOf(receipt, 'zero-trace-trees').inspected).toBeGreaterThanOrEqual(20);
  });

  it('exercises the user-owned/source-owned VOD discriminator on Sparg0 rather than counting every VOD row', async () => {
    const receipt = await audit(makeDatabase());
    // 13 user-entered rows are protected; the 5 witness-vouched rows are not.
    expect(receipt.baseline.sparg0UserOwnedVod.count).toBe(GATE6_SPARG0_USER_OWNED_VOD_ROWS);
    expect(
      receipt.baseline.sparg0UserOwnedVod.keys.every((key) => key.startsWith('user-vod-')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The pass case and the receipt contract.
// ---------------------------------------------------------------------------

describe('a fully-correct tree passes', () => {
  it('reports ok with zero findings across every assertion', async () => {
    const receipt = await audit(makeDatabase());
    expect(receipt.findingCount).toBe(0);
    expect(receipt.ok).toBe(true);
    for (const assertion of receipt.assertions) {
      expect(assertion.findings).toEqual([]);
      expect(assertion.ok).toBe(true);
    }
  });

  it('emits a stable receipt shape: fixed top-level keys, every assertion id, in order', async () => {
    const receipt = await audit(makeDatabase());
    expect(Object.keys(receipt).sort()).toEqual(
      [
        'assertions',
        'baseline',
        'baselineMode',
        'expectationTableVersion',
        'findingCount',
        'generatedAtMs',
        'observed',
        'ok',
        'receiptVersion',
        'strictWitnessObservationRefs',
        'targetUids',
      ].sort(),
    );
    expect(receipt.receiptVersion).toBe(1);
    expect(receipt.expectationTableVersion).toBe(GATE6_EXPECTATION_TABLE_VERSION);
    expect(receipt.baselineMode).toBe('record');
    expect(receipt.assertions.map((assertion) => assertion.id)).toEqual([...GATE6_ASSERTION_IDS]);
    for (const assertion of receipt.assertions) {
      expect(Object.keys(assertion).sort()).toEqual([
        'findings',
        'id',
        'inspected',
        'ok',
        'title',
        'tolerated',
      ]);
    }
    expect(receipt.observed.map((row) => row.workspace)).toEqual([...GATE6_WORKSPACE_KEYS]);
    expect(receipt.baseline.baselineVersion).toBe(1);
    // The receipt is JSON — no undefined, no cycles, round-trips byte-stably.
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
  });

  it('refuses an unsafe or duplicated uid map (a usage error, not a data finding)', async () => {
    const database = makeDatabase();
    await expect(
      runGate6Audit(asDatabase(database), {
        uids: { ...UIDS, hbox: 'bad.uid' },
        nowMs: NOW_MS,
      }),
    ).rejects.toThrow(/unsafe or missing uid/);
    await expect(
      runGate6Audit(asDatabase(database), {
        uids: { ...UIDS, hbox: UIDS.mkleo },
        nowMs: NOW_MS,
      }),
    ).rejects.toThrow(/unique/);
  });
});

// ---------------------------------------------------------------------------
// Assertion 1 — the expectation table.
// ---------------------------------------------------------------------------

describe('assertion 1: expected-counts', () => {
  it('fails when a match row is missing', async () => {
    const database = makeDatabase();
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.hbox
    ]!;
    delete matches[Object.keys(matches)[0]!];
    expectPerturbed(await audit(database), 'expected-counts', 'count-mismatch');
  });

  it('fails when an extra observation appears', async () => {
    const database = makeDatabase();
    database.seed(
      `researchEnrichmentObservations/${UIDS.mkleo}/obs-extra`,
      observationRecord('obs-extra', 9999),
    );
    expectPerturbed(await audit(database), 'expected-counts', 'count-mismatch');
  });

  it('fails when a receipt is fabricated on a zero-receipt workspace', async () => {
    const database = makeDatabase();
    database.seed(
      `researchEnrichmentReceipts/${UIDS.hbox}/obs-hbox-0`,
      receiptRecord('obs-hbox-0', 'set-hbox-0', 1000),
    );
    expectPerturbed(await audit(database), 'expected-counts', 'count-mismatch', [
      'attachment-integrity',
    ]);
  });

  it('fails when an attachment count moves', async () => {
    const database = makeDatabase();
    const attachments = (
      database.dump().researchEnrichmentAttachments as Record<string, Record<string, unknown>>
    )[UIDS.sparg0]!;
    delete attachments['set-sparg0-0'];
    expectPerturbed(await audit(database), 'expected-counts', 'count-mismatch', [
      'attachment-integrity',
    ]);
  });

  it('fails when a character witness loses its committed evidence', async () => {
    const database = makeDatabase();
    const witnesses = (
      database.dump().researchEnrichmentProjection as Record<
        string,
        Record<string, Record<string, unknown>>
      >
    )[UIDS.mkleo]!;
    delete witnesses[matchRowKey(targetSetIdFor('mkleo', 0), 1)]!.charsObservationId;
    const receipt = await audit(database);
    expectPerturbed(receipt, 'expected-counts', 'count-mismatch');
    expect(receipt.observed[1]!.characterWitnesses).toBe(
      GATE6_EXPECTATIONS.mkleo.characterWitnesses - 1,
    );
  });

  it('fails when a stock witness loses its committed evidence', async () => {
    const database = makeDatabase();
    const witnesses = (
      database.dump().researchEnrichmentProjection as Record<
        string,
        Record<string, Record<string, unknown>>
      >
    )[UIDS.sparg0]!;
    delete witnesses[matchRowKey(targetSetIdFor('sparg0', 0), 1)]!.stocksObservationId;
    expectPerturbed(await audit(database), 'expected-counts', 'count-mismatch');
  });
});

// ---------------------------------------------------------------------------
// Assertions 2 and 3 — run terminality and leases (the probe's wrong-location bug).
// ---------------------------------------------------------------------------

describe('assertion 2: runs-terminal', () => {
  it('fails on a still-running enrichment run read at its TRUE location (one record per tenant, not a runs map)', async () => {
    const database = makeDatabase();
    database.seed(`researchEnrichmentRuns/${UIDS.mkleo}`, enrichmentRunRecord('running'));
    const receipt = await audit(database);
    expectPerturbed(receipt, 'runs-terminal', 'run-not-terminal');
    expect(assertionOf(receipt, 'runs-terminal').findings[0]!.path).toBe(
      `researchEnrichmentRuns/${UIDS.mkleo}`,
    );
  });

  it('fails on a still-running ingestion run nested under the runs wrapper', async () => {
    const database = makeDatabase();
    database.seed(`researchIngestionRuns/${UIDS.mkleo}`, ingestionRunState('running'));
    const receipt = await audit(database);
    expectPerturbed(receipt, 'runs-terminal', 'run-not-terminal');
    expect(assertionOf(receipt, 'runs-terminal').findings[0]!.path).toBe(
      `researchIngestionRuns/${UIDS.mkleo}/runs/ingest-run-1`,
    );
  });

  it('fails on a stored run record that no longer parses (never mistaken for "no run")', async () => {
    const database = makeDatabase();
    database.seed(`researchEnrichmentRuns/${UIDS.hbox}`, { runId: 'x', status: 'not-a-status' });
    expectPerturbed(await audit(database), 'runs-terminal', 'run-record-unparseable');
  });
});

describe('assertion 3: no-active-leases', () => {
  it('fails when a running run holds an unexpired lease', async () => {
    const database = makeDatabase();
    database.seed(`researchEnrichmentRuns/${UIDS.sparg0}`, {
      ...enrichmentRunRecord('running'),
      lease: {
        ownerId: 'holder-1',
        acquiredAtMs: NOW_MS - 1_000,
        expiresAtMs: NOW_MS + 60_000,
        fence: 8,
      },
    });
    expectPerturbed(await audit(database), 'no-active-leases', 'active-lease', ['runs-terminal']);
  });

  it('does NOT fire for an EXPIRED lease — the discriminator is liveness, not lease presence', async () => {
    const database = makeDatabase();
    database.seed(`researchEnrichmentRuns/${UIDS.sparg0}`, {
      ...enrichmentRunRecord('running'),
      lease: {
        ownerId: 'holder-1',
        acquiredAtMs: NOW_MS - 300_000,
        expiresAtMs: NOW_MS - 1,
        fence: 8,
      },
    });
    const receipt = await audit(database);
    expect(assertionOf(receipt, 'no-active-leases').ok).toBe(true);
    // The run is still non-terminal, which is a different assertion's job.
    expect(assertionOf(receipt, 'runs-terminal').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Assertion 4 — schema conformance (the check the probe lacked entirely).
// ---------------------------------------------------------------------------

describe('assertion 4: schema-conformance', () => {
  it('fails on an observation that no longer parses, WITHOUT the count silently shrinking', async () => {
    const database = makeDatabase();
    // The exact production shape: a two-seat member that round-tripped to a
    // form the current schema rejects. Read schema-blind, it is still one
    // child; parsed, it is a failure. Both must be true at once.
    database.seed(`researchEnrichmentObservations/${UIDS.hbox}/obs-hbox-0`, {
      ...observationRecord('obs-hbox-0', 1000),
      games: [{ ordinal: 1, stocks: ['not', 'numbers'] }],
    });
    const receipt = await audit(database);
    expectPerturbed(receipt, 'schema-conformance', 'schema-invalid-observation');
    expect(receipt.observed[0]!.observations).toBe(GATE6_EXPECTATIONS.hbox.observations);
    expect(assertionOf(receipt, 'expected-counts').ok).toBe(true);
  });

  it('fails on a receipt that no longer parses', async () => {
    const database = makeDatabase();
    database.seed(`researchEnrichmentReceipts/${UIDS.mkleo}/obs-mkleo-0`, {
      ...receiptRecord('obs-mkleo-0', 'set-mkleo-0', 1000),
      // The falsifiability invariant: more than one surviving candidate.
      candidateTargetSetIds: ['set-mkleo-0', 'set-mkleo-9'],
    });
    expectPerturbed(await audit(database), 'schema-conformance', 'schema-invalid-receipt', [
      'attachment-integrity',
    ]);
  });

  it('fails on an attachment that no longer parses', async () => {
    const database = makeDatabase();
    const record = attachmentRecord('obs-sparg0-0', 'set-sparg0-0', 1000);
    delete record.receiptId;
    database.seed(`researchEnrichmentAttachments/${UIDS.sparg0}/set-sparg0-0/obs-sparg0-0`, record);
    expectPerturbed(await audit(database), 'schema-conformance', 'schema-invalid-attachment');
  });

  it('fails on a projection witness that no longer parses', async () => {
    const database = makeDatabase();
    const matchKey = matchRowKey(targetSetIdFor('mkleo', 1), 2);
    database.seed(`researchEnrichmentProjection/${UIDS.mkleo}/${matchKey}`, {
      matchKey,
      targetSetId: targetSetIdFor('mkleo', 1),
      projectedStageId: 31,
      stageObservationId: 'obs-mkleo-1',
      // Character/stock evidence preserved so the RAW counts are unchanged —
      // this perturbation must move validity ONLY.
      projectedSubjectSeat: 1,
      charsObservationId: 'obs-mkleo-1',
      stocksObservationId: 'obs-mkleo-1',
      // Out of the schema's 0..3 bound.
      projectedStocksLeft: 99,
    });
    expectPerturbed(await audit(database), 'schema-conformance', 'schema-invalid-witness');
  });
});

// ---------------------------------------------------------------------------
// Assertion 5 — attachment referential integrity, both directions.
// ---------------------------------------------------------------------------

describe('assertion 5: attachment-integrity', () => {
  it('fails when an attachment names an observation that does not exist', async () => {
    const database = makeDatabase();
    const observations = (
      database.dump().researchEnrichmentObservations as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    delete observations['obs-mkleo-0'];
    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-dangling-observation',
      ['expected-counts', 'witness-observation-references'],
    );
  });

  it('fails when a resolver attachment has no stored receipt', async () => {
    const database = makeDatabase();
    const receipts = (
      database.dump().researchEnrichmentReceipts as Record<string, Record<string, unknown>>
    )[UIDS.sparg0]!;
    delete receipts['obs-sparg0-0'];
    expectPerturbed(await audit(database), 'attachment-integrity', 'attachment-dangling-receipt');
  });

  it('fails when the stored receipt names a different target set', async () => {
    const database = makeDatabase();
    database.seed(
      `researchEnrichmentReceipts/${UIDS.mkleo}/obs-mkleo-0`,
      receiptRecord('obs-mkleo-0', 'set-mkleo-5', 1000),
    );
    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-receipt-target-mismatch',
    );
  });

  it('fails when the cited receiptId is not the one the stored receipt carries', async () => {
    const database = makeDatabase();
    database.seed(
      `researchEnrichmentReceipts/${UIDS.mkleo}/obs-mkleo-1/receiptId`,
      'receipt-other',
    );
    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-receipt-id-mismatch',
    );
  });

  it('fails when an attachment fingerprint no longer matches its stored observation (a stale authorization a count cannot see)', async () => {
    const database = makeDatabase();
    database.seed(
      `researchEnrichmentObservations/${UIDS.sparg0}/obs-sparg0-2/parserVersion`,
      'bracket-match2@4',
    );
    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-observation-fingerprint-mismatch',
    );
  });

  it('fails when an attachment names a target set with no match row', async () => {
    const database = makeDatabase();
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.mkleo
    ]!;
    for (let ordinal = 1; ordinal <= WITNESS_ORDINALS_PER_SET; ordinal += 1) {
      const key = matchRowKey(targetSetIdFor('mkleo', 3), ordinal);
      delete matches[key];
      matches[`m-mkleo-replacement-${ordinal}`] = { fighter_id: 1, opponent_id: 8, time: 1 };
    }
    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-dangling-target-set',
      ['witness-observation-references'],
    );
  });

  it('fails when an attached target set has no projection witness at all', async () => {
    const database = makeDatabase();
    const witnesses = (
      database.dump().researchEnrichmentProjection as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    for (let ordinal = 1; ordinal <= WITNESS_ORDINALS_PER_SET; ordinal += 1) {
      delete witnesses[matchRowKey(targetSetIdFor('mkleo', 56), ordinal)];
    }
    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-missing-projection-witness',
      ['expected-counts'],
    );
  });

  it('fails when a receipt has no observation (the reverse direction)', async () => {
    const database = makeDatabase();
    database.seed(
      `researchEnrichmentReceipts/${UIDS.sparg0}/obs-ghost`,
      receiptRecord('obs-ghost', 'set-sparg0-1', 1234),
    );
    expectPerturbed(await audit(database), 'attachment-integrity', 'receipt-dangling-observation');
  });

  it('fails when a claim-carrying witness has no attachment for its target set', async () => {
    const database = makeDatabase();
    const matchKey = 'sgg-set-mkleo-orphan-g1';
    database.seed(`matches/${UIDS.mkleo}/${matchKey}`, { fighter_id: 1, opponent_id: 8, time: 1 });
    database.seed(`researchEnrichmentProjection/${UIDS.mkleo}/${matchKey}`, {
      matchKey,
      targetSetId: 'set-mkleo-orphan',
      projectedStageId: 31,
      projectedStageName: 'Battlefield',
    });
    expectPerturbed(await audit(database), 'attachment-integrity', 'witness-orphan-target-set', [
      'expected-counts',
    ]);
  });

  it('fails when a claim-carrying witness vouches for a match row that does not exist', async () => {
    const database = makeDatabase();
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.sparg0
    ]!;
    const orphanKey = matchRowKey(targetSetIdFor('sparg0', 10), 2);
    delete matches[orphanKey];
    matches['m-sparg0-replacement'] = { fighter_id: 1, opponent_id: 8, time: 1 };
    expectPerturbed(await audit(database), 'attachment-integrity', 'witness-dangling-match-row');
  });

  it('does NOT flag a candidate-sourced witness with no attachment (the applier priority-5 merge)', async () => {
    const database = makeDatabase();
    const matchKey = 'sgg-set-mkleo-candidate-g1';
    database.seed(`matches/${UIDS.mkleo}/${matchKey}`, {
      fighter_id: 1,
      opponent_id: 8,
      time: 1,
      vodUrl: 'https://youtu.be/candidate',
    });
    database.seed(`researchEnrichmentProjection/${UIDS.mkleo}/${matchKey}`, {
      matchKey,
      targetSetId: 'set-mkleo-candidate',
      projectedVodUrl: 'https://youtu.be/candidate',
      vodCandidateId: 'cand-1',
    });
    const receipt = await audit(database);
    expect(codesOf(receipt, 'attachment-integrity')).not.toContain('witness-orphan-target-set');
  });
});

// ---------------------------------------------------------------------------
// Assertion 6 — no fabricated startggLinks.
// ---------------------------------------------------------------------------

describe('assertion 6: no-startgg-links', () => {
  it('fails when any demo uid has a startggLinks record', async () => {
    const database = makeDatabase();
    database.seed(`startggLinks/${UIDS.izaw}`, { gamerTag: 'IzAw', lastSyncAt: NOW_MS });
    const receipt = await audit(database);
    expectPerturbed(receipt, 'no-startgg-links', 'startgg-link-present');
    expect(assertionOf(receipt, 'no-startgg-links').findings[0]!.workspace).toBe('izaw');
  });

  it('inspects all four uids even when all are clean', async () => {
    const receipt = await audit(makeDatabase());
    expect(assertionOf(receipt, 'no-startgg-links').inspected).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Assertion 7 — protected Sparg0 VOD preservation.
// ---------------------------------------------------------------------------

describe('assertion 7: sparg0-vod-preservation', () => {
  it('records a digest in record mode and passes an unchanged compare against it', async () => {
    const recorded = await audit(makeDatabase());
    expect(recorded.baselineMode).toBe('record');
    const compared = await audit(makeDatabase(), { baseline: recorded.baseline });
    expect(compared.baselineMode).toBe('compare');
    expect(assertionOf(compared, 'sparg0-vod-preservation').ok).toBe(true);
    expect(compared.ok).toBe(true);
  });

  it('fails on a user VOD overwrite when compared against the pre-state baseline', async () => {
    const recorded = await audit(makeDatabase());
    const database = makeDatabase();
    database.seed(`matches/${UIDS.sparg0}/user-vod-01/vodUrl`, 'https://youtu.be/CLOBBERED');
    const receipt = await audit(database, { baseline: recorded.baseline });
    expectPerturbed(receipt, 'sparg0-vod-preservation', 'digest-drift');
    expect(assertionOf(receipt, 'sparg0-vod-preservation').findings[0]!.detail).toContain(
      'a stored value changed',
    );
  });

  it('fails on a DELETED user VOD even with NO baseline — the record-mode false-green is closed by the pinned count', async () => {
    const database = makeDatabase();
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.sparg0
    ]!;
    delete (matches['user-vod-07'] as Record<string, unknown>).vodUrl;
    const receipt = await audit(database);
    expectPerturbed(receipt, 'sparg0-vod-preservation', 'protected-vod-count-mismatch');
    expect(receipt.baselineMode).toBe('record');
  });

  it('fails when the enrichment applier claims ownership of a previously user-owned VOD', async () => {
    const recorded = await audit(makeDatabase());
    const database = makeDatabase();
    // A witness that now vouches for the user's URL reclassifies the row as
    // source-owned — the silent-capture failure mode, caught as a drift.
    database.seed(`researchEnrichmentProjection/${UIDS.sparg0}/user-vod-02`, {
      matchKey: 'user-vod-02',
      targetSetId: targetSetIdFor('sparg0', 0),
      projectedVodUrl: 'https://youtu.be/user-entered-2',
      vodObservationId: 'obs-sparg0-0',
    });
    const receipt = await audit(database, { baseline: recorded.baseline });
    expectPerturbed(receipt, 'sparg0-vod-preservation', 'protected-vod-count-mismatch');
    expect(codesOf(receipt, 'sparg0-vod-preservation')).toContain('digest-drift');
  });
});

// ---------------------------------------------------------------------------
// Assertion 8 — registry preservation.
// ---------------------------------------------------------------------------

describe('assertion 8: registry-preservation', () => {
  it('passes an unchanged compare', async () => {
    const recorded = await audit(makeDatabase());
    const compared = await audit(makeDatabase(), { baseline: recorded.baseline });
    expect(assertionOf(compared, 'registry-preservation').ok).toBe(true);
  });

  it('fails when a foreign row VALUE is rewritten (same key, same count)', async () => {
    const recorded = await audit(makeDatabase());
    const database = makeDatabase();
    database.seed(`tournamentEntries/${UIDS.hbox}/manual-hbox-a/setsPlayed`, 99);
    const receipt = await audit(database, { baseline: recorded.baseline });
    expectPerturbed(receipt, 'registry-preservation', 'digest-drift');
    expect(assertionOf(receipt, 'registry-preservation').findings[0]!.detail).toContain(
      'a stored value changed',
    );
  });

  it('fails when one foreign row is SWAPPED for another — proving preservedForeignCount alone is insufficient', async () => {
    const recorded = await audit(makeDatabase());
    const database = makeDatabase();
    const entries = (database.dump().tournamentEntries as Record<string, Record<string, unknown>>)[
      UIDS.mkleo
    ]!;
    delete entries['manual-mkleo-a'];
    entries['manual-mkleo-c'] = foreignRegistryRow('mkleo manual A');
    const receipt = await audit(database, { baseline: recorded.baseline });
    // The foreign COUNT is unchanged; only the digest can see this.
    expect(receipt.observed[1]!.tournamentEntriesForeign).toBe(
      recorded.observed[1]!.tournamentEntriesForeign,
    );
    expectPerturbed(receipt, 'registry-preservation', 'digest-drift');
  });

  it('ignores witness-owned rows: rewriting one is the projector doing its job', async () => {
    const recorded = await audit(makeDatabase());
    const database = makeDatabase();
    database.seed(`tournamentEntries/${UIDS.sparg0}/histimport:sparg0-1/playedSetCount`, 42);
    const receipt = await audit(database, { baseline: recorded.baseline });
    expect(assertionOf(receipt, 'registry-preservation').ok).toBe(true);
    expect(receipt.ok).toBe(true);
  });

  it('fails a compare whose baseline was recorded for different uids or a different contract version', async () => {
    const recorded = await audit(makeDatabase());
    const wrongUids = await audit(makeDatabase(), {
      baseline: {
        ...recorded.baseline,
        targetUids: { ...recorded.baseline.targetUids, izaw: 'some-other-uid' },
      },
    });
    expect(codesOf(wrongUids, 'registry-preservation')).toContain('baseline-uid-mismatch');
    expect(codesOf(wrongUids, 'sparg0-vod-preservation')).toContain('baseline-uid-mismatch');
    expect(wrongUids.ok).toBe(false);

    const wrongVersion = await audit(makeDatabase(), {
      baseline: { ...recorded.baseline, expectationTableVersion: '0.0.0-stale' },
    });
    expect(codesOf(wrongVersion, 'registry-preservation')).toContain(
      'baseline-table-version-mismatch',
    );
    expect(wrongVersion.ok).toBe(false);
  });

  it('parseGate6Baseline throws rather than silently degrading to record mode', () => {
    expect(() => parseGate6Baseline({ baselineVersion: 2 })).toThrow(/Invalid Gate 6 baseline/);
    expect(() => parseGate6Baseline(null)).toThrow(/Invalid Gate 6 baseline/);
  });
});

// ---------------------------------------------------------------------------
// Assertion 9 — IzAw's coaching ownership root.
// ---------------------------------------------------------------------------

describe('assertion 9: izaw-coaching-root', () => {
  it("fails when IzAw's tenant is also rooted under another coach's tree", async () => {
    const database = makeDatabase();
    database.seed(`coachClients/${OTHER_COACH_UID}/${IZAW_TENANT}`, {
      label: 'poached',
      createdAt: 1,
    });
    const receipt = await audit(database);
    expectPerturbed(receipt, 'izaw-coaching-root', 'coaching-root-foreign-owner');
    expect(assertionOf(receipt, 'izaw-coaching-root').findings[0]!.actual).toBe(OTHER_COACH_UID);
  });

  it("fails when IzAw's own coachClients root is missing for a tenant he is custodian of", async () => {
    const database = makeDatabase();
    const coachClients = database.dump().coachClients as Record<string, Record<string, unknown>>;
    delete coachClients[UIDS.izaw]![IZAW_TENANT];
    expectPerturbed(await audit(database), 'izaw-coaching-root', 'coaching-root-missing');
  });

  it("does not false-positive on another coach's unrelated tenant", async () => {
    const receipt = await audit(makeDatabase());
    expect(assertionOf(receipt, 'izaw-coaching-root').ok).toBe(true);
    expect(assertionOf(receipt, 'izaw-coaching-root').inspected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Assertion 10 — zero-trace trees.
// ---------------------------------------------------------------------------

describe('assertion 10: zero-trace-trees', () => {
  it.each([
    ['creditLedger', (uid: string) => `creditLedger/${uid}/entry-1`, { delta: -1 }],
    ['credits', (uid: string) => `credits/${uid}/balance`, 5],
    ['reportJobs', (uid: string) => `reportJobs/${uid}/job-1`, { status: 'running' }],
    ['reportJobsByStatus', (uid: string) => `reportJobsByStatus/running/${uid}/job-1`, true],
  ])('fails on a %s row for a demo uid', async (_tree, pathFor, value) => {
    const database = makeDatabase();
    database.seed((pathFor as (uid: string) => string)(UIDS.hbox), value);
    expectPerturbed(await audit(database), 'zero-trace-trees', 'zero-trace-violation');
  });

  it('fails on a bearer token minted for a demo uid', async () => {
    const database = makeDatabase();
    database.seed('shareTokens/demo-token', {
      shareId: 's2',
      ownerUid: UIDS.sparg0,
      permissions: 'view',
    });
    const receipt = await audit(database);
    expectPerturbed(receipt, 'zero-trace-trees', 'zero-trace-violation');
    expect(assertionOf(receipt, 'zero-trace-trees').findings[0]!.workspace).toBe('sparg0');
  });

  it('fails on an eventLedger row referencing a demo uid, and on its paired outbox entry', async () => {
    const database = makeDatabase();
    database.seed('eventLedger/2026-01-02/evt9', {
      eventId: 'e9',
      eventName: 'coaching_mode_enabled',
      schemaVersion: 1,
      occurredAt: 1,
      receivedAt: 1,
      actorKind: 'user',
      actorId: UIDS.izaw,
      sessionId: 's9',
      source: 'api',
      causationId: 'c9',
      consentState: 'granted',
      payload: {},
    });
    database.seed('outboxPending/2026-01-02/evt9', { attempt: 0 });
    const receipt = await audit(database);
    expectPerturbed(receipt, 'zero-trace-trees', 'zero-trace-violation');
    const paths = assertionOf(receipt, 'zero-trace-trees').findings.map((f) => f.path);
    expect(paths).toContain('eventLedger/2026-01-02/evt9');
    expect(paths).toContain('outboxPending/2026-01-02/evt9');
  });

  it('fails on an eventDedup causation id carrying a demo uid', async () => {
    const database = makeDatabase();
    database.seed(`eventDedup/prep_brief_activated/1/${UIDS.mkleo}:entry-7`, true);
    expectPerturbed(await audit(database), 'zero-trace-trees', 'zero-trace-violation');
  });

  it('leaves the unrelated-uid positive-control rows alone', async () => {
    const receipt = await audit(makeDatabase());
    expect(assertionOf(receipt, 'zero-trace-trees').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Assertion 11 — witness observation references (tolerated by default).
// ---------------------------------------------------------------------------

describe('assertion 11: witness-observation-references', () => {
  it('reports a dangling reference but tolerates it by default, matching the shipped applier contract', async () => {
    const database = makeDatabase();
    database.seed(
      `researchEnrichmentProjection/${UIDS.mkleo}/${matchRowKey(targetSetIdFor('mkleo', 2), 3)}/stageObservationId`,
      'obs-removed-by-supersede',
    );
    const receipt = await audit(database);
    const assertion = assertionOf(receipt, 'witness-observation-references');
    expect(assertion.findings.map((f) => f.code)).toContain(
      'witness-dangling-observation-reference',
    );
    expect(assertion.tolerated).toBe(true);
    expect(assertion.ok).toBe(true);
    expect(receipt.ok).toBe(true);
    expect(receipt.findingCount).toBe(0);
  });

  it('fails the same tree under --strict-witness-observation-refs', async () => {
    const database = makeDatabase();
    database.seed(
      `researchEnrichmentProjection/${UIDS.mkleo}/${matchRowKey(targetSetIdFor('mkleo', 2), 3)}/stageObservationId`,
      'obs-removed-by-supersede',
    );
    const receipt = await audit(database, { strict: true });
    expectPerturbed(
      receipt,
      'witness-observation-references',
      'witness-dangling-observation-reference',
    );
    expect(assertionOf(receipt, 'witness-observation-references').tolerated).toBe(false);
    expect(receipt.strictWitnessObservationRefs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The contract itself.
// ---------------------------------------------------------------------------

describe('the expectation table is the contract', () => {
  it('pins the owner-supplied Gate 6 figures in committed source, not in CLI parameters', () => {
    expect(GATE6_EXPECTATIONS).toEqual({
      hbox: {
        label: 'Hungrybox',
        matches: 8582,
        observations: 8766,
        receipts: 0,
        attachments: 0,
        characterWitnesses: 0,
        stockWitnesses: 0,
      },
      mkleo: {
        label: 'MkLeo',
        matches: 4568,
        observations: 9367,
        receipts: null,
        attachments: 57,
        characterWitnesses: 120,
        stockWitnesses: 70,
      },
      sparg0: {
        label: 'Sparg0',
        matches: 8378,
        observations: 10335,
        receipts: null,
        attachments: 68,
        characterWitnesses: 130,
        stockWitnesses: 76,
      },
      izaw: {
        label: 'IzAw',
        matches: 237,
        observations: 0,
        receipts: 0,
        attachments: 0,
        characterWitnesses: 0,
        stockWitnesses: 0,
      },
    });
    expect(GATE6_SPARG0_USER_OWNED_VOD_ROWS).toBe(13);
  });
});

import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
  TOURNAMENT_REGISTRY_ORIGIN,
  TOURNAMENT_REGISTRY_WITNESS_PREFIX,
  tournamentRegistryRowSchema,
  type TournamentRegistryRow,
} from '@smash-tracker/shared';
import { canonicalDigest } from '../src/research/registry/canonical.js';
import {
  computeForeignRowDigest,
  REGISTRY_FOREIGN_DIGEST_VERSION,
  type ForeignRowDigest,
} from '../src/research/registry/foreignDigest.js';
import {
  createRegistryReceipt,
  type RegistryCountSnapshot,
  type RegistryReceipt,
  type RegistryReceiptBody,
} from '../src/research/registry/receipt.js';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import {
  createRegistryManifest,
  computeRegistryRowSetHash,
  REGISTRY_MANIFEST_FORMAT_VERSION,
  type RegistryManifest,
} from './registryManifestArtifact.js';
import {
  canonicalize,
  captureGate6TraceSnapshot,
  createGate6RejectedOperationProbe,
  gate6WindowDayShards,
  GATE6_ASSERTION_IDS,
  GATE6_EXPECTATION_TABLE_VERSION,
  GATE6_ORIGIN_BOUND_RESPONSES,
  GATE6_REFUSED_OPERATION_EXPECTED_STATUS,
  GATE6_REJECTED_OPERATION_PROBE_FORMAT_VERSION,
  GATE6_EXPECTATIONS,
  GATE6_SPARG0_FROZEN_MANUAL_VOD_ROWS,
  GATE6_SPARG0_FROZEN_PROVIDER_VOD_DIGEST,
  GATE6_SPARG0_FROZEN_PROVIDER_VOD_ROWS,
  GATE6_TRACE_SNAPSHOT_VERSION,
  GATE6_UID_TRACE_SURFACES,
  GATE6_WORKSPACE_KEYS,
  parseGate6Baseline,
  runGate6Audit,
  type Gate6AssertionId,
  type Gate6AuditReceipt,
  type Gate6Baseline,
  type Gate6ProbeEnvironment,
  type Gate6RegistryManifestInput,
  type Gate6RegistryReceiptInput,
  type Gate6RejectedOperationProbeBody,
  type Gate6RejectedOperationProbeInput,
  type Gate6TraceSnapshot,
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

// At least 20 characters each: the registry manifest's own `uidSchema`
// enforces that bound, and assertion 12 now parses a real sealed manifest.
const UIDS: Gate6UidMap = {
  hbox: 'gate6-hbox-uid-000001',
  mkleo: 'gate6-mkleo-uid-00001',
  sparg0: 'gate6-sparg0-uid-0001',
  izaw: 'gate6-izaw-uid-000001',
};
const NOW_MS = 1_800_000_000_000;
const UNRELATED_UID = 'gate6-unrelated-uid';
const IZAW_TENANT = 'gate6-izaw-tenant';
const OTHER_COACH_UID = 'gate6-other-coach-uid';
const OTHER_COACH_TENANT = 'gate6-other-coach-tenant';

const PARSER_VERSION = 'bracket-match2@3';
const RESOLVER_VERSION = 'resolver@1';
const TEST_PROVIDER_VOD_ROWS = Array.from(
  { length: GATE6_SPARG0_FROZEN_PROVIDER_VOD_ROWS },
  (_, offset) => {
    const index = offset + 1;
    return {
      key: `sgg-provider-vod-set-${index}-g1`,
      payload: `https://youtu.be/provider-${index}`,
    };
  },
).sort((left, right) => left.key.localeCompare(right.key));
const TEST_PROVIDER_VOD_DIGEST = createHash('sha256')
  .update(canonicalize(TEST_PROVIDER_VOD_ROWS))
  .digest('hex');

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
    games: [{ ordinal: 1, rawStage: 'Battlefield', canonicalStageId: 31 }],
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

/**
 * A generated registry row. It must be a FULLY VALID
 * `tournamentRegistryRowSchema` value, because assertion 12 now recomputes
 * `computeRegistryRowSetHash` over the live rows — a fixture that only looked
 * owned would exercise the unparseable branch instead of the attestation.
 */
function ownedRegistryRow(eventId: string): Record<string, unknown> {
  return {
    entryId: `histimport:${eventId}`,
    origin: TOURNAMENT_REGISTRY_ORIGIN,
    provider: 'startgg',
    registryWitness: `${TOURNAMENT_REGISTRY_WITNESS_PREFIX}${eventId}`,
    startggEventId: eventId,
    eventName: 'Ultimate Singles',
    playedSetCount: 4,
    provenance: {
      source: 'research-import',
      importedAtMs: NOW_MS - 100_000,
      asOfMs: NOW_MS - 90_000,
    },
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

/**
 * The UTC day shard the fixture's telemetry lives in — derived from `NOW_MS`
 * through the SAME helper the audit uses, so the probe windows below address
 * the shard the fixture actually wrote to.
 */
const DEMO_TELEMETRY_DAY = gate6WindowDayShards(NOW_MS, NOW_MS)[0]!;

/** One canonical `eventLedger` envelope, as `events/ledger.ts` would have written it. */
function ledgerRow(
  actorId: string,
  eventName: string,
  causationId: string,
): Record<string, unknown> {
  return {
    eventId: `evt-${causationId}`,
    eventName,
    schemaVersion: 1,
    occurredAt: NOW_MS - 10_000,
    receivedAt: NOW_MS - 10_000,
    actorKind: 'user',
    actorId,
    sessionId: 's1',
    source: 'api',
    causationId,
    consentState: 'granted',
    payload: {},
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

/**
 * MkLeo's LAST attached index, DERIVED from the expectation table — never a
 * literal. The 2026-08-17 repair moved the reviewed attachment count (57 ->
 * 56, the revoked-only aa0baa79… authorization), and the perturbation tests
 * that used a hardcoded `56` as "the last attached set" silently went VACUOUS
 * the moment that constant moved: they deleted witnesses for a target set the
 * builder no longer seeds, perturbed nothing, and watched a green audit.
 * Deriving the index (and asserting below that it exists and sits beyond both
 * witness populations) makes that drift class structurally impossible.
 */
const MKLEO_LAST_ATTACHED_INDEX = GATE6_EXPECTATIONS.mkleo.attachments - 1;

function targetSetIdFor(workspace: Gate6WorkspaceKey, index: number): string {
  return `set-${workspace}-${index}`;
}

function matchRowKey(targetSetId: string, ordinal: number): string {
  return `sgg-${targetSetId}-g${ordinal}`;
}

interface BuiltWorkspace {
  matches: Record<string, unknown>;
  sourceSets: Record<string, unknown>;
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
    sourceSets: {},
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
    built.sourceSets[targetSetId] = {
      providerSetId: targetSetId,
      projectedMatchKeys: Array.from({ length: WITNESS_ORDINALS_PER_SET }, (_, ordinal) =>
        matchRowKey(targetSetId, ordinal + 1),
      ),
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

  // Sparg0's production-frozen VOD census: 89 values reproduced by the
  // lossless start.gg source and zero manual residual. Enrichment-owned rows
  // remain alongside them to exercise all three ownership classifiers.
  if (workspace === 'sparg0') {
    for (let index = 0; index < 5; index += 1) {
      const matchKey = matchRowKey(targetSetIdFor('sparg0', index), 1);
      const projectedVodUrl = `https://youtu.be/source-owned-${index}`;
      (built.matches[matchKey] as Record<string, unknown>).vodUrl = projectedVodUrl;
      (built.witnesses[matchKey] as Record<string, unknown>).projectedVodUrl = projectedVodUrl;
      (built.witnesses[matchKey] as Record<string, unknown>).vodObservationId =
        `obs-sparg0-${index}`;
    }
    // Provider-owned VOD rows have no enrichment witness. Their ownership is
    // proven by the lossless source set's `vodUrl` + `projectedMatchKeys`, so
    // they must not inflate the manual population merely because both kinds
    // lack a Liquipedia witness.
    for (let index = 1; index <= GATE6_SPARG0_FROZEN_PROVIDER_VOD_ROWS; index += 1) {
      const setId = `provider-vod-set-${index}`;
      const key = matchRowKey(setId, 1);
      const vodUrl = `https://youtu.be/provider-${index}`;
      built.matches[key] = {
        externalId: `sgg:${setId}:g1`,
        fighter_id: 1,
        opponent_id: 8,
        source: 'startgg',
        time: 1,
        win: true,
        vodUrl,
      };
      built.sourceSets[setId] = { providerSetId: setId, projectedMatchKeys: [key], vodUrl };
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
    researchSource: {},
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
    // THE HEALTHY-SYSTEM CONTROL (hard gate #4, B5). Every row below is
    // LEGITIMATE and every one of them would have FAILED the old lifetime-
    // absence assertion:
    //  - `signup_completed` for a demo uid: RTEN-04 suppresses research-context
    //    telemetry, not an account's ordinary product events.
    //  - a SUCCEEDED `reportJobs` record for a demo uid: a free demo report is
    //    supposed to leave exactly that.
    // The unrelated-uid rows sit alongside them so the operation-scoped
    // attribution is exercised against a non-empty population of other
    // people's traffic rather than against an empty tree.
    eventLedger: {
      [DEMO_TELEMETRY_DAY]: {
        evtDemo: ledgerRow(UIDS.hbox, 'signup_completed', `${UIDS.hbox}:signup`),
        evtOther: ledgerRow(UNRELATED_UID, 'signup_completed', `${UNRELATED_UID}:c1`),
      },
    },
    outboxPending: {
      [DEMO_TELEMETRY_DAY]: { evtDemo: { attempt: 0 }, evtOther: { attempt: 0 } },
    },
    eventDedup: {
      signup_completed: {
        1: { [`${UIDS.hbox}:signup`]: true, [`${UNRELATED_UID}:c1`]: true },
      },
    },
    shareTokens: { tok1: { shareId: 's1', ownerUid: UNRELATED_UID, permissions: 'view' } },
    sharesByUser: { [UNRELATED_UID]: { share1: true } },
    creditLedger: { [UNRELATED_UID]: { l1: { delta: -1 } } },
    credits: { [UNRELATED_UID]: { balance: 5 }, [UIDS.mkleo]: { balance: 0 } },
    reportJobs: {
      [UNRELATED_UID]: { j1: { status: 'complete' } },
      // The intentional artifact of a SUCCESSFUL free demo report.
      [UIDS.sparg0]: { demoJob: { status: 'succeeded', reportKind: 'demo' } },
    },
    reportJobsByStatus: { running: { [UNRELATED_UID]: { j1: true } } },
  };

  for (const workspace of GATE6_WORKSPACE_KEYS) {
    const uid = UIDS[workspace];
    const built = buildWorkspace(workspace);
    (tree.matches as Record<string, unknown>)[uid] = built.matches;
    (tree.researchSource as Record<string, unknown>)[uid] = { sets: built.sourceSets };
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
  overrides: {
    baseline?: Gate6Baseline | null;
    strict?: boolean;
    registryReceipts?: Gate6RegistryReceiptInput[] | null;
    registryManifests?: Gate6RegistryManifestInput[] | null;
    requireRegistryReceipts?: boolean;
    rejectedOperationProbes?: Gate6RejectedOperationProbeInput[] | null;
    requireRejectedOperationProbes?: boolean;
    expectedDatabaseHost?: string | null;
    nowMs?: number;
    frozenSparg0VodCensus?: {
      providerCount: number;
      providerDigest: string;
      manualCount: number;
    };
  } = {},
): Promise<Gate6AuditReceipt> {
  return runGate6Audit(asDatabase(database), {
    uids: UIDS,
    nowMs: overrides.nowMs ?? NOW_MS,
    baseline: overrides.baseline ?? null,
    strictWitnessObservationRefs: overrides.strict === true,
    registryReceipts: overrides.registryReceipts ?? null,
    // A receipt is only attestable against the manifest it names, so the
    // default supplies the matching manifests whenever receipts are supplied.
    registryManifests:
      overrides.registryManifests ?? (overrides.registryReceipts ? allManifestInputs() : null),
    requireRegistryReceipts: overrides.requireRegistryReceipts === true,
    rejectedOperationProbes: overrides.rejectedOperationProbes ?? null,
    requireRejectedOperationProbes: overrides.requireRejectedOperationProbes === true,
    frozenSparg0VodCensus: overrides.frozenSparg0VodCensus ?? {
      providerCount: GATE6_SPARG0_FROZEN_PROVIDER_VOD_ROWS,
      providerDigest: TEST_PROVIDER_VOD_DIGEST,
      manualCount: GATE6_SPARG0_FROZEN_MANUAL_VOD_ROWS,
    },
    // Default to the host the receipt fixtures seal against, so the
    // host cross-check is EXERCISED in the pass case rather than skipped.
    expectedDatabaseHost:
      overrides.expectedDatabaseHost === undefined
        ? LIVE_DATABASE_HOST
        : overrides.expectedDatabaseHost,
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
  expect(assertionOf(receipt, id).status).toBe('failed');
  expect(codesOf(receipt, id)).toContain(code);
  const allowedRed = new Set<Gate6AssertionId>([id, ...alsoRed]);
  for (const assertion of receipt.assertions) {
    if (!assertion.ok) {
      expect(allowedRed).toContain(assertion.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Registry attestation fixtures (assertion 12).
// ---------------------------------------------------------------------------

const LIVE_DATABASE_HOST = 'gate6-test-db.firebaseio.com';
const MANIFEST_GENERATED_AT_MS = NOW_MS - 1_000_000;

function countSnapshot(
  foreignRows: number,
  overrides: Partial<RegistryCountSnapshot> = {},
): RegistryCountSnapshot {
  return {
    entryChildren: foreignRows + 2,
    registryOwnedRows: 2,
    foreignRows,
    sourceSets: 10,
    corruptSourceRecords: 0,
    derivedRows: 2,
    creates: 0,
    updates: 0,
    unchanged: 2,
    collisions: 0,
    orphanRemovals: 0,
    ...overrides,
  };
}

/** The live foreign digest for a workspace, taken from the correct tree. */
function liveForeignDigest(workspace: Gate6WorkspaceKey): ForeignRowDigest {
  const entries = (CORRECT_TREE.tournamentEntries as Record<string, Record<string, unknown>>)[
    UIDS[workspace]
  ]!;
  return computeForeignRowDigest(UIDS[workspace], entries);
}

/**
 * The LIVE generated-row hash for a workspace, recomputed from the fixture
 * exactly the way assertion 12 recomputes it from the database. This is what
 * makes the attestation tests meaningful: perturb a `histimport:` row and the
 * receipt's sealed hash no longer describes live state.
 */
function liveRegistryRowSetHash(workspace: Gate6WorkspaceKey): string {
  const entries = (CORRECT_TREE.tournamentEntries as Record<string, Record<string, unknown>>)[
    UIDS[workspace]
  ]!;
  const rows: TournamentRegistryRow[] = [];
  for (const value of Object.values(entries)) {
    const parsed = tournamentRegistryRowSchema.safeParse(value);
    if (parsed.success) {
      rows.push(parsed.data);
    }
  }
  return computeRegistryRowSetHash(UIDS[workspace], rows);
}

/**
 * A reviewed manifest for one workspace, sealed for real. Its per-account
 * `rowSetHash` is the LIVE hash, which is what a settled account's reviewed
 * manifest necessarily carries.
 */
function sealedManifest(
  workspace: Gate6WorkspaceKey,
  overrides: { generatedAtMs?: number; databaseHost?: string; rowSetHash?: string } = {},
): RegistryManifest {
  const entries = (CORRECT_TREE.tournamentEntries as Record<string, Record<string, unknown>>)[
    UIDS[workspace]
  ]!;
  const rows: TournamentRegistryRow[] = [];
  for (const value of Object.values(entries)) {
    const parsed = tournamentRegistryRowSchema.safeParse(value);
    if (parsed.success) {
      rows.push(parsed.data);
    }
  }
  const foreign = liveForeignDigest(workspace);
  const rowSetHash = overrides.rowSetHash ?? computeRegistryRowSetHash(UIDS[workspace], rows);
  return createRegistryManifest({
    formatVersion: REGISTRY_MANIFEST_FORMAT_VERSION,
    generatedAtMs: overrides.generatedAtMs ?? MANIFEST_GENERATED_AT_MS,
    databaseHost: overrides.databaseHost ?? LIVE_DATABASE_HOST,
    targetUids: UIDS,
    scope: [workspace],
    writesPerformed: 0,
    accounts: {
      [workspace]: {
        label: GATE6_EXPECTATIONS[workspace].label,
        uid: UIDS[workspace],
        sourceSetCount: 10,
        corruptSourceRecords: 0,
        skippedNoEventId: 0,
        skippedUnsafeEventId: 0,
        skippedExcludedClassification: 0,
        derivedRowCount: rows.length,
        creates: [],
        updates: [],
        unchanged: rows.map((row) => row.entryId).sort(),
        collisions: [],
        orphanRemovals: [],
        preservedForeignCount: foreign.count,
        preservedForeignKeys: foreign.keys,
        foreignDigest: foreign.digest,
        rows,
        rowSetHash,
      },
    },
  });
}

function manifestInput(
  workspace: Gate6WorkspaceKey,
  overrides: Parameters<typeof sealedManifest>[1] = {},
): Gate6RegistryManifestInput {
  return {
    path: `./registry-manifest.${workspace}.json`,
    raw: sealedManifest(workspace, overrides),
  };
}

function allManifestInputs(): Gate6RegistryManifestInput[] {
  return GATE6_WORKSPACE_KEYS.map((workspace) => manifestInput(workspace));
}

/**
 * A genuinely sealed operator receipt — built through `createRegistryReceipt`
 * so its `contentHash` is real. Perturbation tests override members and
 * either re-seal (to test a semantic refusal) or tamper post-seal (to test the
 * hash check itself).
 *
 * It is a COMPARE receipt: since hard gate #4 an apply receipt no longer
 * satisfies the final attestation, because an apply observes its own
 * post-state while compare is an independent later read.
 */
function sealedReceipt(
  workspace: Gate6WorkspaceKey,
  overrides: Partial<RegistryReceiptBody> = {},
): RegistryReceipt {
  const digest = liveForeignDigest(workspace);
  const rowSetHash = liveRegistryRowSetHash(workspace);
  const body: RegistryReceiptBody = {
    formatVersion: 1,
    command: 'compare',
    workspace,
    label: GATE6_EXPECTATIONS[workspace].label,
    databaseHost: LIVE_DATABASE_HOST,
    uid: UIDS[workspace],
    manifestContentHash: sealedManifest(workspace).contentHash,
    manifestGeneratedAtMs: MANIFEST_GENERATED_AT_MS,
    reviewedRowSetHash: rowSetHash,
    observedRowSetHash: rowSetHash,
    startedAtMs: NOW_MS - 500_000,
    finishedAtMs: NOW_MS - 400_000,
    status: 'ok',
    failedInvariants: [],
    before: countSnapshot(digest.count),
    after: countSnapshot(digest.count),
    foreignDigestBefore: digest,
    foreignDigestAfter: digest,
    foreignDigestStable: true,
    writes: null,
    ...overrides,
  };
  return createRegistryReceipt(body);
}

function receiptInput(
  workspace: Gate6WorkspaceKey,
  overrides: Partial<RegistryReceiptBody> = {},
): Gate6RegistryReceiptInput {
  return { path: `./receipt-${workspace}.json`, raw: sealedReceipt(workspace, overrides) };
}

/** All four accounts, correctly sealed — the assertion-12 pass case. */
function allReceipts(): Gate6RegistryReceiptInput[] {
  return GATE6_WORKSPACE_KEYS.map((workspace) => receiptInput(workspace));
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

  it('the derived last-attached MkLeo index exists in the corpus and sits beyond both witness populations', () => {
    // Anti-vacuity for every perturbation below that targets the last
    // attached set: the set must EXIST (so deleting its witnesses perturbs
    // something) and be the true boundary (so index+1 is unseeded), and its
    // witnesses must carry no character/stock claims (the "beyond the
    // populations" premise several tests rely on).
    const built = buildWorkspace('mkleo');
    expect(built.attachments[targetSetIdFor('mkleo', MKLEO_LAST_ATTACHED_INDEX)]).toBeDefined();
    expect(
      built.attachments[targetSetIdFor('mkleo', MKLEO_LAST_ATTACHED_INDEX + 1)],
    ).toBeUndefined();
    expect(MKLEO_LAST_ATTACHED_INDEX * WITNESS_ORDINALS_PER_SET).toBeGreaterThanOrEqual(
      GATE6_EXPECTATIONS.mkleo.characterWitnesses,
    );
    expect(MKLEO_LAST_ATTACHED_INDEX * WITNESS_ORDINALS_PER_SET).toBeGreaterThanOrEqual(
      GATE6_EXPECTATIONS.mkleo.stockWitnesses,
    );
  });

  it('carries the LEGITIMATE demo telemetry the old lifetime-absence assertion would have failed', async () => {
    const tree = makeDatabase().dump() as Record<string, Record<string, unknown>>;
    // Ordinary product telemetry for a demo uid (permitted: RTEN-04 suppresses
    // research-context events, not these) …
    expect(
      (tree.eventLedger as Record<string, Record<string, unknown>>)[DEMO_TELEMETRY_DAY]!.evtDemo,
    ).toBeDefined();
    expect((tree.eventDedup as Record<string, Record<string, unknown>>).signup_completed).toEqual(
      expect.objectContaining({ 1: expect.objectContaining({ [`${UIDS.hbox}:signup`]: true }) }),
    );
    // … and the intentional artifact of a SUCCESSFUL free demo report.
    expect((tree.reportJobs as Record<string, unknown>)[UIDS.sparg0]).toBeDefined();
  });

  it('separates manual, provider, and enrichment-owned Sparg0 VODs by structural evidence', async () => {
    const receipt = await audit(makeDatabase());
    expect(receipt.baseline.sparg0ManualVod.count).toBe(GATE6_SPARG0_FROZEN_MANUAL_VOD_ROWS);
    expect(receipt.baseline.sparg0ManualVod.keys).toEqual([]);
    expect(receipt.baseline.sparg0ProviderVod.count).toBe(GATE6_SPARG0_FROZEN_PROVIDER_VOD_ROWS);
    expect(receipt.baseline.sparg0ProviderVod.keys[0]).toBe('sgg-provider-vod-set-1-g1');
    expect(receipt.baseline.sparg0ProviderVod.keys).not.toContain(
      matchRowKey(targetSetIdFor('sparg0', 0), 1),
    );
  });
});

// ---------------------------------------------------------------------------
// The pass case and the receipt contract.
// ---------------------------------------------------------------------------

describe('a fully-correct tree passes', () => {
  it('reports ok with zero findings across every assertion', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      registryReceipts: allReceipts(),
      rejectedOperationProbes: await allProbes(database),
    });
    expect(receipt.findingCount).toBe(0);
    expect(receipt.ok).toBe(true);
    expect(receipt.skippedCount).toBe(0);
    for (const assertion of receipt.assertions) {
      expect(assertion.findings).toEqual([]);
      expect(assertion.ok).toBe(true);
      expect(assertion.status).toBe('passed');
      expect(assertion.skipReason).toBeNull();
    }
  });

  it('emits a stable receipt shape: fixed top-level keys, every assertion id, in order', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      registryReceipts: allReceipts(),
      rejectedOperationProbes: await allProbes(database),
    });
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
        'registryManifests',
        'registryReceipts',
        'rejectedOperationProbes',
        'requireRegistryReceipts',
        'requireRejectedOperationProbes',
        'skippedCount',
        'strictWitnessObservationRefs',
        'targetUids',
      ].sort(),
    );
    expect(receipt.receiptVersion).toBe(6);
    expect(receipt.expectationTableVersion).toBe(GATE6_EXPECTATION_TABLE_VERSION);
    expect(receipt.baselineMode).toBe('record');
    expect(receipt.assertions.map((assertion) => assertion.id)).toEqual([...GATE6_ASSERTION_IDS]);
    for (const assertion of receipt.assertions) {
      expect(Object.keys(assertion).sort()).toEqual([
        'findings',
        'id',
        'inspected',
        'ok',
        'skipReason',
        'status',
        'title',
        'tolerated',
      ]);
    }
    for (const row of receipt.registryReceipts) {
      expect(Object.keys(row).sort()).toEqual([
        'command',
        'databaseHost',
        'databaseHostChecked',
        'foreignDigestAfter',
        'path',
        'status',
        'uid',
        'valid',
        'workspace',
      ]);
    }
    expect(receipt.observed.map((row) => row.workspace)).toEqual([...GATE6_WORKSPACE_KEYS]);
    expect(receipt.baseline.baselineVersion).toBe(3);
    // The two digest laws are visibly distinguishable in the receipt: the
    // registry half carries the shared law's `version`/`uid`; the VOD half
    // (the local law) carries neither.
    for (const workspace of GATE6_WORKSPACE_KEYS) {
      expect(Object.keys(receipt.baseline.registryForeign[workspace]).sort()).toEqual([
        'count',
        'digest',
        'keys',
        'uid',
        'version',
      ]);
      expect(receipt.baseline.registryForeign[workspace].uid).toBe(UIDS[workspace]);
      expect(receipt.baseline.registryForeign[workspace].version).toBe(
        REGISTRY_FOREIGN_DIGEST_VERSION,
      );
    }
    expect(Object.keys(receipt.baseline.sparg0ManualVod).sort()).toEqual([
      'count',
      'digest',
      'keys',
    ]);
    expect(Object.keys(receipt.baseline.sparg0ProviderVod).sort()).toEqual([
      'count',
      'digest',
      'keys',
    ]);
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
    // `expected-counts` is an ALLOWED second red here: once the owner supplied
    // the MkLeo/Sparg0 receipt totals (table 30.3-gate6.2), a missing receipt
    // is caught twice — by the reference walk AND by the pinned count. Two
    // independent detections of one fact is the oracle getting stricter, not
    // a leak; the named finding below is still the assertion under test.
    expectPerturbed(await audit(database), 'attachment-integrity', 'attachment-dangling-receipt', [
      'expected-counts',
    ]);
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
      delete witnesses[matchRowKey(targetSetIdFor('mkleo', MKLEO_LAST_ATTACHED_INDEX), ordinal)];
    }
    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-missing-projection-witness',
      ['expected-counts'],
    );
  });

  it('does not demand a witness from a resolved observation with no projectable evidence', async () => {
    const database = makeDatabase();
    const index = MKLEO_LAST_ATTACHED_INDEX; // beyond MkLeo's character/stock witness populations
    const observationId = `obs-mkleo-${index}`;
    const targetSetId = targetSetIdFor('mkleo', index);
    const observations = (
      database.dump().researchEnrichmentObservations as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    delete (observations[observationId] as Record<string, unknown>).games;
    const witnesses = (
      database.dump().researchEnrichmentProjection as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    for (let ordinal = 1; ordinal <= WITNESS_ORDINALS_PER_SET; ordinal += 1) {
      delete witnesses[matchRowKey(targetSetId, ordinal)];
    }

    const receipt = await audit(database);
    expect(codesOf(receipt, 'attachment-integrity')).not.toContain(
      'attachment-missing-projection-witness',
    );
    expect(receipt.ok).toBe(true);
  });

  it('does not demand a witness when a pre-existing provider/user VOD closes the fill-empty slot', async () => {
    const database = makeDatabase();
    const index = MKLEO_LAST_ATTACHED_INDEX;
    const observationId = `obs-mkleo-${index}`;
    const targetSetId = targetSetIdFor('mkleo', index);
    const observations = (
      database.dump().researchEnrichmentObservations as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    const observation = observations[observationId] as Record<string, unknown>;
    delete observation.games;
    observation.contentType = 'vod-reference';
    observation.vodUrl = 'https://youtu.be/liquipedia-candidate';
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.mkleo
    ]!;
    (matches[matchRowKey(targetSetId, 1)] as Record<string, unknown>).vodUrl =
      'https://youtu.be/provider-value';
    const witnesses = (
      database.dump().researchEnrichmentProjection as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    for (let ordinal = 1; ordinal <= WITNESS_ORDINALS_PER_SET; ordinal += 1) {
      delete witnesses[matchRowKey(targetSetId, ordinal)];
    }

    const receipt = await audit(database);
    expect(codesOf(receipt, 'attachment-integrity')).not.toContain(
      'attachment-missing-projection-witness',
    );
    expect(receipt.ok).toBe(true);
  });

  it('fails when a witness is deleted but the row still carries the exact Liquipedia VOD', async () => {
    const database = makeDatabase();
    const index = MKLEO_LAST_ATTACHED_INDEX;
    const observationId = `obs-mkleo-${index}`;
    const targetSetId = targetSetIdFor('mkleo', index);
    const vodUrl = 'https://youtu.be/liquipedia-projected';
    const observations = (
      database.dump().researchEnrichmentObservations as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    const observation = observations[observationId] as Record<string, unknown>;
    delete observation.games;
    observation.contentType = 'vod-reference';
    observation.vodUrl = vodUrl;
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.mkleo
    ]!;
    (matches[matchRowKey(targetSetId, 1)] as Record<string, unknown>).vodUrl = vodUrl;
    const witnesses = (
      database.dump().researchEnrichmentProjection as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    for (let ordinal = 1; ordinal <= WITNESS_ORDINALS_PER_SET; ordinal += 1) {
      delete witnesses[matchRowKey(targetSetId, ordinal)];
    }

    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-missing-projection-witness',
    );
  });

  it('accepts the same prefilled VOD when the lossless provider source independently proves it', async () => {
    const database = makeDatabase();
    const index = MKLEO_LAST_ATTACHED_INDEX;
    const observationId = `obs-mkleo-${index}`;
    const targetSetId = targetSetIdFor('mkleo', index);
    const matchKey = matchRowKey(targetSetId, 1);
    const vodUrl = 'https://youtu.be/provider-and-liquipedia';
    const observations = (
      database.dump().researchEnrichmentObservations as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    const observation = observations[observationId] as Record<string, unknown>;
    delete observation.games;
    observation.contentType = 'vod-reference';
    observation.vodUrl = vodUrl;
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.mkleo
    ]!;
    (matches[matchKey] as Record<string, unknown>).vodUrl = vodUrl;
    const sourceSets = (
      database.dump().researchSource as Record<
        string,
        { sets: Record<string, Record<string, unknown>> }
      >
    )[UIDS.mkleo]!.sets;
    sourceSets[targetSetId]!.vodUrl = vodUrl;
    const witnesses = (
      database.dump().researchEnrichmentProjection as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    for (let ordinal = 1; ordinal <= WITNESS_ORDINALS_PER_SET; ordinal += 1) {
      delete witnesses[matchRowKey(targetSetId, ordinal)];
    }

    const receipt = await audit(database);
    expect(codesOf(receipt, 'attachment-integrity')).not.toContain(
      'attachment-missing-projection-witness',
    );
    expect(receipt.ok).toBe(true);
  });

  it('requires a per-row witness for oriented raw character evidence', async () => {
    const database = makeDatabase();
    const index = MKLEO_LAST_ATTACHED_INDEX;
    const observationId = `obs-mkleo-${index}`;
    const targetSetId = targetSetIdFor('mkleo', index);
    const observations = (
      database.dump().researchEnrichmentObservations as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    const observation = observations[observationId] as Record<string, unknown>;
    observation.game = 'ultimate';
    observation.players = [{ rawTag: 'MkLeo' }, { rawTag: 'Tweek' }];
    observation.games = [{ ordinal: 1, rawChars: ['Joker', 'Diddy Kong'] }];
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.mkleo
    ]!;
    (matches[matchRowKey(targetSetId, 1)] as Record<string, unknown>).opponent = 'tweek';
    const witnesses = (
      database.dump().researchEnrichmentProjection as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    delete witnesses[matchRowKey(targetSetId, 1)];

    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-missing-projection-witness',
    );
  });

  it('fails when an attachment target is absent from the lossless source tree', async () => {
    const database = makeDatabase();
    const targetSetId = targetSetIdFor('mkleo', MKLEO_LAST_ATTACHED_INDEX);
    const sourceSets = (
      database.dump().researchSource as Record<
        string,
        { sets: Record<string, Record<string, unknown>> }
      >
    )[UIDS.mkleo]!.sets;
    delete sourceSets[targetSetId];
    expectPerturbed(
      await audit(database),
      'attachment-integrity',
      'attachment-dangling-source-set',
    );
  });

  it('allows a no-game attachment whose target has no match rows', async () => {
    const database = makeDatabase();
    const index = MKLEO_LAST_ATTACHED_INDEX;
    const observationId = `obs-mkleo-${index}`;
    const targetSetId = targetSetIdFor('mkleo', index);
    const observations = (
      database.dump().researchEnrichmentObservations as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    delete (observations[observationId] as Record<string, unknown>).games;
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.mkleo
    ]!;
    const witnesses = (
      database.dump().researchEnrichmentProjection as Record<string, Record<string, unknown>>
    )[UIDS.mkleo]!;
    for (let ordinal = 1; ordinal <= WITNESS_ORDINALS_PER_SET; ordinal += 1) {
      delete matches[matchRowKey(targetSetId, ordinal)];
      delete witnesses[matchRowKey(targetSetId, ordinal)];
      matches[`m-mkleo-no-game-replacement-${ordinal}`] = {
        fighter_id: 1,
        opponent_id: 8,
        time: 1,
      };
    }

    const receipt = await audit(database);
    expect(codesOf(receipt, 'attachment-integrity')).not.toContain(
      'attachment-dangling-target-set',
    );
    expect(receipt.ok).toBe(true);
  });

  it('fails when a receipt has no observation (the reverse direction)', async () => {
    const database = makeDatabase();
    database.seed(
      `researchEnrichmentReceipts/${UIDS.sparg0}/obs-ghost`,
      receiptRecord('obs-ghost', 'set-sparg0-1', 1234),
    );
    // Second allowed red for the same reason as the missing-receipt case: the
    // pinned receipt total (table 30.3-gate6.2) now also notices the extra row.
    expectPerturbed(await audit(database), 'attachment-integrity', 'receipt-dangling-observation', [
      'expected-counts',
    ]);
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

  it('pins the record-mode provider bytes, not merely the 89-row count', async () => {
    const receipt = await audit(makeDatabase(), {
      frozenSparg0VodCensus: {
        providerCount: GATE6_SPARG0_FROZEN_PROVIDER_VOD_ROWS,
        providerDigest: GATE6_SPARG0_FROZEN_PROVIDER_VOD_DIGEST,
        manualCount: GATE6_SPARG0_FROZEN_MANUAL_VOD_ROWS,
      },
    });
    // The synthetic corpus deliberately has 89 different URLs, so count-only
    // logic would false-green while the frozen byte digest must reject it.
    expectPerturbed(receipt, 'sparg0-vod-preservation', 'provider-vod-digest-mismatch');
  });

  it('classifies a nonempty provider-key difference as a manual fill-empty override, never missing provider data', async () => {
    const database = makeDatabase();
    const key = 'sgg-provider-vod-set-2-g1';
    database.seed(`matches/${UIDS.sparg0}/${key}/vodUrl`, 'https://youtu.be/manual-override');
    const receipt = await audit(database);
    expect(receipt.baseline.sparg0ManualVod.keys).toEqual([key]);
    expect(codesOf(receipt, 'sparg0-vod-preservation')).toContain('manual-vod-count-mismatch');
    expect(codesOf(receipt, 'sparg0-vod-preservation')).not.toContain('provider-vod-missing');
  });

  it('preserves a classified manual override byte-for-byte in compare mode', async () => {
    const before = makeDatabase();
    const key = 'sgg-provider-vod-set-2-g1';
    before.seed(`matches/${UIDS.sparg0}/${key}/vodUrl`, 'https://youtu.be/manual-override');
    const recorded = await audit(before);
    const after = makeDatabase();
    after.seed(`matches/${UIDS.sparg0}/${key}/vodUrl`, 'https://youtu.be/manual-overwritten');
    const receipt = await audit(after, { baseline: recorded.baseline });
    expectPerturbed(receipt, 'sparg0-vod-preservation', 'digest-drift');
    expect(receipt.baselineMode).toBe('compare');
  });

  it('fails on provider VOD loss even in record mode, using the lossless source set rather than a magic count', async () => {
    const database = makeDatabase();
    const key = 'sgg-provider-vod-set-2-g1';
    const matches = (database.dump().matches as Record<string, Record<string, unknown>>)[
      UIDS.sparg0
    ]!;
    delete (matches[key] as Record<string, unknown>).vodUrl;
    const receipt = await audit(database);
    expectPerturbed(receipt, 'sparg0-vod-preservation', 'provider-vod-missing');
    expect(receipt.baselineMode).toBe('record');
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
    // The wording is the SHARED helper's `describeForeignRowDigestDelta`, not
    // a local restatement of it.
    expect(assertionOf(receipt, 'registry-preservation').findings[0]!.detail).toContain(
      'their CONTENT changed',
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
    expect(() => parseGate6Baseline({ baselineVersion: 3 })).toThrow(/Invalid Gate 6 baseline/);
    expect(() => parseGate6Baseline(null)).toThrow(/Invalid Gate 6 baseline/);
  });

  it('REFUSES a baseline recorded under the OLD v1 registryForeign shape rather than degrading it', async () => {
    const recorded = await audit(makeDatabase());
    // Exactly what a pre-unification baseline file looked like: v1, and
    // registryForeign entries in the old local `{count,digest,keys}` shape —
    // digests computed under a different hashing law, with no `version`/`uid`.
    const legacyBaseline = {
      ...recorded.baseline,
      baselineVersion: 1,
      registryForeign: Object.fromEntries(
        GATE6_WORKSPACE_KEYS.map((workspace) => {
          const { count, digest, keys } = recorded.baseline.registryForeign[workspace];
          return [workspace, { count, digest, keys }];
        }),
      ),
    };
    expect(() => parseGate6Baseline(legacyBaseline)).toThrow(/Invalid Gate 6 baseline/);

    // And the shape alone is refused even if someone hand-edits the version
    // up: the entries still lack the shared law's `version`/`uid` members.
    expect(() => parseGate6Baseline({ ...legacyBaseline, baselineVersion: 3 })).toThrow(
      /Invalid Gate 6 baseline/,
    );
  });

  it('REFUSES the old v2 VOD-complement shape that conflated provider and manual rows', async () => {
    const recorded = await audit(makeDatabase());
    const legacyV2 = {
      baselineVersion: 2,
      expectationTableVersion: recorded.baseline.expectationTableVersion,
      recordedAtMs: recorded.baseline.recordedAtMs,
      targetUids: recorded.baseline.targetUids,
      sparg0UserOwnedVod: recorded.baseline.sparg0ManualVod,
      registryForeign: recorded.baseline.registryForeign,
    };
    expect(() => parseGate6Baseline(legacyV2)).toThrow(/Invalid Gate 6 baseline/);
  });

  it('reports a digest-rule version change as its own condition, never as unexplained content drift', async () => {
    const recorded = await audit(makeDatabase());
    const receipt = await audit(makeDatabase(), {
      baseline: {
        ...recorded.baseline,
        registryForeign: {
          ...recorded.baseline.registryForeign,
          hbox: { ...recorded.baseline.registryForeign.hbox, version: 99 },
        },
      },
    });
    expect(codesOf(receipt, 'registry-preservation')).toContain('foreign-digest-version-mismatch');
    expect(codesOf(receipt, 'registry-preservation')).not.toContain('digest-drift');
    expect(receipt.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The unified digest law — assertion 8 must be the SHARED registry helper,
// and assertion 7 must NOT be.
// ---------------------------------------------------------------------------

describe('the two digest laws are the right ones and stay distinct', () => {
  it("assertion 8's digest is byte-identical to computeForeignRowDigest over the same snapshot", async () => {
    const receipt = await audit(makeDatabase());
    const database = makeDatabase();
    for (const workspace of GATE6_WORKSPACE_KEYS) {
      const entries = (
        database.dump().tournamentEntries as Record<string, Record<string, unknown>>
      )[UIDS[workspace]]!;
      // Recomputed independently through the shared producer — if the audit
      // ever re-derives this law locally again, this equality breaks.
      expect(receipt.baseline.registryForeign[workspace]).toEqual(
        computeForeignRowDigest(UIDS[workspace], entries),
      );
    }
  });

  it('binds the uid INTO the registry hash, so identical foreign content on two accounts does not compare equal', async () => {
    const receipt = await audit(makeDatabase());
    // hbox and mkleo hold structurally parallel foreign rows; only the row
    // NAMES differ in the fixture, so make them literally identical first.
    const identical = {
      'manual-x': foreignRegistryRow('same'),
      'pgg-y': foreignRegistryRow('same too'),
    };
    const left = computeForeignRowDigest(UIDS.hbox, identical);
    const right = computeForeignRowDigest(UIDS.mkleo, identical);
    expect(left.keys).toEqual(right.keys);
    expect(left.count).toBe(right.count);
    expect(left.digest).not.toBe(right.digest);
    // The audit stores that uid-bound digest, not a uid-blind one.
    expect(receipt.baseline.registryForeign.hbox.uid).toBe(UIDS.hbox);
  });

  it('keeps assertion 7 on the local law: neither VOD digest carries a uid or registry version', async () => {
    const receipt = await audit(makeDatabase());
    for (const digest of [receipt.baseline.sparg0ManualVod, receipt.baseline.sparg0ProviderVod]) {
      expect(digest).not.toHaveProperty('uid');
      expect(digest).not.toHaveProperty('version');
      // Still a real, comparable digest — the VOD drift tests above depend on it.
      expect(digest.digest).toMatch(/^[0-9a-f]{64}$/);
    }
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
// Assertion 10 — the rejected-operation trace probe (hard gate #4, B5).
//
// The defect this replaces: the old assertion asserted LIFETIME ABSENCE of the
// analytics/ledger/credit/job/token trees for demo uids, which contradicts
// RTEN-04 (ordinary product telemetry is permitted) and the free demo report
// (which intentionally leaves a succeeded `reportJobs` record). The fixture
// tree now CONTAINS both of those, so the first test below is the false-RED
// regression guard: a healthy system must go green.
// ---------------------------------------------------------------------------

/** Captures a real snapshot through the same code the audit verifies against. */
async function snapshotOf(
  database: FakeDatabase,
  uid: string,
  capturedAtMs: number,
): Promise<Gate6TraceSnapshot> {
  return captureGate6TraceSnapshot(asDatabase(database), uid, {
    startedAtMs: NOW_MS - 5_000,
    finishedAtMs: NOW_MS - 1_000,
    capturedAtMs,
  });
}

/** The API deployment coordinates of a correctly-bound capture (format v3). */
const EXPECTED_API_REVISION = 'smash-tracker-api-00042-xyz';
const EXPECTED_API_RELEASE_SHA = 'deadbeefcafe';

/** What all three of a healthy capture's responses said about their own origin. */
function healthyOrigins(
  overrides: { revision?: string; releaseSha?: string } = {},
): Gate6ProbeEnvironment['responseOrigins'] {
  return GATE6_ORIGIN_BOUND_RESPONSES.map((label) => ({
    label,
    revision: overrides.revision ?? EXPECTED_API_REVISION,
    releaseSha: overrides.releaseSha ?? EXPECTED_API_RELEASE_SHA,
  }));
}

function healthyEnvironment(overrides: Partial<Gate6ProbeEnvironment> = {}): Gate6ProbeEnvironment {
  return {
    apiBaseUrl: 'https://grandfinals.gg/api',
    apiEnvironment: 'production',
    apiService: 'smash-tracker-api',
    apiRevision: EXPECTED_API_REVISION,
    apiReleaseSha: EXPECTED_API_RELEASE_SHA,
    apiFirebaseProjectId: 'smash-tracker-f97b7',
    // The API's OWN answer must name the database the audit reads.
    apiDatabaseHost: LIVE_DATABASE_HOST,
    apiDatabaseEmulatorHost: null,
    localDatabaseHost: LIVE_DATABASE_HOST,
    localFirebaseProjectId: 'smash-tracker-f97b7',
    localDatabaseEmulatorHost: null,
    expectedApiRevision: EXPECTED_API_REVISION,
    expectedApiReleaseSha: EXPECTED_API_RELEASE_SHA,
    expectedApiEnvironment: 'production',
    responseOrigins: healthyOrigins(),
    projectIdChecked: true,
    bound: true,
    ...overrides,
  };
}

/**
 * A sealed probe of one refused operation. `mutate` runs BETWEEN the two
 * snapshots — an honest refusal mutates nothing, and a perturbation writes the
 * row the refusal was supposed to prevent.
 */
async function sealedProbe(
  database: FakeDatabase,
  workspace: Gate6WorkspaceKey,
  options: {
    mutate?: (database: FakeDatabase) => void;
    body?: Partial<Gate6RejectedOperationProbeBody>;
  } = {},
): Promise<Gate6RejectedOperationProbeInput> {
  const uid = UIDS[workspace];
  const before = await snapshotOf(database, uid, NOW_MS - 6_000);
  options.mutate?.(database);
  const after = await snapshotOf(database, uid, NOW_MS - 500);
  const body: Gate6RejectedOperationProbeBody = {
    formatVersion: GATE6_REJECTED_OPERATION_PROBE_FORMAT_VERSION,
    workspace,
    uid,
    databaseHost: LIVE_DATABASE_HOST,
    operation: 'POST /api/billing/checkout (credit purchase on a demo account)',
    refusal: `403 ${DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE} from POST /billing/checkout`,
    refusalEnvelope: {
      status: 403,
      contentType: 'application/json; charset=utf-8',
      code: DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE,
      error: 'Forbidden',
      message: 'Credit purchases are not available for this account',
      statusCode: 403,
    },
    environment: healthyEnvironment(),
    startedAtMs: NOW_MS - 5_000,
    finishedAtMs: NOW_MS - 1_000,
    before,
    after,
    ...options.body,
  };
  return { path: `./probe-${workspace}.json`, raw: createGate6RejectedOperationProbe(body) };
}

async function allProbes(database: FakeDatabase): Promise<Gate6RejectedOperationProbeInput[]> {
  const probes: Gate6RejectedOperationProbeInput[] = [];
  for (const workspace of GATE6_WORKSPACE_KEYS) {
    probes.push(await sealedProbe(database, workspace));
  }
  return probes;
}

/** The unsealed body of a probe — the reseal helpers below edit this, not the sealed value. */
function probeBodyOf(input: Gate6RejectedOperationProbeInput): Gate6RejectedOperationProbeBody {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; the seal is intentionally discarded before resealing
  const { contentHash, ...body } = input.raw as Record<string, unknown>;
  return body as unknown as Gate6RejectedOperationProbeBody;
}

describe('assertion 10: rejected-operation-no-trace', () => {
  it('PASSES a healthy system whose demo accounts carry legitimate telemetry and a succeeded free report', async () => {
    const database = makeDatabase();
    // The precondition that makes this a regression guard and not a tautology:
    // the corpus really does hold the rows the old assertion called violations.
    const tree = database.dump() as Record<string, Record<string, unknown>>;
    expect((tree.reportJobs as Record<string, unknown>)[UIDS.sparg0]).toBeDefined();
    expect(
      (tree.eventLedger as Record<string, Record<string, unknown>>)[DEMO_TELEMETRY_DAY]!.evtDemo,
    ).toBeDefined();

    const receipt = await audit(database, { rejectedOperationProbes: await allProbes(database) });
    expect(assertionOf(receipt, 'rejected-operation-no-trace')).toMatchObject({
      ok: true,
      status: 'passed',
    });
    expect(receipt.rejectedOperationProbes.every((row) => row.wroteNothing)).toBe(true);
  });

  it('inspects a non-empty surface population per probe — never passes on emptiness', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, { rejectedOperationProbes: await allProbes(database) });
    // Five mandatory uid-keyed surfaces, plus the day-sharded pair, plus one
    // dedup address for the demo uid that has telemetry.
    expect(assertionOf(receipt, 'rejected-operation-no-trace').inspected).toBeGreaterThanOrEqual(
      GATE6_UID_TRACE_SURFACES.length * GATE6_WORKSPACE_KEYS.length,
    );
    for (const row of receipt.rejectedOperationProbes) {
      expect(row.surfacesCompared).toBeGreaterThanOrEqual(GATE6_UID_TRACE_SURFACES.length);
    }
  });

  it.each([
    [
      'creditLedger',
      (database: FakeDatabase) => database.seed(`creditLedger/${UIDS.hbox}/entry-1`, { delta: -1 }),
    ],
    ['credits', (database: FakeDatabase) => database.seed(`credits/${UIDS.hbox}`, { balance: 3 })],
    [
      'reportJobs',
      (database: FakeDatabase) =>
        database.seed(`reportJobs/${UIDS.hbox}/job-1`, { status: 'running' }),
    ],
    [
      'reportJobsByStatus/running',
      (database: FakeDatabase) =>
        database.seed(`reportJobsByStatus/running/${UIDS.hbox}/job-1`, true),
    ],
    [
      'sharesByUser',
      (database: FakeDatabase) => database.seed(`sharesByUser/${UIDS.hbox}/share-1`, true),
    ],
  ])('FAILS when the refused operation wrote to %s', async (surface, mutate) => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox', { mutate });
    const receipt = await audit(database, { rejectedOperationProbes: [probe] });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-trace-written');
    expect(
      assertionOf(receipt, 'rejected-operation-no-trace').findings.some((finding) =>
        finding.path?.startsWith(surface),
      ),
    ).toBe(true);
    expect(receipt.rejectedOperationProbes[0]!.wroteNothing).toBe(false);
  });

  it('FAILS when the refused operation emitted an eventLedger row and its paired outbox entry', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'mkleo', {
      mutate: (db) => {
        db.seed(
          `eventLedger/${DEMO_TELEMETRY_DAY}/leaked`,
          ledgerRow(UIDS.mkleo, 'report_started', `${UIDS.mkleo}:leak`),
        );
        db.seed(`outboxPending/${DEMO_TELEMETRY_DAY}/leaked`, { attempt: 0 });
      },
    });
    const receipt = await audit(database, { rejectedOperationProbes: [probe] });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-trace-written');
    const paths = assertionOf(receipt, 'rejected-operation-no-trace').findings.map(
      (finding) => finding.path,
    );
    expect(paths).toContain(`eventLedger/${DEMO_TELEMETRY_DAY}`);
    expect(paths).toContain(`outboxPending/${DEMO_TELEMETRY_DAY}`);
  });

  it('FAILS on a dedup marker the refused operation created, addressed exactly rather than guessed', async () => {
    const database = makeDatabase();
    // The refused call emitted a full event: its ledger row names the exact
    // dedup address, so the dedup surface appears in the AFTER snapshot only.
    const probe = await sealedProbe(database, 'izaw', {
      mutate: (db) => {
        db.seed(
          `eventLedger/${DEMO_TELEMETRY_DAY}/izawLeak`,
          ledgerRow(UIDS.izaw, 'report_started', `${UIDS.izaw}:leak`),
        );
        db.seed(`eventDedup/report_started/1/${UIDS.izaw}:leak`, true);
      },
    });
    const receipt = await audit(database, { rejectedOperationProbes: [probe] });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-trace-written');
    expect(
      assertionOf(receipt, 'rejected-operation-no-trace').findings.some(
        (finding) => finding.path === `eventDedup/report_started/1/${UIDS.izaw}:leak`,
      ),
    ).toBe(true);
  });

  it('does NOT fire on another account gaining telemetry during the window', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox', {
      mutate: (db) => {
        // Somebody else's traffic lands in the same day shard. The snapshot is
        // uid-attributed, so it must not move.
        db.seed(
          `eventLedger/${DEMO_TELEMETRY_DAY}/unrelated2`,
          ledgerRow(UNRELATED_UID, 'signup_completed', `${UNRELATED_UID}:c2`),
        );
        db.seed(`credits/${UNRELATED_UID}`, { balance: 99 });
      },
    });
    const receipt = await audit(database, { rejectedOperationProbes: [probe] });
    expect(assertionOf(receipt, 'rejected-operation-no-trace').ok).toBe(true);
  });

  it('is SKIPPED — visibly, not silently green — when no probe is supplied', async () => {
    const receipt = await audit(makeDatabase());
    const assertion = assertionOf(receipt, 'rejected-operation-no-trace');
    expect(assertion.status).toBe('skipped');
    expect(assertion.ok).toBe(true);
    expect(assertion.inspected).toBe(0);
    expect(assertion.skipReason).toMatch(/--rejected-operation-probe/);
    expect(receipt.skippedCount).toBeGreaterThanOrEqual(1);
  });

  it('FAILS on the same absent evidence under --require-rejected-operation-probe', async () => {
    const receipt = await audit(makeDatabase(), { requireRejectedOperationProbes: true });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-missing',
      // The receipt attestation is skipped in this run, not red.
      [],
    );
  });

  it('FAILS on partial coverage under --require-rejected-operation-probe, naming each uncovered account', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [await sealedProbe(database, 'hbox')],
      requireRejectedOperationProbes: true,
    });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-probe-missing');
    const uncovered = assertionOf(receipt, 'rejected-operation-no-trace')
      .findings.filter((finding) => finding.code === 'rejected-operation-probe-missing')
      .map((finding) => finding.workspace);
    expect(uncovered.sort()).toEqual(['izaw', 'mkleo', 'sparg0']);
  });

  it('FAILS a probe whose seal was tampered with', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox');
    const tampered = {
      ...(probe.raw as Record<string, unknown>),
      operation: 'something else entirely',
    };
    const receipt = await audit(database, {
      rejectedOperationProbes: [{ path: probe.path, raw: tampered }],
    });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-probe-invalid');
  });

  it('FAILS a probe that is not JSON at all (the CLI hands on a null raw rather than crashing)', async () => {
    const receipt = await audit(makeDatabase(), {
      rejectedOperationProbes: [{ path: './broken.json', raw: null }],
    });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-probe-invalid');
  });

  it('FAILS a probe sealed for a different account', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox', {
      body: { workspace: 'mkleo' },
    });
    const receipt = await audit(database, { rejectedOperationProbes: [probe] });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-uid-mismatch',
    );
  });

  it('FAILS a probe sealed against a different database host', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox', {
      body: { databaseHost: 'staging-db.firebaseio.com' },
    });
    const receipt = await audit(database, { rejectedOperationProbes: [probe] });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-host-mismatch',
    );
  });

  it('FAILS — never silently passes — when no expected host was supplied to check against', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox');
    const receipt = await audit(database, {
      rejectedOperationProbes: [probe],
      expectedDatabaseHost: null,
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-host-unchecked',
    );
  });

  it('FAILS a STALE probe: yesterday’s refusal is not evidence about now', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox');
    const receipt = await audit(database, {
      rejectedOperationProbes: [probe],
      // Two days later, past the 24h default freshness bound.
      nowMs: NOW_MS + 2 * 24 * 60 * 60 * 1000,
    });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-probe-stale', [
      // A future-dated audit clock also expires the receipt fixtures, but none
      // are supplied in this run.
    ]);
  });

  it('FAILS a probe whose snapshots do not bracket the operation it claims to describe', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox');
    const body = probeBodyOf(probe);
    const resealed = createGate6RejectedOperationProbe({
      ...body,
      // The "before" snapshot was taken AFTER the operation started, so it
      // cannot witness the pre-state.
      before: { ...body.before, capturedAtMs: body.startedAtMs + 1 },
    });
    const receipt = await audit(database, {
      rejectedOperationProbes: [{ path: probe.path, raw: resealed }],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-window-invalid',
    );
  });

  it('FAILS a probe whose claimed day shards do not follow from its own window', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox');
    const body = probeBodyOf(probe);
    const resealed = createGate6RejectedOperationProbe({
      ...body,
      before: { ...body.before, dayShards: ['19700101'] },
      after: { ...body.after, dayShards: ['19700101'] },
    });
    const receipt = await audit(database, {
      rejectedOperationProbes: [{ path: probe.path, raw: resealed }],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-window-invalid',
    );
  });

  it('FAILS a probe captured under a different snapshot rule version', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox');
    const body = probeBodyOf(probe);
    const resealed = createGate6RejectedOperationProbe({
      ...body,
      before: { ...body.before, version: GATE6_TRACE_SNAPSHOT_VERSION + 1 },
    });
    const receipt = await audit(database, {
      rejectedOperationProbes: [{ path: probe.path, raw: resealed }],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-version-mismatch',
    );
  });

  it('FAILS an EMPTY probe rather than passing on two vacuously equal snapshots', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox');
    const body = probeBodyOf(probe);
    const hollow = createGate6RejectedOperationProbe({
      ...body,
      before: { ...body.before, surfaces: [] },
      after: { ...body.after, surfaces: [] },
    });
    const receipt = await audit(database, {
      rejectedOperationProbes: [{ path: probe.path, raw: hollow }],
    });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-probe-incomplete');
  });
});

// ---------------------------------------------------------------------------
// Phase 30.3 capture-evidence hardening: the audit RE-DERIVES both v2 proofs
// rather than trusting the operator's sealed attestation of them.
//
// The seal proves an artifact has not been EDITED. It cannot prove the
// operator applied the rule this audit requires — an older operator, or one
// built against a different constant, produces a perfectly-sealed probe that
// attests to the wrong thing. So every check the capture makes is made again
// here, against the sealed values.
// ---------------------------------------------------------------------------

/** Reseals a probe body with one member of the refusal envelope perturbed. */
async function probeWithEnvelope(
  database: FakeDatabase,
  overrides: Partial<Gate6RejectedOperationProbeBody['refusalEnvelope']>,
): Promise<Gate6RejectedOperationProbeInput> {
  const probe = await sealedProbe(database, 'hbox');
  const body = probeBodyOf(probe);
  return {
    path: probe.path,
    raw: createGate6RejectedOperationProbe({
      ...body,
      refusalEnvelope: { ...body.refusalEnvelope, ...overrides },
    }),
  };
}

/** Reseals a probe body with the environment binding perturbed. */
async function probeWithEnvironment(
  database: FakeDatabase,
  overrides: Partial<Gate6ProbeEnvironment>,
): Promise<Gate6RejectedOperationProbeInput> {
  const probe = await sealedProbe(database, 'hbox');
  const body = probeBodyOf(probe);
  return {
    path: probe.path,
    raw: createGate6RejectedOperationProbe({
      ...body,
      environment: { ...body.environment, ...overrides },
    }),
  };
}

describe('assertion 10 (v2): the refusal must be the APPLICATION’s', () => {
  it('PASSES the correctly-coded refusal, and reports the code in the receipt', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, { rejectedOperationProbes: await allProbes(database) });
    expect(assertionOf(receipt, 'rejected-operation-no-trace').status).toBe('passed');
    for (const row of receipt.rejectedOperationProbes) {
      expect(row.refusalCode).toBe(DEMO_ACCOUNT_CHECKOUT_FORBIDDEN_CODE);
      expect(row.environmentBound).toBe(true);
      expect(row.apiEnvironment).toBe('production');
      // Slot and source, reported separately — never one folded into the other.
      expect(row.apiRevision).toBe(EXPECTED_API_REVISION);
      expect(row.apiReleaseSha).toBe(EXPECTED_API_RELEASE_SHA);
      expect(row.originBoundResponses).toBe(GATE6_ORIGIN_BOUND_RESPONSES.length);
    }
  });

  it.each([
    ['a DIFFERENT application code — some other guard refused', 'some_other_guard'],
    ['a code that merely looks plausible', 'forbidden'],
  ])('FAILS %s', async (_label, code) => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [await probeWithEnvelope(database, { code })],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-refusal-code-unexpected',
    );
    expect(receipt.rejectedOperationProbes[0]!.refusalCode).toBe(code);
  });

  it('FAILS an HTML content type — that is an edge refusal, not the application', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [await probeWithEnvelope(database, { contentType: 'text/html' })],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-refusal-code-unexpected',
    );
  });

  it('FAILS an envelope whose statusCode disagrees with the observed status', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [await probeWithEnvelope(database, { statusCode: 401 })],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-refusal-code-unexpected',
    );
  });

  /**
   * The audit used to reassert `status === statusCode` — a comparison between
   * two members of the SAME sealed artifact, which every probe satisfies by
   * construction. A probe whose refusal was an internally-consistent 401 (or
   * 404, or 429) therefore sailed through the check that was supposed to pin
   * it to the demo guard's own 403. Both members are now reasserted against
   * the literal.
   */
  it('FAILS a SELF-CONSISTENT refusal at the wrong status — the old check was a self-comparison', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        // status and statusCode AGREE; they are simply not 403.
        await probeWithEnvelope(database, { status: 401, statusCode: 401 }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-refusal-code-unexpected',
    );
    const detail = assertionOf(receipt, 'rejected-operation-no-trace')
      .findings.map((finding) => finding.detail)
      .join('\n');
    expect(detail).toContain(String(GATE6_REFUSED_OPERATION_EXPECTED_STATUS));
  });

  it('pins the expected refusal status in committed source', () => {
    expect(GATE6_REFUSED_OPERATION_EXPECTED_STATUS).toBe(403);
  });
});

describe('assertion 10 (v2): the API and the RTDB must be ONE environment', () => {
  it('FAILS when the API names a DIFFERENT database than the operator snapshotted', async () => {
    // THE headline case: an API with compatible auth and allowlists pointed at
    // another RTDB. Both halves look healthy; only the comparison catches it.
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, { apiDatabaseHost: 'staging-rtdb.firebaseio.com' }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-environment-mismatch',
    );
    expect(receipt.rejectedOperationProbes[0]!.environmentBound).toBe(false);
  });

  it('FAILS when the API names a database that is not the one THIS audit is reading', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, {
          apiDatabaseHost: 'elsewhere-rtdb.firebaseio.com',
          localDatabaseHost: 'elsewhere-rtdb.firebaseio.com',
        }),
      ],
    });
    // Operator and API agree with each other but not with the audited tree —
    // a self-consistent capture of the wrong system.
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-environment-mismatch',
    );
  });

  it('FAILS when the probe body and its environment record disagree about the local host', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, {
          localDatabaseHost: 'somewhere-else.firebaseio.com',
          apiDatabaseHost: 'somewhere-else.firebaseio.com',
        }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-environment-mismatch',
    );
  });

  it('FAILS on an emulator mismatch even when the host string matches', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, { apiDatabaseEmulatorHost: '127.0.0.1:9000' }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-environment-mismatch',
    );
  });

  it('FAILS on a Firebase project mismatch when BOTH sides stated one', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, { apiFirebaseProjectId: 'some-other-project' }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-environment-mismatch',
    );
  });

  it('does NOT fail on differing project ids when the axis is honestly marked UNCHECKED', async () => {
    // An unchecked axis must not be read as agreement, and must not be
    // manufactured into a failure either — the host binding is the one that
    // carries the weight and it still holds here.
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, {
          projectIdChecked: false,
          apiFirebaseProjectId: null,
          localFirebaseProjectId: 'smash-tracker-f97b7',
        }),
      ],
    });
    expect(assertionOf(receipt, 'rejected-operation-no-trace').status).toBe('passed');
    expect(receipt.rejectedOperationProbes[0]!.environmentBound).toBe(true);
  });

  it('FAILS a probe captured against an UNEXPECTED environment', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, { apiEnvironment: 'development' }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-environment-unexpected',
    );
  });

  it('FAILS a probe captured against the WRONG revision', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, { apiRevision: 'smash-tracker-api-00099-old' }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-revision-unexpected',
    );
  });

  it('FAILS when the API named no deployment revision at all', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [await probeWithEnvironment(database, { apiRevision: null })],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-revision-unexpected',
    );
  });
});

/**
 * DEPLOYMENT-BINDING HARDENING, ITEM 2 — the audit's own re-derivation of the
 * release SHA.
 *
 * The audit re-derived the build with the same `revision ?? releaseSha` rule
 * the operator used, so it reproduced the operator's blind spot rather than
 * catching it. A probe sealed by a stale or differently-built operator — one
 * that never compared the SHA — has to fail HERE, at the audit, which is the
 * whole reason the audit re-derives instead of reading `bound: true`.
 */
describe('assertion 10 (v3): the reviewed SOURCE, not just the reviewed deploy slot', () => {
  it('FAILS the right revision with the WRONG release SHA — the headline false green', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        // The deploy slot is exactly the reviewed one. The image in it is not.
        await probeWithEnvironment(database, {
          apiReleaseSha: 'facefeed00000000',
          responseOrigins: healthyOrigins({ releaseSha: 'facefeed00000000' }),
        }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-release-sha-unexpected',
    );
    expect(receipt.rejectedOperationProbes[0]!.apiRevision).toBe(EXPECTED_API_REVISION);
    expect(receipt.rejectedOperationProbes[0]!.apiReleaseSha).toBe('facefeed00000000');
  });

  it('FAILS a deployment that publishes NO release SHA — a null is an abort, not an exemption', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [await probeWithEnvironment(database, { apiReleaseSha: null })],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-release-sha-unexpected',
    );
  });
});

/**
 * DEPLOYMENT-BINDING HARDENING, ITEM 3 — no capture may straddle two builds.
 *
 * Deployment identity, `GET /users/me`, and the refused checkout are three
 * separate HTTP requests. Only the first was ever bound, so under split
 * traffic the probe could bind an identity from revision A while sealing a
 * refusal from revision B — with nothing in the artifact to show it.
 */
describe('assertion 10 (v3): mixed-revision captures', () => {
  it('FAILS when the REFUSAL came from a different revision than the identity it is bound to', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, {
          responseOrigins: [
            {
              label: 'deployment-identity',
              revision: EXPECTED_API_REVISION,
              releaseSha: EXPECTED_API_RELEASE_SHA,
            },
            {
              label: 'users-me',
              revision: EXPECTED_API_REVISION,
              releaseSha: EXPECTED_API_RELEASE_SHA,
            },
            // Cloud Run split traffic: the checkout landed on the OTHER revision.
            {
              label: 'billing-checkout',
              revision: 'smash-tracker-api-00099-old',
              releaseSha: 'facefeed00000000',
            },
          ],
        }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-mixed-revision',
    );
    // NOTHING was sealed as bound: the shortfall is visible, not rounded up.
    expect(receipt.rejectedOperationProbes[0]!.originBoundResponses).toBe(2);
    expect(receipt.ok).toBe(false);
  });

  it.each(GATE6_ORIGIN_BOUND_RESPONSES)(
    'FAILS when the "%s" response was never origin-checked',
    async (missing) => {
      const database = makeDatabase();
      const receipt = await audit(database, {
        rejectedOperationProbes: [
          await probeWithEnvironment(database, {
            responseOrigins: healthyOrigins().filter((origin) => origin.label !== missing),
          }),
        ],
      });
      expectPerturbed(
        receipt,
        'rejected-operation-no-trace',
        'rejected-operation-probe-mixed-revision',
      );
      expect(receipt.rejectedOperationProbes[0]!.originBoundResponses).toBe(
        GATE6_ORIGIN_BOUND_RESPONSES.length - 1,
      );
    },
  );

  it('FAILS a capture that origin-checked NOTHING — an empty list is not coverage', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [await probeWithEnvironment(database, { responseOrigins: [] })],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-mixed-revision',
    );
    expect(receipt.rejectedOperationProbes[0]!.originBoundResponses).toBe(0);
  });

  it('FAILS a list that pads coverage by repeating one response', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      rejectedOperationProbes: [
        await probeWithEnvironment(database, {
          responseOrigins: [
            ...healthyOrigins().filter((origin) => origin.label !== 'billing-checkout'),
            // Three entries, but the refusal is still unchecked.
            {
              label: 'users-me',
              revision: EXPECTED_API_REVISION,
              releaseSha: EXPECTED_API_RELEASE_SHA,
            },
          ],
        }),
      ],
    });
    expectPerturbed(
      receipt,
      'rejected-operation-no-trace',
      'rejected-operation-probe-mixed-revision',
    );
  });
});

describe('assertion 10 (v2): a STALE-FORMAT probe is refused, never leniently parsed', () => {
  it('REFUSES a v1 probe BY NAME rather than migrating it', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox');
    // Exactly the v1 shape: the two proofs removed, resealed under v1's
    // version literal. The seal is internally valid — only the FORMAT is old.
    const body = probeBodyOf(probe) as unknown as Record<string, unknown>;
    delete body.refusalEnvelope;
    delete body.environment;
    body.formatVersion = 1;
    // Sealed with a GENUINE hash under the same canonicalization law, so the
    // refusal below is unambiguously about the FORMAT and not about a broken
    // seal we accidentally handed it.
    const v1 = { ...body, contentHash: canonicalDigest(body) };

    const receipt = await audit(database, {
      rejectedOperationProbes: [{ path: probe.path, raw: v1 }],
    });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-probe-invalid');
    const detail = assertionOf(receipt, 'rejected-operation-no-trace').findings[0]!.detail;
    expect(detail).toContain('formatVersion 1');
    expect(detail).toContain('REFUSED, not migrated');
    expect(receipt.rejectedOperationProbes[0]!.valid).toBe(false);
    expect(receipt.ok).toBe(false);
  });

  it('REFUSES a v2 probe BY NAME — it carries no release-SHA expectation and no response origins', async () => {
    const database = makeDatabase();
    const probe = await sealedProbe(database, 'hbox');
    // Exactly the v2 shape: the two v3 proofs removed from the environment
    // record, resealed under v2's version literal, with a GENUINE hash — so
    // the refusal below is unambiguously about the FORMAT.
    const body = probeBodyOf(probe) as unknown as Record<string, unknown>;
    const environment = { ...(body.environment as Record<string, unknown>) };
    delete environment.expectedApiReleaseSha;
    delete environment.responseOrigins;
    body.environment = environment;
    body.formatVersion = 2;
    const v2 = { ...body, contentHash: canonicalDigest(body) };

    const receipt = await audit(database, {
      rejectedOperationProbes: [{ path: probe.path, raw: v2 }],
    });
    expectPerturbed(receipt, 'rejected-operation-no-trace', 'rejected-operation-probe-invalid');
    const detail = assertionOf(receipt, 'rejected-operation-no-trace').findings[0]!.detail;
    expect(detail).toContain('formatVersion 2');
    expect(detail).toContain('REFUSED, not migrated');
    expect(receipt.rejectedOperationProbes[0]!.valid).toBe(false);
    expect(receipt.ok).toBe(false);
  });

  it('pins the current format version so a bump is a deliberate, reviewed act', () => {
    expect(GATE6_REJECTED_OPERATION_PROBE_FORMAT_VERSION).toBe(3);
  });
});

describe('captureGate6TraceSnapshot', () => {
  it('reads only bounded, uid-addressed paths — never a whole ledger/dedup/outbox root', async () => {
    const database = makeDatabase();
    const read: string[] = [];
    const spy = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'ref') {
          return (path?: string) => {
            read.push(path ?? '');
            return target.ref(path);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    await captureGate6TraceSnapshot(spy as unknown as Database, UIDS.hbox, {
      startedAtMs: NOW_MS - 5_000,
      finishedAtMs: NOW_MS - 1_000,
      capturedAtMs: NOW_MS,
    });
    // The whole point of B5: no bare root read of any of these trees.
    expect(read).not.toContain('eventLedger');
    expect(read).not.toContain('eventDedup');
    expect(read).not.toContain('outboxPending');
    expect(read).not.toContain('shareTokens');
    for (const tree of GATE6_UID_TRACE_SURFACES) {
      expect(read).toContain(`${tree}/${UIDS.hbox}`);
    }
    expect(read).toContain(`eventLedger/${DEMO_TELEMETRY_DAY}`);
  });

  it('names every UTC shard a window straddling midnight could have touched', () => {
    const midnight = Date.UTC(2026, 0, 2, 0, 0, 0);
    expect(gate6WindowDayShards(midnight - 1_000, midnight + 1_000)).toEqual([
      '20260101',
      '20260102',
    ]);
    expect(gate6WindowDayShards(midnight, midnight)).toEqual(['20260102']);
  });

  it('refuses an unsafe uid rather than building a path from it', async () => {
    await expect(
      captureGate6TraceSnapshot(asDatabase(makeDatabase()), 'bad/uid', {
        startedAtMs: NOW_MS,
        finishedAtMs: NOW_MS,
        capturedAtMs: NOW_MS,
      }),
    ).rejects.toThrow(/unsafe uid/);
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
// Assertion 12 — registry attestation over LIVE generated content
// (rebuilt under hard gate #4, B7).
//
// The defect this closes: the old assertion only checked the FOREIGN digest,
// so a sealed receipt stayed green after every generated `histimport:` row was
// edited or deleted. The "stale seal" tests below are the regression proof.
// ---------------------------------------------------------------------------

describe('assertion 12: registry-receipt-attestation', () => {
  it('passes when all four sealed COMPARE receipts agree with live generated and foreign content', async () => {
    const receipt = await audit(makeDatabase(), { registryReceipts: allReceipts() });
    expect(assertionOf(receipt, 'registry-receipt-attestation')).toMatchObject({
      ok: true,
      status: 'passed',
      inspected: 4,
    });
    expect(receipt.registryReceipts).toHaveLength(4);
    expect(receipt.registryReceipts.every((row) => row.command === 'compare')).toBe(true);
    expect(receipt.registryManifests.every((row) => row.valid)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // B7's headline requirement: an OLD sealed receipt must FAIL after any
  // generated row is changed or deleted.
  // -------------------------------------------------------------------------

  it('FAILS a still-valid sealed receipt after a generated row is CHANGED', async () => {
    const database = makeDatabase();
    const receipts = allReceipts();
    // Nothing about the receipt is touched; the account's generated content is.
    database.seed(`tournamentEntries/${UIDS.hbox}/histimport:hbox-1/playedSetCount`, 99);
    const receipt = await audit(database, { registryReceipts: receipts });
    expectPerturbed(
      receipt,
      'registry-receipt-attestation',
      'registry-live-row-set-mismatch',
      // Assertion 8 stays green: the row that moved is registry-OWNED, which
      // is exactly the population that assertion deliberately ignores.
      [],
    );
    expect(assertionOf(receipt, 'registry-preservation').ok).toBe(true);
    expect(assertionOf(receipt, 'registry-receipt-attestation').findings[0]!.detail).toMatch(
      /the attestation is stale/,
    );
  });

  it('FAILS a still-valid sealed receipt after a generated row is DELETED', async () => {
    const database = makeDatabase();
    const receipts = allReceipts();
    database.seed(`tournamentEntries/${UIDS.sparg0}/histimport:sparg0-2`, null);
    const receipt = await audit(database, { registryReceipts: receipts });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-live-row-set-mismatch');
    expect(assertionOf(receipt, 'registry-preservation').ok).toBe(true);
  });

  it('FAILS after a generated row is ADDED that the reviewed manifest never authorized', async () => {
    const database = makeDatabase();
    const receipts = allReceipts();
    database.seed(
      `tournamentEntries/${UIDS.mkleo}/histimport:mkleo-9`,
      ownedRegistryRow('mkleo-9'),
    );
    const receipt = await audit(database, { registryReceipts: receipts });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-live-row-set-mismatch');
  });

  it('FAILS when a live registry-owned child no longer parses as a registry row', async () => {
    const database = makeDatabase();
    const receipts = allReceipts();
    // Structurally owned (origin + witness survive) but no longer a valid row.
    database.seed(`tournamentEntries/${UIDS.izaw}/histimport:izaw-1/playedSetCount`, 'four');
    const receipt = await audit(database, { registryReceipts: receipts });
    expect(receipt.ok).toBe(false);
    expect(codesOf(receipt, 'registry-receipt-attestation')).toContain(
      'registry-live-row-unparseable',
    );
  });

  it('reports the live generated population in the receipt, so the figure is reviewable', async () => {
    const receipt = await audit(makeDatabase(), { registryReceipts: allReceipts() });
    for (const row of receipt.observed) {
      expect(row.registryOwnedRows).toBe(2);
      expect(row.registryRowSetHash).toBe(liveRegistryRowSetHash(row.workspace));
    }
  });

  // -------------------------------------------------------------------------
  // Command, settledness, manifest identity, freshness, host.
  // -------------------------------------------------------------------------

  it('REFUSES an apply receipt: the attestation must rest on an independent later read', async () => {
    const database = makeDatabase();
    const receipt = await audit(database, {
      registryReceipts: [receiptInput('hbox', { command: 'apply', writes: null })],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-not-post-state');
    expect(assertionOf(receipt, 'registry-receipt-attestation').findings[0]!.detail).toMatch(
      /independent, later, read-only compare run/,
    );
  });

  it('REFUSES a dry-run receipt: planning is not evidence of a completed apply', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [
        receiptInput('hbox', {
          command: 'dry-run',
          manifestContentHash: null,
          manifestGeneratedAtMs: null,
          reviewedRowSetHash: null,
          writes: null,
        }),
      ],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-not-post-state');
  });

  it('REFUSES a receipt whose sealed post-state still has pending work', async () => {
    const digest = liveForeignDigest('hbox');
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [
        receiptInput('hbox', { after: countSnapshot(digest.count, { creates: 1, unchanged: 1 }) }),
      ],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-not-settled');
  });

  it('REFUSES a receipt when no reviewed manifest was supplied to check its authorization against', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox')],
      registryManifests: [],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-manifest-missing');
  });

  it('REFUSES a receipt authorized by a DIFFERENT manifest than the one under review', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox')],
      // Same account, different generation stamp -> different content hash.
      registryManifests: [manifestInput('hbox', { generatedAtMs: MANIFEST_GENERATED_AT_MS - 1 })],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-manifest-mismatch');
  });

  it('REFUSES a manifest generated against a different database', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox')],
      registryManifests: [manifestInput('hbox', { databaseHost: 'staging-db.firebaseio.com' })],
    });
    expect(receipt.ok).toBe(false);
    // The receipt names a manifest hash that this (differently-sealed)
    // manifest cannot have, so the identity check is what reports first.
    expect(codesOf(receipt, 'registry-receipt-attestation')[0]).toMatch(
      /registry-(manifest-host-mismatch|receipt-manifest-mismatch)/,
    );
  });

  it('REFUSES a manifest whose seal was broken', async () => {
    const manifest = sealedManifest('hbox') as unknown as Record<string, unknown>;
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox')],
      registryManifests: [
        { path: './bad-manifest.json', raw: { ...manifest, generatedAtMs: NOW_MS } },
      ],
    });
    expect(receipt.ok).toBe(false);
    expect(codesOf(receipt, 'registry-receipt-attestation')).toContain('registry-manifest-invalid');
  });

  it('REFUSES two manifests scoping the same workspace — ambiguous review is not review', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox')],
      registryManifests: [manifestInput('hbox'), manifestInput('hbox')],
    });
    expect(receipt.ok).toBe(false);
    expect(codesOf(receipt, 'registry-receipt-attestation')).toContain(
      'registry-manifest-duplicate',
    );
  });

  it('REFUSES a STALE receipt: a compare from last week is not evidence about now', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox')],
      nowMs: NOW_MS + 7 * 24 * 60 * 60 * 1000,
    });
    expect(receipt.ok).toBe(false);
    expect(codesOf(receipt, 'registry-receipt-attestation')).toContain('registry-receipt-stale');
  });

  it('REFUSES a receipt dated in the future', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [
        receiptInput('hbox', { startedAtMs: NOW_MS + 1_000, finishedAtMs: NOW_MS + 10_000 }),
      ],
    });
    expect(receipt.ok).toBe(false);
    expect(codesOf(receipt, 'registry-receipt-attestation')).toContain('registry-receipt-stale');
  });

  it('FAILS — never silently passes — when no expected host was supplied to check against', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox')],
      expectedDatabaseHost: null,
    });
    expect(receipt.ok).toBe(false);
    expect(codesOf(receipt, 'registry-receipt-attestation')).toContain(
      'registry-receipt-host-unchecked',
    );
    expect(receipt.registryReceipts[0]!.databaseHostChecked).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Pre-existing contract, preserved.
  // -------------------------------------------------------------------------

  it('is SKIPPED — visibly, not silently green — when no receipt is supplied', async () => {
    const receipt = await audit(makeDatabase());
    const assertion = assertionOf(receipt, 'registry-receipt-attestation');
    expect(assertion.status).toBe('skipped');
    expect(assertion.ok).toBe(true);
    expect(assertion.inspected).toBe(0);
    expect(assertion.skipReason).toMatch(/--registry-receipt/);
    expect(receipt.registryReceipts).toEqual([]);
  });

  it('FAILS on the same absent evidence under --require-registry-receipt', async () => {
    const receipt = await audit(makeDatabase(), { requireRegistryReceipts: true });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-missing');
  });

  it('FAILS on partial coverage under --require-registry-receipt, naming each uncovered account', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox'), receiptInput('mkleo')],
      requireRegistryReceipts: true,
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-missing');
    const uncovered = assertionOf(receipt, 'registry-receipt-attestation')
      .findings.filter((finding) => finding.code === 'registry-receipt-missing')
      .map((finding) => finding.workspace);
    expect(uncovered.sort()).toEqual(['izaw', 'sparg0']);
  });

  it('accepts partial coverage WITHOUT the require flag — opt-in evidence is still checked strictly', async () => {
    const receipt = await audit(makeDatabase(), { registryReceipts: [receiptInput('hbox')] });
    expect(assertionOf(receipt, 'registry-receipt-attestation').status).toBe('passed');
    expect(receipt.ok).toBe(true);
  });

  it('FAILS a receipt whose contentHash seal was tampered with', async () => {
    const sealed = sealedReceipt('hbox');
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [
        { path: './receipt-hbox.json', raw: { ...sealed, contentHash: contentHash('forged') } },
      ],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-invalid');
  });

  it('FAILS a receipt whose BODY was edited (the seal no longer matches the content)', async () => {
    const sealed = sealedReceipt('hbox');
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [
        { path: './receipt-hbox.json', raw: { ...sealed, label: 'Someone Else' } },
      ],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-invalid');
  });

  it('FAILS a receipt that is not JSON at all (the CLI hands on a null raw rather than crashing)', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [{ path: './broken.json', raw: null }],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-invalid');
  });

  it('FAILS a receipt sealed for a different account', async () => {
    const foreignUid = 'gate6-someone-else-uid';
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox', { uid: foreignUid })],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-uid-mismatch');
  });

  it('FAILS a receipt sealed as refused or failed — an authentic record of a BAD run is not evidence of a good one', async () => {
    for (const status of ['refused', 'failed'] as const) {
      const receipt = await audit(makeDatabase(), {
        registryReceipts: [
          receiptInput('hbox', {
            status,
            failedInvariants: ['foreign-row-digest changed across the apply'],
          }),
        ],
      });
      expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-not-ok');
    }
  });

  it('FAILS a receipt sealed against a different database host', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox', { databaseHost: 'staging-db.firebaseio.com' })],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-host-mismatch');
  });

  it('FAILS when the sealed post-apply FOREIGN digest no longer matches live content', async () => {
    const database = makeDatabase();
    const receipts = allReceipts();
    database.seed(`tournamentEntries/${UIDS.hbox}/manual-hbox-a/setsPlayed`, 42);
    const receipt = await audit(database, { registryReceipts: receipts });
    expect(receipt.ok).toBe(false);
    expect(codesOf(receipt, 'registry-receipt-attestation')).toContain(
      'registry-receipt-digest-mismatch',
    );
    // Assertion 8 is the independent witness for the same population.
    expect(assertionOf(receipt, 'registry-preservation').inspected).toBeGreaterThan(0);
  });

  it('FAILS when a foreign row was ADDED after sealing, naming the added key', async () => {
    const database = makeDatabase();
    const receipts = allReceipts();
    database.seed(`tournamentEntries/${UIDS.hbox}/manual-hbox-new`, foreignRegistryRow('new'));
    const receipt = await audit(database, { registryReceipts: receipts });
    expect(codesOf(receipt, 'registry-receipt-attestation')).toContain(
      'registry-receipt-digest-mismatch',
    );
    expect(
      assertionOf(receipt, 'registry-receipt-attestation').findings.some((finding) =>
        finding.detail.includes('manual-hbox-new'),
      ),
    ).toBe(true);
  });

  it('FAILS two receipts claiming the same workspace — ambiguous evidence is not evidence', async () => {
    const receipt = await audit(makeDatabase(), {
      registryReceipts: [receiptInput('hbox'), receiptInput('hbox')],
    });
    expectPerturbed(receipt, 'registry-receipt-attestation', 'registry-receipt-duplicate');
  });

  it('is independent of assertion 8: a receipt failure leaves registry-preservation green', async () => {
    const recorded = await audit(makeDatabase());
    const receipt = await audit(makeDatabase(), {
      baseline: recorded.baseline,
      registryReceipts: [receiptInput('hbox', { command: 'apply' })],
    });
    expect(assertionOf(receipt, 'registry-receipt-attestation').status).toBe('failed');
    expect(assertionOf(receipt, 'registry-preservation').status).toBe('passed');
  });

  it('is independent in the other direction: assertion 8 can fail while no receipt is supplied at all', async () => {
    const recorded = await audit(makeDatabase());
    const database = makeDatabase();
    database.seed(`tournamentEntries/${UIDS.izaw}/manual-izaw-a/setsPlayed`, 55);
    const receipt = await audit(database, { baseline: recorded.baseline });
    expect(assertionOf(receipt, 'registry-preservation').status).toBe('failed');
    expect(assertionOf(receipt, 'registry-receipt-attestation').status).toBe('skipped');
    expect(receipt.ok).toBe(false);
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
        // Post-repair reviewed figures (2026-08-17 bounded repair): 9367
        // canonical observations + the named deferred predecessor
        // 0ebbadd338a7c1551661544a5ffaf184, and 57 GATE-2 authorizations
        // MINUS the revoked-only aa0baa79aaf76f91484d5ac46abe33f9.
        observations: 9368,
        receipts: 56,
        attachments: 56,
        characterWitnesses: 120,
        stockWitnesses: 70,
      },
      sparg0: {
        label: 'Sparg0',
        matches: 8378,
        observations: 10335,
        // 68 GATE-2 authorizations MINUS the two revoked-only stale
        // authorizations 25e8c8bf8640a17d92f481b23e00cbb8 and
        // 665117a27ce26f531b92ef61ab8082d3 (same 2026-08-17 repair).
        receipts: 66,
        attachments: 66,
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
    expect(GATE6_SPARG0_FROZEN_PROVIDER_VOD_ROWS).toBe(89);
    expect(GATE6_SPARG0_FROZEN_MANUAL_VOD_ROWS).toBe(0);
  });
});

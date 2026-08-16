import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { z } from 'zod';
import {
  isSourceOwnedVodValue,
  isTournamentRegistryOwnedRow,
  researchEnrichmentAttachmentRecordSchema,
  researchEnrichmentObservationRecordSchema,
  researchEnrichmentProjectionStateRecordSchema,
  researchEnrichmentResolutionReceiptRecordSchema,
  researchEnrichmentRunRecordSchema,
  researchTenantIngestionStateSchema,
} from '@smash-tracker/shared';
import { isPathSafeTenantId } from '../src/research/subjectKind.js';

/**
 * Phase 30.3 Gate 6: the COMMITTED acceptance oracle for the demo-account
 * enrichment corpus.
 *
 * WHY THIS FILE EXISTS. The ad-hoc `gate2PostconditionProbe.ts` that was
 * being used as the Gate-6 oracle was rejected by the owner/Codex hard gate
 * for five concrete defects, each of which this module closes structurally:
 *
 *   1. "it generally exits zero" — every check here appends a FINDING to a
 *      named assertion, `ok` is the conjunction of all of them, and the CLI
 *      shell exits `ok ? 0 : 1`. There is no path that swallows a mismatch.
 *      Every assertion also carries an anti-vacuity clause: an assertion that
 *      could only ever pass by observing nothing reports the population it
 *      inspected, and the expectation table pins that population.
 *   2. "checks the wrong nested lease location" — `researchEnrichmentRuns/
 *      {tenantId}` stores exactly ONE run record DIRECTLY at the tenant key
 *      (see the module header of `apps/api/src/research/enrichment/
 *      runState.ts`: no `{ activeRunId, runs }` wrapper, no history map), with
 *      `status`, `lease` and `leaseFenceCounter` as SIBLING members of that
 *      one record. The probe read it as a map of runs and therefore inspected
 *      a lease location that does not exist, which is indistinguishable from
 *      "no active lease". `readEnrichmentRunState` below reads the true shape.
 *      The provider-INGESTION tree (`researchIngestionRuns/{tenantId}`) DOES
 *      use the wrapper shape, and is read with its own reader — conflating
 *      the two is precisely the bug being fixed.
 *   3. "lacks schema validation" — `assertSchemaConformance` parses EVERY
 *      stored observation, receipt, attachment and projection witness under
 *      its CURRENT shared schema. This is the check whose absence let 1,196
 *      records fail silently: the pipeline's own readers `safeParse`-and-SKIP,
 *      so a schema-invalid record is INVISIBLE to every count derived from
 *      them. Every count in this module is therefore taken from a RAW child
 *      walk (schema-blind), and validity is asserted SEPARATELY — a corrupt
 *      record moves a count and trips the conformance assertion, instead of
 *      quietly vanishing from both.
 *   4. "does not count character/stock witnesses" — counted, per workspace,
 *      against the expectation table.
 *   5. "does not prove protected VOD preservation" — proven by a canonical
 *      JSON sha256 digest over the user-owned VOD rows, compared against a
 *      recorded pre-state baseline, with the row COUNT additionally pinned in
 *      the expectation table so even a first (record-mode) run fails when a
 *      protected row has already been lost.
 *
 * PURE OF I/O SHELLS. Everything here takes an injected `Database`, so the
 * whole oracle runs against `FakeDatabase` in tests. `gate6Audit.ts` is the
 * thin CLI shell; it owns argument parsing, file I/O and the process
 * lifecycle, and nothing else.
 *
 * READS ONLY. This module constructs no write of any kind — no `set`, no
 * `update`, no `remove`, no `transaction`.
 */

// ---------------------------------------------------------------------------
// Workspaces and the versioned expectation table
// ---------------------------------------------------------------------------

export const GATE6_WORKSPACE_KEYS = ['hbox', 'mkleo', 'sparg0', 'izaw'] as const;
export type Gate6WorkspaceKey = (typeof GATE6_WORKSPACE_KEYS)[number];

export type Gate6UidMap = Record<Gate6WorkspaceKey, string>;

/**
 * Bumped whenever ANY number below changes. A baseline recorded under a
 * different table version is refused rather than silently compared, because
 * the two describe different corpora.
 */
export const GATE6_EXPECTATION_TABLE_VERSION = '30.3-gate6.1';

export interface Gate6Expectation {
  label: string;
  matches: number;
  observations: number;
  /**
   * `null` means the owner did not supply a figure for this workspace, so the
   * count is REPORTED but not asserted. Deliberately explicit rather than
   * omitted: an absent expectation must be visible in the contract, never
   * mistaken for zero. (Owner-supplied figures cover receipts for Hungrybox
   * and IzAw only; MkLeo/Sparg0 receipt totals are an open item for the lead.)
   */
  receipts: number | null;
  attachments: number;
  characterWitnesses: number;
  stockWitnesses: number;
}

/**
 * THE CONTRACT. These are owner-supplied Gate-6 acceptance figures, encoded
 * in committed source on purpose: an audit whose expected values arrive as
 * CLI parameters proves only that the operator typed numbers matching the
 * database. The UIDs are parameters (they are deployment identifiers); the
 * counts are not.
 */
export const GATE6_EXPECTATIONS: Record<Gate6WorkspaceKey, Gate6Expectation> = {
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
};

/**
 * The protected user-entered VOD population on Sparg0. Pinned here as well as
 * in the digest baseline so that the FIRST (record-mode) run of this audit
 * still fails when a protected row has already been destroyed — a digest with
 * no baseline to compare against cannot detect a loss on its own, which is
 * exactly the false-green a preservation oracle must not have.
 */
export const GATE6_SPARG0_USER_OWNED_VOD_ROWS = 13;

/**
 * The zero-trace trees. The five CANONICAL names come from the shipped proof
 * in `apps/api/src/research/isolationEnumeration.test.ts` (which pins each to
 * its owning module by grep rather than to any manifest); `credits`,
 * `reportJobs` and `reportJobsByStatus` are the credit/job trees named by the
 * Gate-6 brief and are marked non-canonical so the provenance stays honest.
 */
export const GATE6_ZERO_TRACE_TREES = [
  { tree: 'eventLedger', shape: 'day-sharded', canonical: true },
  { tree: 'eventDedup', shape: 'causation-keyed', canonical: true },
  { tree: 'outboxPending', shape: 'day-sharded', canonical: true },
  { tree: 'shareTokens', shape: 'owner-member', canonical: true },
  { tree: 'creditLedger', shape: 'uid-keyed', canonical: true },
  { tree: 'credits', shape: 'uid-keyed', canonical: false },
  { tree: 'reportJobs', shape: 'uid-keyed', canonical: false },
  { tree: 'reportJobsByStatus', shape: 'status-then-uid', canonical: false },
] as const;

// ---------------------------------------------------------------------------
// Receipt shape
// ---------------------------------------------------------------------------

export const GATE6_ASSERTION_IDS = [
  'expected-counts',
  'runs-terminal',
  'no-active-leases',
  'schema-conformance',
  'attachment-integrity',
  'no-startgg-links',
  'sparg0-vod-preservation',
  'registry-preservation',
  'izaw-coaching-root',
  'zero-trace-trees',
  'witness-observation-references',
] as const;
export type Gate6AssertionId = (typeof GATE6_ASSERTION_IDS)[number];

export interface Gate6Finding {
  /** Stable machine code — safe to grep, assert on, and alert against. */
  code: string;
  workspace: Gate6WorkspaceKey | null;
  detail: string;
  expected?: string | number | null;
  actual?: string | number | null;
  path?: string;
}

export interface Gate6AssertionResult {
  id: Gate6AssertionId;
  title: string;
  ok: boolean;
  /**
   * `true` when findings are REPORTED but do not fail the audit. Only the
   * `witness-observation-references` assertion is tolerated by default, and
   * only because the shipped applier documents that behavior as intentional
   * (see `assertWitnessObservationReferences`). `--strict-witness-observation-refs`
   * clears the tolerance.
   */
  tolerated: boolean;
  /** The population this assertion actually inspected — the anti-vacuity figure. */
  inspected: number;
  findings: Gate6Finding[];
}

export interface Gate6WorkspaceObservation {
  workspace: Gate6WorkspaceKey;
  label: string;
  uid: string;
  matches: number;
  observations: number;
  receipts: number;
  attachments: number;
  attachedTargetSets: number;
  projectionWitnesses: number;
  characterWitnesses: number;
  stockWitnesses: number;
  tournamentEntries: number;
  tournamentEntriesForeign: number;
  enrichmentRunStatus: string | null;
  ingestionRunStatuses: string[];
}

export interface Gate6DigestEntry {
  count: number;
  digest: string;
  keys: string[];
}

export interface Gate6Baseline {
  baselineVersion: 1;
  expectationTableVersion: string;
  recordedAtMs: number;
  targetUids: Gate6UidMap;
  sparg0UserOwnedVod: Gate6DigestEntry;
  registryForeign: Record<Gate6WorkspaceKey, Gate6DigestEntry>;
}

export interface Gate6AuditReceipt {
  receiptVersion: 1;
  expectationTableVersion: string;
  generatedAtMs: number;
  targetUids: Gate6UidMap;
  baselineMode: 'record' | 'compare';
  strictWitnessObservationRefs: boolean;
  ok: boolean;
  findingCount: number;
  assertions: Gate6AssertionResult[];
  observed: Gate6WorkspaceObservation[];
  /** The digests OBSERVED this run — written out as the baseline in record mode. */
  baseline: Gate6Baseline;
}

export interface Gate6AuditOptions {
  uids: Gate6UidMap;
  nowMs: number;
  /** `null` records the observed digests; a value compares against them. */
  baseline?: Gate6Baseline | null;
  strictWitnessObservationRefs?: boolean;
}

const digestEntrySchema = z.object({
  count: z.number().int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  keys: z.array(z.string()),
});

const gate6BaselineSchema = z.object({
  baselineVersion: z.literal(1),
  expectationTableVersion: z.string().min(1),
  recordedAtMs: z.number().int(),
  targetUids: z.object({
    hbox: z.string().min(1),
    mkleo: z.string().min(1),
    sparg0: z.string().min(1),
    izaw: z.string().min(1),
  }),
  sparg0UserOwnedVod: digestEntrySchema,
  registryForeign: z.object({
    hbox: digestEntrySchema,
    mkleo: digestEntrySchema,
    sparg0: digestEntrySchema,
    izaw: digestEntrySchema,
  }),
});

/**
 * STRICT parse of a baseline file. A malformed baseline THROWS rather than
 * being coerced or skipped: silently degrading to record mode is the exact
 * false-green ("no baseline, so nothing to compare, so pass") this oracle
 * exists to remove.
 */
export function parseGate6Baseline(value: unknown): Gate6Baseline {
  const parsed = gate6BaselineSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid Gate 6 baseline file: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Raw-read helpers — deliberately schema-blind
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readRaw(database: Database, path: string): Promise<unknown> {
  const snapshot = await database.ref(path).get();
  return snapshot.exists() ? snapshot.val() : null;
}

/** One level of children as `[key, value]` pairs; a missing or non-object node is an empty list. */
async function readChildren(database: Database, path: string): Promise<[string, unknown][]> {
  const raw = await readRaw(database, path);
  return isPlainRecord(raw) ? Object.entries(raw) : [];
}

function rawString(record: Record<string, unknown>, member: string): string | null {
  const value = record[member];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Deterministic canonical JSON — object keys sorted recursively, array order preserved. Mirrors `registryManifestArtifact.ts`'s `canonicalize`. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Every string value anywhere inside a JSON value — the deep scan the zero-trace assertion uses. */
function collectStrings(value: unknown, sink: string[]): void {
  if (typeof value === 'string') {
    sink.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, sink);
    }
    return;
  }
  if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) {
      collectStrings(entry, sink);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-workspace corpus snapshot
// ---------------------------------------------------------------------------

interface WorkspaceCorpus {
  workspace: Gate6WorkspaceKey;
  uid: string;
  matchKeys: string[];
  matchRows: Map<string, unknown>;
  observations: [string, unknown][];
  receipts: [string, unknown][];
  /** Flattened `{targetSetId}/{observationId}` attachment children. */
  attachments: { targetSetId: string; observationId: string; value: unknown }[];
  witnesses: [string, unknown][];
  tournamentEntries: [string, unknown][];
  enrichmentRunRaw: unknown;
  ingestionRunRaw: unknown;
  startggLinkRaw: unknown;
}

async function loadWorkspaceCorpus(
  database: Database,
  workspace: Gate6WorkspaceKey,
  uid: string,
): Promise<WorkspaceCorpus> {
  const matchEntries = await readChildren(database, `matches/${uid}`);
  const attachmentTree = await readRaw(database, `researchEnrichmentAttachments/${uid}`);
  const attachments: WorkspaceCorpus['attachments'] = [];
  if (isPlainRecord(attachmentTree)) {
    for (const [targetSetId, children] of Object.entries(attachmentTree)) {
      if (!isPlainRecord(children)) {
        continue;
      }
      for (const [observationId, value] of Object.entries(children)) {
        attachments.push({ targetSetId, observationId, value });
      }
    }
  }

  return {
    workspace,
    uid,
    matchKeys: matchEntries.map(([key]) => key),
    matchRows: new Map(matchEntries),
    observations: await readChildren(database, `researchEnrichmentObservations/${uid}`),
    receipts: await readChildren(database, `researchEnrichmentReceipts/${uid}`),
    attachments,
    witnesses: await readChildren(database, `researchEnrichmentProjection/${uid}`),
    tournamentEntries: await readChildren(database, `tournamentEntries/${uid}`),
    enrichmentRunRaw: await readRaw(database, `researchEnrichmentRuns/${uid}`),
    ingestionRunRaw: await readRaw(database, `researchIngestionRuns/${uid}`),
    startggLinkRaw: await readRaw(database, `startggLinks/${uid}`),
  };
}

/**
 * A projection witness carrying COMMITTED character evidence. Keyed on
 * `charsObservationId` because that member is written by every chars commit
 * and nulled (therefore, under RTDB null-stripping, removed) by every chars
 * clear — the exact committed/not-committed discriminator. Read raw so a
 * schema-invalid witness is still counted; validity is a separate assertion.
 */
function isCharacterWitness(value: unknown): boolean {
  return isPlainRecord(value) && rawString(value, 'charsObservationId') !== null;
}

/** The stocks analog of {@link isCharacterWitness}. */
function isStockWitness(value: unknown): boolean {
  return isPlainRecord(value) && rawString(value, 'stocksObservationId') !== null;
}

// ---------------------------------------------------------------------------
// Assertion builders
// ---------------------------------------------------------------------------

interface AssertionDraft {
  id: Gate6AssertionId;
  title: string;
  tolerated?: boolean;
  inspected: number;
  findings: Gate6Finding[];
}

function finish(draft: AssertionDraft, strict: boolean): Gate6AssertionResult {
  const tolerated = draft.tolerated === true && !strict;
  return {
    id: draft.id,
    title: draft.title,
    ok: tolerated || draft.findings.length === 0,
    tolerated,
    inspected: draft.inspected,
    findings: draft.findings,
  };
}

function compareCount(
  findings: Gate6Finding[],
  workspace: Gate6WorkspaceKey,
  metric: string,
  expected: number | null,
  actual: number,
): void {
  if (expected === null || expected === actual) {
    return;
  }
  findings.push({
    code: 'count-mismatch',
    workspace,
    detail: `${metric}: expected ${expected}, observed ${actual}`,
    expected,
    actual,
  });
}

/** Assertion 1 — the expectation table, exactly. */
function assertExpectedCounts(corpora: WorkspaceCorpus[]): AssertionDraft {
  const findings: Gate6Finding[] = [];
  let inspected = 0;
  for (const corpus of corpora) {
    const expectation = GATE6_EXPECTATIONS[corpus.workspace];
    const characterWitnesses = corpus.witnesses.filter(([, value]) =>
      isCharacterWitness(value),
    ).length;
    const stockWitnesses = corpus.witnesses.filter(([, value]) => isStockWitness(value)).length;
    compareCount(
      findings,
      corpus.workspace,
      'matches',
      expectation.matches,
      corpus.matchKeys.length,
    );
    compareCount(
      findings,
      corpus.workspace,
      'observations',
      expectation.observations,
      corpus.observations.length,
    );
    compareCount(
      findings,
      corpus.workspace,
      'receipts',
      expectation.receipts,
      corpus.receipts.length,
    );
    compareCount(
      findings,
      corpus.workspace,
      'attachments',
      expectation.attachments,
      corpus.attachments.length,
    );
    compareCount(
      findings,
      corpus.workspace,
      'characterWitnesses',
      expectation.characterWitnesses,
      characterWitnesses,
    );
    compareCount(
      findings,
      corpus.workspace,
      'stockWitnesses',
      expectation.stockWitnesses,
      stockWitnesses,
    );
    inspected += 6;
  }
  return {
    id: 'expected-counts',
    title: 'The four expectation-table rows hold exactly',
    inspected,
    findings,
  };
}

/**
 * Assertion 2 — every relevant run terminal.
 *
 * THE SHAPE THE REJECTED PROBE GOT WRONG. `researchEnrichmentRuns/{uid}` is
 * ONE record with `status`/`lease`/`leaseFenceCounter` as its own members;
 * `researchIngestionRuns/{uid}` is the `{ activeRunId, runs }` WRAPPER whose
 * statuses live one level down under `runs/{runId}`. Both are checked, each
 * through its own reader.
 */
function assertRunsTerminal(corpora: WorkspaceCorpus[]): AssertionDraft {
  const findings: Gate6Finding[] = [];
  let inspected = 0;

  for (const corpus of corpora) {
    if (corpus.enrichmentRunRaw !== null) {
      inspected += 1;
      const parsed = researchEnrichmentRunRecordSchema.safeParse(corpus.enrichmentRunRaw);
      if (!parsed.success) {
        findings.push({
          code: 'run-record-unparseable',
          workspace: corpus.workspace,
          detail: 'the stored enrichment run record does not parse under its current schema',
          path: `researchEnrichmentRuns/${corpus.uid}`,
        });
      } else if (parsed.data.status === 'running') {
        findings.push({
          code: 'run-not-terminal',
          workspace: corpus.workspace,
          detail: `enrichment run ${parsed.data.runId} is still running`,
          expected: 'completed|failed',
          actual: parsed.data.status,
          path: `researchEnrichmentRuns/${corpus.uid}`,
        });
      }
    }

    if (corpus.ingestionRunRaw !== null) {
      const parsed = researchTenantIngestionStateSchema.safeParse(corpus.ingestionRunRaw);
      if (!parsed.success) {
        inspected += 1;
        findings.push({
          code: 'run-record-unparseable',
          workspace: corpus.workspace,
          detail: 'the stored ingestion run state does not parse under its current schema',
          path: `researchIngestionRuns/${corpus.uid}`,
        });
      } else {
        for (const [runId, run] of Object.entries(parsed.data.runs ?? {})) {
          inspected += 1;
          if (run.status === 'running') {
            findings.push({
              code: 'run-not-terminal',
              workspace: corpus.workspace,
              detail: `ingestion run ${runId} is still running`,
              expected: 'completed|failed',
              actual: run.status,
              path: `researchIngestionRuns/${corpus.uid}/runs/${runId}`,
            });
          }
        }
      }
    }
  }

  return {
    id: 'runs-terminal',
    title: 'Every enrichment and ingestion run record is terminal',
    inspected,
    findings,
  };
}

/** Assertion 3 — zero ACTIVE leases: an unexpired lease on a `running` record. */
function assertNoActiveLeases(corpora: WorkspaceCorpus[], nowMs: number): AssertionDraft {
  const findings: Gate6Finding[] = [];
  let inspected = 0;

  for (const corpus of corpora) {
    const enrichment = researchEnrichmentRunRecordSchema.safeParse(corpus.enrichmentRunRaw);
    if (enrichment.success) {
      inspected += 1;
      const lease = enrichment.data.lease;
      if (enrichment.data.status === 'running' && lease && lease.expiresAtMs > nowMs) {
        findings.push({
          code: 'active-lease',
          workspace: corpus.workspace,
          detail: `enrichment run ${enrichment.data.runId} holds an unexpired lease (fence ${lease.fence}, expires ${lease.expiresAtMs})`,
          actual: lease.expiresAtMs,
          path: `researchEnrichmentRuns/${corpus.uid}/lease`,
        });
      }
    }

    const ingestion = researchTenantIngestionStateSchema.safeParse(corpus.ingestionRunRaw);
    if (ingestion.success) {
      for (const [runId, run] of Object.entries(ingestion.data.runs ?? {})) {
        inspected += 1;
        if (run.status === 'running' && run.lease && run.lease.expiresAtMs > nowMs) {
          findings.push({
            code: 'active-lease',
            workspace: corpus.workspace,
            detail: `ingestion run ${runId} holds an unexpired lease (expires ${run.lease.expiresAtMs})`,
            actual: run.lease.expiresAtMs,
            path: `researchIngestionRuns/${corpus.uid}/runs/${runId}/lease`,
          });
        }
      }
    }
  }

  return {
    id: 'no-active-leases',
    title: 'No running run record holds an unexpired lease',
    inspected,
    findings,
  };
}

/**
 * Assertion 4 — zero schema failures.
 *
 * The pipeline's own readers `safeParse`-and-SKIP, so an invalid record is
 * invisible to them. This assertion is the only place the corpus is required
 * to be VALID rather than merely present.
 */
function assertSchemaConformance(corpora: WorkspaceCorpus[]): AssertionDraft {
  const findings: Gate6Finding[] = [];
  let inspected = 0;

  for (const corpus of corpora) {
    for (const [key, value] of corpus.observations) {
      inspected += 1;
      if (!researchEnrichmentObservationRecordSchema.safeParse(value).success) {
        findings.push({
          code: 'schema-invalid-observation',
          workspace: corpus.workspace,
          detail: `observation ${key} fails researchEnrichmentObservationRecordSchema`,
          path: `researchEnrichmentObservations/${corpus.uid}/${key}`,
        });
      }
    }
    for (const [key, value] of corpus.receipts) {
      inspected += 1;
      if (!researchEnrichmentResolutionReceiptRecordSchema.safeParse(value).success) {
        findings.push({
          code: 'schema-invalid-receipt',
          workspace: corpus.workspace,
          detail: `receipt ${key} fails researchEnrichmentResolutionReceiptRecordSchema`,
          path: `researchEnrichmentReceipts/${corpus.uid}/${key}`,
        });
      }
    }
    for (const attachment of corpus.attachments) {
      inspected += 1;
      if (!researchEnrichmentAttachmentRecordSchema.safeParse(attachment.value).success) {
        findings.push({
          code: 'schema-invalid-attachment',
          workspace: corpus.workspace,
          detail: `attachment ${attachment.targetSetId}/${attachment.observationId} fails researchEnrichmentAttachmentRecordSchema`,
          path: `researchEnrichmentAttachments/${corpus.uid}/${attachment.targetSetId}/${attachment.observationId}`,
        });
      }
    }
    for (const [key, value] of corpus.witnesses) {
      inspected += 1;
      if (!researchEnrichmentProjectionStateRecordSchema.safeParse(value).success) {
        findings.push({
          code: 'schema-invalid-witness',
          workspace: corpus.workspace,
          detail: `projection witness ${key} fails researchEnrichmentProjectionStateRecordSchema`,
          path: `researchEnrichmentProjection/${corpus.uid}/${key}`,
        });
      }
    }
  }

  return {
    id: 'schema-conformance',
    title:
      'Every stored observation, receipt, attachment and witness parses under its current schema',
    inspected,
    findings,
  };
}

/** Mirrors `deriveEnrichmentMatchRowKey` in the applier — do not invent a second key shape. */
function enrichmentRowKeyPrefix(targetSetId: string): string {
  return `sgg-${targetSetId}-g`;
}

/**
 * Assertion 5 — attachment referential integrity, in BOTH directions.
 *
 * Forward, per attachment: the observation exists; a `resolver` attachment's
 * receipt exists, is parseable, and agrees on both `receiptId` and
 * `targetSetId`; the target set has at least one real match row; and at least
 * one projection witness names that target set.
 *
 * Reverse: every receipt has an observation, and every witness that carries a
 * claim has both a real match row and (unless its claim came from a confirmed
 * VOD candidate, which needs no attachment — the applier's priority-5 merge)
 * an attachment for its target set.
 */
function assertAttachmentIntegrity(corpora: WorkspaceCorpus[]): AssertionDraft {
  const findings: Gate6Finding[] = [];
  let inspected = 0;

  for (const corpus of corpora) {
    const observationsById = new Map(corpus.observations);
    const observationIds = new Set(observationsById.keys());
    const receiptsById = new Map(corpus.receipts);
    const attachedTargetSets = new Set(corpus.attachments.map((entry) => entry.targetSetId));
    const witnessTargetSets = new Set<string>();
    for (const [, value] of corpus.witnesses) {
      if (isPlainRecord(value)) {
        const targetSetId = rawString(value, 'targetSetId');
        if (targetSetId !== null) {
          witnessTargetSets.add(targetSetId);
        }
      }
    }

    for (const attachment of corpus.attachments) {
      inspected += 1;
      const label = `${attachment.targetSetId}/${attachment.observationId}`;
      const path = `researchEnrichmentAttachments/${corpus.uid}/${label}`;

      if (!observationIds.has(attachment.observationId)) {
        findings.push({
          code: 'attachment-dangling-observation',
          workspace: corpus.workspace,
          detail: `attachment ${label} names an observation that does not exist`,
          path,
        });
      }

      const parsed = researchEnrichmentAttachmentRecordSchema.safeParse(attachment.value);
      if (parsed.success && parsed.data.attachmentSource === 'resolver') {
        const rawReceipt = receiptsById.get(attachment.observationId);
        const receipt =
          rawReceipt === undefined
            ? null
            : researchEnrichmentResolutionReceiptRecordSchema.safeParse(rawReceipt);
        if (receipt === null || !receipt.success) {
          findings.push({
            code: 'attachment-dangling-receipt',
            workspace: corpus.workspace,
            detail: `resolver attachment ${label} has no parseable receipt at researchEnrichmentReceipts/${corpus.uid}/${attachment.observationId}`,
            path,
          });
        } else {
          if (receipt.data.receiptId !== parsed.data.receiptId) {
            findings.push({
              code: 'attachment-receipt-id-mismatch',
              workspace: corpus.workspace,
              detail: `resolver attachment ${label} cites a receiptId the stored receipt does not carry`,
              expected: receipt.data.receiptId,
              actual: parsed.data.receiptId ?? null,
              path,
            });
          }
          if (receipt.data.targetSetId !== attachment.targetSetId) {
            findings.push({
              code: 'attachment-receipt-target-mismatch',
              workspace: corpus.workspace,
              detail: `resolver attachment ${label} is filed under a target set its receipt does not name`,
              expected: receipt.data.targetSetId,
              actual: attachment.targetSetId,
              path,
            });
          }
        }
      }

      // The store's own barrier condition, re-checked at rest: both the
      // attachment and its receipt copy the observation's fingerprint at
      // write time (`attachResolvedObservation`), so a surviving attachment
      // whose fingerprint no longer matches the STORED observation means the
      // observation was replaced (a parser re-key) without the attachment
      // being re-derived — a stale authorization, invisible to a count.
      const rawObservation = observationsById.get(attachment.observationId);
      if (parsed.success && rawObservation !== undefined) {
        const observation = researchEnrichmentObservationRecordSchema.safeParse(rawObservation);
        if (
          observation.success &&
          (observation.data.sourceRevisionId !== parsed.data.sourceRevisionId ||
            observation.data.sourceContentHash !== parsed.data.sourceContentHash ||
            observation.data.parserVersion !== parsed.data.parserVersion)
        ) {
          findings.push({
            code: 'attachment-observation-fingerprint-mismatch',
            workspace: corpus.workspace,
            detail: `attachment ${label} carries a fingerprint the stored observation no longer matches`,
            expected: `${observation.data.sourceRevisionId}/${observation.data.parserVersion}`,
            actual: `${parsed.data.sourceRevisionId}/${parsed.data.parserVersion}`,
            path,
          });
        }
      }

      const prefix = enrichmentRowKeyPrefix(attachment.targetSetId);
      if (!corpus.matchKeys.some((key) => key.startsWith(prefix))) {
        findings.push({
          code: 'attachment-dangling-target-set',
          workspace: corpus.workspace,
          detail: `attachment ${label} names a target set with no match row under matches/${corpus.uid}`,
          expected: `${prefix}<ordinal>`,
          path,
        });
      }

      if (!witnessTargetSets.has(attachment.targetSetId)) {
        findings.push({
          code: 'attachment-missing-projection-witness',
          workspace: corpus.workspace,
          detail: `attachment ${label} has no projection witness naming its target set`,
          path,
        });
      }
    }

    for (const [observationId] of corpus.receipts) {
      inspected += 1;
      if (!observationIds.has(observationId)) {
        findings.push({
          code: 'receipt-dangling-observation',
          workspace: corpus.workspace,
          detail: `receipt ${observationId} names an observation that does not exist`,
          path: `researchEnrichmentReceipts/${corpus.uid}/${observationId}`,
        });
      }
    }

    for (const [matchKey, value] of corpus.witnesses) {
      if (!isPlainRecord(value)) {
        continue;
      }
      const carriesClaim =
        rawString(value, 'projectedVodUrl') !== null ||
        rawString(value, 'pendingVodUrl') !== null ||
        value['projectedStageId'] != null ||
        rawString(value, 'projectedStageRaw') !== null ||
        value['projectedStocksLeft'] != null ||
        rawString(value, 'charsObservationId') !== null;
      if (!carriesClaim) {
        continue;
      }
      inspected += 1;
      const path = `researchEnrichmentProjection/${corpus.uid}/${matchKey}`;

      if (!corpus.matchRows.has(matchKey)) {
        findings.push({
          code: 'witness-dangling-match-row',
          workspace: corpus.workspace,
          detail: `projection witness ${matchKey} vouches for a match row that does not exist`,
          path,
        });
      }

      const targetSetId = rawString(value, 'targetSetId');
      const candidateSourced =
        rawString(value, 'vodCandidateId') !== null ||
        rawString(value, 'pendingVodCandidateId') !== null;
      if (targetSetId !== null && !candidateSourced && !attachedTargetSets.has(targetSetId)) {
        findings.push({
          code: 'witness-orphan-target-set',
          workspace: corpus.workspace,
          detail: `projection witness ${matchKey} claims target set ${targetSetId}, which has no attachment`,
          path,
        });
      }
    }
  }

  return {
    id: 'attachment-integrity',
    title:
      'Attachments, receipts, target sets, match rows and witnesses resolve in both directions',
    inspected,
    findings,
  };
}

/**
 * Assertion 11 — witness observation back-references.
 *
 * TOLERATED BY DEFAULT, and this is a deliberate, documented deviation from
 * the brief's blanket "no dangling references in any direction". The shipped
 * `removeSupersededObservations` in `apps/api/src/research/enrichment/store.ts`
 * states the opposite contract explicitly: "Projection WITNESSES that
 * reference a removed observation id are deliberately left in place: the
 * attribution schema tolerates a missing referenced observation, and the
 * witness's value-comparison ownership rule keeps a dangling reference
 * inert." Failing on these would make the oracle red on a corpus the pipeline
 * considers correct — a false RED is as disqualifying for an acceptance
 * oracle as a false green. They are therefore counted and reported in every
 * receipt, and `--strict-witness-observation-refs` promotes them to failures
 * if the owner decides the tighter contract is the intended one.
 */
function assertWitnessObservationReferences(corpora: WorkspaceCorpus[]): AssertionDraft {
  const findings: Gate6Finding[] = [];
  let inspected = 0;
  const members = [
    'vodObservationId',
    'stageObservationId',
    'charsObservationId',
    'stocksObservationId',
    'pendingVodObservationId',
    'pendingStageObservationId',
    'pendingStocksObservationId',
  ] as const;

  for (const corpus of corpora) {
    const observationIds = new Set(corpus.observations.map(([key]) => key));
    for (const [matchKey, value] of corpus.witnesses) {
      if (!isPlainRecord(value)) {
        continue;
      }
      for (const member of members) {
        const referenced = rawString(value, member);
        if (referenced === null) {
          continue;
        }
        inspected += 1;
        if (!observationIds.has(referenced)) {
          findings.push({
            code: 'witness-dangling-observation-reference',
            workspace: corpus.workspace,
            detail: `projection witness ${matchKey}.${member} names observation ${referenced}, which does not exist`,
            path: `researchEnrichmentProjection/${corpus.uid}/${matchKey}/${member}`,
          });
        }
      }
    }
  }

  return {
    id: 'witness-observation-references',
    title:
      'Projection witnesses reference existing observations (tolerated: the applier documents dangling references as inert)',
    tolerated: true,
    inspected,
    findings,
  };
}

/** Assertion 6 — no `startggLinks` fabricated on any demo uid. */
function assertNoStartggLinks(corpora: WorkspaceCorpus[]): AssertionDraft {
  const findings: Gate6Finding[] = [];
  for (const corpus of corpora) {
    if (corpus.startggLinkRaw !== null) {
      findings.push({
        code: 'startgg-link-present',
        workspace: corpus.workspace,
        detail: `startggLinks/${corpus.uid} exists; the demo pipeline must never create one`,
        expected: 'absent',
        actual: 'present',
        path: `startggLinks/${corpus.uid}`,
      });
    }
  }
  return {
    id: 'no-startgg-links',
    title: 'No startggLinks record exists on any of the four demo UIDs',
    inspected: corpora.length,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Digest assertions (7 and 8)
// ---------------------------------------------------------------------------

/**
 * The user-entered VOD rows on a workspace: a non-empty stored `vodUrl` that
 * the row's own projection witness does NOT vouch for, decided by the SHARED
 * `isSourceOwnedVodValue` (committed ∪ pending accepted set) rather than by a
 * second, divergent local rule. The witness members are read RAW so that a
 * schema-invalid witness cannot silently reclassify a source-owned URL as
 * user-owned (which would mask a real overwrite behind a changed digest, or
 * worse, hide one behind an unchanged one).
 */
function collectUserOwnedVodRows(corpus: WorkspaceCorpus): { key: string; vodUrl: string }[] {
  const witnessByKey = new Map(corpus.witnesses);
  const rows: { key: string; vodUrl: string }[] = [];
  for (const [key, row] of corpus.matchRows) {
    if (!isPlainRecord(row)) {
      continue;
    }
    const vodUrl = rawString(row, 'vodUrl');
    if (vodUrl === null) {
      continue;
    }
    const rawWitness = witnessByKey.get(key);
    const witness = isPlainRecord(rawWitness)
      ? {
          projectedVodUrl: rawString(rawWitness, 'projectedVodUrl') ?? undefined,
          pendingVodUrl: rawString(rawWitness, 'pendingVodUrl') ?? undefined,
        }
      : null;
    if (!isSourceOwnedVodValue(vodUrl, witness)) {
      rows.push({ key, vodUrl });
    }
  }
  return rows.sort((left, right) => left.key.localeCompare(right.key));
}

function digestOf(entries: { key: string; payload: unknown }[]): Gate6DigestEntry {
  const sorted = [...entries].sort((left, right) => left.key.localeCompare(right.key));
  return {
    count: sorted.length,
    digest: sha256(canonicalize(sorted.map(({ key, payload }) => ({ key, payload })))),
    keys: sorted.map(({ key }) => key),
  };
}

function compareDigest(
  findings: Gate6Finding[],
  workspace: Gate6WorkspaceKey | null,
  label: string,
  expected: Gate6DigestEntry | undefined,
  actual: Gate6DigestEntry,
): void {
  if (expected === undefined) {
    findings.push({
      code: 'baseline-entry-missing',
      workspace,
      detail: `${label}: the supplied baseline has no entry to compare against`,
    });
    return;
  }
  if (expected.digest === actual.digest && expected.count === actual.count) {
    return;
  }
  const expectedKeys = new Set(expected.keys);
  const actualKeys = new Set(actual.keys);
  const removed = expected.keys.filter((key) => !actualKeys.has(key));
  const added = actual.keys.filter((key) => !expectedKeys.has(key));
  const mutated =
    removed.length === 0 && added.length === 0 ? ' (same keys — a stored value changed)' : '';
  findings.push({
    code: 'digest-drift',
    workspace,
    detail: `${label}: digest drifted${mutated}${removed.length > 0 ? `; removed: ${removed.join(', ')}` : ''}${added.length > 0 ? `; added: ${added.join(', ')}` : ''}`,
    expected: expected.digest,
    actual: actual.digest,
  });
}

/** Assertion 7 — the protected Sparg0 user-entered VOD rows are byte-identical. */
function assertSparg0VodPreservation(
  sparg0: WorkspaceCorpus,
  observedDigest: Gate6DigestEntry,
  baseline: Gate6Baseline | null,
): AssertionDraft {
  const findings: Gate6Finding[] = [];

  if (observedDigest.count !== GATE6_SPARG0_USER_OWNED_VOD_ROWS) {
    findings.push({
      code: 'protected-vod-count-mismatch',
      workspace: 'sparg0',
      detail: `user-entered VOD rows: expected ${GATE6_SPARG0_USER_OWNED_VOD_ROWS}, observed ${observedDigest.count}`,
      expected: GATE6_SPARG0_USER_OWNED_VOD_ROWS,
      actual: observedDigest.count,
      path: `matches/${sparg0.uid}`,
    });
  }
  if (baseline !== null) {
    compareDigest(
      findings,
      'sparg0',
      'Sparg0 user-entered VOD rows',
      baseline.sparg0UserOwnedVod,
      observedDigest,
    );
  }

  return {
    id: 'sparg0-vod-preservation',
    title: 'The protected Sparg0 user-entered VOD rows are byte-identical',
    inspected: observedDigest.count,
    findings,
  };
}

/**
 * Assertion 8 — registry preservation.
 *
 * `preservedForeignCount` alone is explicitly insufficient (a swap of one
 * foreign row for another keeps the count identical), so this compares a
 * canonical digest over the FULL stored value of every non-witness-owned
 * `tournamentEntries` child — the manual, start.gg-synced and parry.gg-synced
 * rows the projector must never touch. Ownership is decided by the shared
 * `isTournamentRegistryOwnedRow`, the same predicate the projector itself
 * uses, so the two can never disagree about what "foreign" means.
 */
function assertRegistryPreservation(
  observed: Record<Gate6WorkspaceKey, Gate6DigestEntry>,
  baseline: Gate6Baseline | null,
): AssertionDraft {
  const findings: Gate6Finding[] = [];
  let inspected = 0;
  for (const workspace of GATE6_WORKSPACE_KEYS) {
    const entry = observed[workspace];
    inspected += entry.count;
    if (baseline !== null) {
      compareDigest(
        findings,
        workspace,
        `${GATE6_EXPECTATIONS[workspace].label} foreign tournamentEntries`,
        baseline.registryForeign[workspace],
        entry,
      );
    }
  }
  return {
    id: 'registry-preservation',
    title: 'Foreign, manual and provider-linked tournamentEntries children are byte-identical',
    inspected,
    findings,
  };
}

/**
 * Assertion 9 — IzAw's coaching ownership root is his OWN uid.
 *
 * Stated WITHOUT naming a developer uid, so the check cannot be defeated by
 * the developer's uid changing or by guessing the wrong one: for every tenant
 * IzAw is a custodian of, `coachClients/{izawUid}/{tenantId}` must exist and
 * NO other uid's `coachClients` subtree may hold that tenant. This is exactly
 * the structural property `coachingRoot.test.ts` proves of `createClientCore`,
 * asserted against the stored tree instead of a fresh call.
 */
async function assertIzawCoachingRoot(
  database: Database,
  izawUid: string,
): Promise<AssertionDraft> {
  const findings: Gate6Finding[] = [];
  const memberTrees = await readChildren(database, 'clientMembers');
  const izawTenants: string[] = [];
  for (const [tenantId, members] of memberTrees) {
    if (!isPlainRecord(members)) {
      continue;
    }
    const membership = members[izawUid];
    if (isPlainRecord(membership) && rawString(membership, 'role') === 'custodian') {
      izawTenants.push(tenantId);
    }
  }

  const coachClients = await readChildren(database, 'coachClients');
  for (const tenantId of izawTenants) {
    const ownRoot = await readRaw(database, `coachClients/${izawUid}/${tenantId}`);
    if (ownRoot === null) {
      findings.push({
        code: 'coaching-root-missing',
        workspace: 'izaw',
        detail: `IzAw is custodian of tenant ${tenantId} but coachClients/${izawUid}/${tenantId} does not exist`,
        path: `coachClients/${izawUid}/${tenantId}`,
      });
    }
    for (const [ownerUid, tenants] of coachClients) {
      if (ownerUid === izawUid || !isPlainRecord(tenants)) {
        continue;
      }
      if (tenants[tenantId] !== undefined) {
        findings.push({
          code: 'coaching-root-foreign-owner',
          workspace: 'izaw',
          detail: `tenant ${tenantId} (IzAw custodian) is also rooted under coachClients/${ownerUid}`,
          expected: izawUid,
          actual: ownerUid,
          path: `coachClients/${ownerUid}/${tenantId}`,
        });
      }
    }
  }

  return {
    id: 'izaw-coaching-root',
    title: "IzAw's coaching structures are rooted under his own uid, never another coach tree",
    inspected: izawTenants.length,
    findings,
  };
}

/**
 * Assertion 10 — rejected operations left no analytics, ledger, credit, job
 * or token trace.
 *
 * The uid-keyed trees are read directly. The day-sharded and causation-keyed
 * trees do not key on uid at all, so they are scanned: an `eventLedger` record
 * is attributable when the demo uid appears as ANY string value anywhere
 * inside it (`actorId` is the usual carrier, but a payload member would be a
 * trace too), an `eventDedup` causation key is attributable when it contains
 * the uid as a substring (causation ids are built as `${uid}:${...}`), and an
 * `outboxPending` entry is attributable when it sits at the same `{day}/{key}`
 * as an attributable ledger row — the two are written in one multi-path
 * update, so that pairing is exact.
 */
async function assertZeroTraceTrees(
  database: Database,
  uids: Gate6UidMap,
): Promise<AssertionDraft> {
  const findings: Gate6Finding[] = [];
  let inspected = 0;
  const uidByValue = new Map<string, Gate6WorkspaceKey>();
  for (const workspace of GATE6_WORKSPACE_KEYS) {
    uidByValue.set(uids[workspace], workspace);
  }

  for (const workspace of GATE6_WORKSPACE_KEYS) {
    const uid = uids[workspace];
    for (const tree of ['creditLedger', 'credits', 'reportJobs'] as const) {
      inspected += 1;
      if ((await readRaw(database, `${tree}/${uid}`)) !== null) {
        findings.push({
          code: 'zero-trace-violation',
          workspace,
          detail: `${tree}/${uid} holds data; a rejected research operation must leave none`,
          expected: 'absent',
          actual: 'present',
          path: `${tree}/${uid}`,
        });
      }
    }
    for (const [status, byUid] of await readChildren(database, 'reportJobsByStatus')) {
      inspected += 1;
      if (isPlainRecord(byUid) && byUid[uid] !== undefined) {
        findings.push({
          code: 'zero-trace-violation',
          workspace,
          detail: `reportJobsByStatus/${status}/${uid} holds data`,
          expected: 'absent',
          actual: 'present',
          path: `reportJobsByStatus/${status}/${uid}`,
        });
      }
    }
  }

  for (const [token, value] of await readChildren(database, 'shareTokens')) {
    inspected += 1;
    if (!isPlainRecord(value)) {
      continue;
    }
    const ownerUid = rawString(value, 'ownerUid');
    const workspace = ownerUid === null ? undefined : uidByValue.get(ownerUid);
    if (workspace !== undefined) {
      findings.push({
        code: 'zero-trace-violation',
        workspace,
        detail: `shareTokens/${token} is owned by a demo uid; no bearer token may ever be minted for one`,
        expected: 'absent',
        actual: 'present',
        path: `shareTokens/${token}`,
      });
    }
  }

  const attributableLedgerPaths = new Set<string>();
  for (const [day, rows] of await readChildren(database, 'eventLedger')) {
    if (!isPlainRecord(rows)) {
      continue;
    }
    for (const [key, record] of Object.entries(rows)) {
      inspected += 1;
      const strings: string[] = [];
      collectStrings(record, strings);
      for (const candidate of strings) {
        const workspace = uidByValue.get(candidate);
        if (workspace !== undefined) {
          attributableLedgerPaths.add(`${day}/${key}`);
          findings.push({
            code: 'zero-trace-violation',
            workspace,
            detail: `eventLedger/${day}/${key} references a demo uid`,
            expected: 'absent',
            actual: 'present',
            path: `eventLedger/${day}/${key}`,
          });
          break;
        }
      }
    }
  }

  for (const [day, rows] of await readChildren(database, 'outboxPending')) {
    if (!isPlainRecord(rows)) {
      continue;
    }
    for (const key of Object.keys(rows)) {
      inspected += 1;
      if (attributableLedgerPaths.has(`${day}/${key}`)) {
        findings.push({
          code: 'zero-trace-violation',
          workspace: null,
          detail: `outboxPending/${day}/${key} pairs with a demo-attributable eventLedger row`,
          expected: 'absent',
          actual: 'present',
          path: `outboxPending/${day}/${key}`,
        });
      }
    }
  }

  for (const [eventName, byVersion] of await readChildren(database, 'eventDedup')) {
    if (!isPlainRecord(byVersion)) {
      continue;
    }
    for (const [version, byCausation] of Object.entries(byVersion)) {
      if (!isPlainRecord(byCausation)) {
        continue;
      }
      for (const causationId of Object.keys(byCausation)) {
        inspected += 1;
        for (const workspace of GATE6_WORKSPACE_KEYS) {
          if (causationId.includes(uids[workspace])) {
            findings.push({
              code: 'zero-trace-violation',
              workspace,
              detail: `eventDedup/${eventName}/${version}/${causationId} carries a demo uid in its causation id`,
              expected: 'absent',
              actual: 'present',
              path: `eventDedup/${eventName}/${version}/${causationId}`,
            });
            break;
          }
        }
      }
    }
  }

  return {
    id: 'zero-trace-trees',
    title: 'No analytics, ledger, credit, job or bearer-token row exists for any demo uid',
    inspected,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function assertBaselineApplies(baseline: Gate6Baseline, uids: Gate6UidMap): Gate6Finding[] {
  const findings: Gate6Finding[] = [];
  if (baseline.expectationTableVersion !== GATE6_EXPECTATION_TABLE_VERSION) {
    findings.push({
      code: 'baseline-table-version-mismatch',
      workspace: null,
      detail:
        'the supplied baseline was recorded against a different expectation-table version; re-record it',
      expected: GATE6_EXPECTATION_TABLE_VERSION,
      actual: baseline.expectationTableVersion,
    });
  }
  for (const workspace of GATE6_WORKSPACE_KEYS) {
    if (baseline.targetUids[workspace] !== uids[workspace]) {
      findings.push({
        code: 'baseline-uid-mismatch',
        workspace,
        detail: 'the supplied baseline was recorded against a different uid for this workspace',
        expected: baseline.targetUids[workspace],
        actual: uids[workspace],
      });
    }
  }
  return findings;
}

/**
 * Runs every Gate-6 assertion and returns the machine-readable receipt. Never
 * throws for a data condition — a data problem is a FINDING, so the caller
 * always gets a full receipt rather than a stack trace that hides the other
 * nine assertions. Only a programming/usage error (an unsafe uid) throws.
 */
export async function runGate6Audit(
  database: Database,
  options: Gate6AuditOptions,
): Promise<Gate6AuditReceipt> {
  for (const workspace of GATE6_WORKSPACE_KEYS) {
    const uid = options.uids[workspace];
    if (!uid || !isPathSafeTenantId(uid)) {
      throw new Error(`runGate6Audit: unsafe or missing uid for ${workspace}`);
    }
  }
  if (new Set(Object.values(options.uids)).size !== GATE6_WORKSPACE_KEYS.length) {
    throw new Error('runGate6Audit: every demo account UID must be unique');
  }

  const strict = options.strictWitnessObservationRefs === true;
  const baseline = options.baseline ?? null;

  const corpora: WorkspaceCorpus[] = [];
  for (const workspace of GATE6_WORKSPACE_KEYS) {
    corpora.push(await loadWorkspaceCorpus(database, workspace, options.uids[workspace]));
  }
  const byWorkspace = new Map(corpora.map((corpus) => [corpus.workspace, corpus]));
  const sparg0 = byWorkspace.get('sparg0')!;

  const sparg0Vod = digestOf(
    collectUserOwnedVodRows(sparg0).map((row) => ({ key: row.key, payload: row.vodUrl })),
  );
  const registryForeign = Object.fromEntries(
    corpora.map((corpus) => [
      corpus.workspace,
      digestOf(
        corpus.tournamentEntries
          .filter(([, value]) => !isTournamentRegistryOwnedRow(value))
          .map(([entryId, value]) => ({ key: entryId, payload: value })),
      ),
    ]),
  ) as Record<Gate6WorkspaceKey, Gate6DigestEntry>;

  const observedBaseline: Gate6Baseline = {
    baselineVersion: 1,
    expectationTableVersion: GATE6_EXPECTATION_TABLE_VERSION,
    recordedAtMs: options.nowMs,
    targetUids: { ...options.uids },
    sparg0UserOwnedVod: sparg0Vod,
    registryForeign,
  };

  const drafts: AssertionDraft[] = [
    assertExpectedCounts(corpora),
    assertRunsTerminal(corpora),
    assertNoActiveLeases(corpora, options.nowMs),
    assertSchemaConformance(corpora),
    assertAttachmentIntegrity(corpora),
    assertNoStartggLinks(corpora),
    assertSparg0VodPreservation(sparg0, sparg0Vod, baseline),
    assertRegistryPreservation(registryForeign, baseline),
    await assertIzawCoachingRoot(database, options.uids.izaw),
    await assertZeroTraceTrees(database, options.uids),
    assertWitnessObservationReferences(corpora),
  ];

  if (baseline !== null) {
    // A baseline that does not describe THIS corpus makes both digest
    // assertions meaningless, so the mismatch is reported on both of them
    // rather than passing quietly on a comparison that never ran.
    const applicability = assertBaselineApplies(baseline, options.uids);
    if (applicability.length > 0) {
      for (const draft of drafts) {
        if (draft.id === 'sparg0-vod-preservation' || draft.id === 'registry-preservation') {
          draft.findings.push(...applicability);
        }
      }
    }
  }

  const assertions = drafts.map((draft) => finish(draft, strict));
  const findingCount = assertions.reduce(
    (total, assertion) => total + (assertion.tolerated ? 0 : assertion.findings.length),
    0,
  );

  const observed: Gate6WorkspaceObservation[] = corpora.map((corpus) => {
    const enrichmentRun = researchEnrichmentRunRecordSchema.safeParse(corpus.enrichmentRunRaw);
    const ingestion = researchTenantIngestionStateSchema.safeParse(corpus.ingestionRunRaw);
    return {
      workspace: corpus.workspace,
      label: GATE6_EXPECTATIONS[corpus.workspace].label,
      uid: corpus.uid,
      matches: corpus.matchKeys.length,
      observations: corpus.observations.length,
      receipts: corpus.receipts.length,
      attachments: corpus.attachments.length,
      attachedTargetSets: new Set(corpus.attachments.map((entry) => entry.targetSetId)).size,
      projectionWitnesses: corpus.witnesses.length,
      characterWitnesses: corpus.witnesses.filter(([, value]) => isCharacterWitness(value)).length,
      stockWitnesses: corpus.witnesses.filter(([, value]) => isStockWitness(value)).length,
      tournamentEntries: corpus.tournamentEntries.length,
      tournamentEntriesForeign: registryForeign[corpus.workspace].count,
      enrichmentRunStatus: enrichmentRun.success ? enrichmentRun.data.status : null,
      ingestionRunStatuses: ingestion.success
        ? Object.values(ingestion.data.runs ?? {})
            .map((run) => run.status)
            .sort()
        : [],
    };
  });

  return {
    receiptVersion: 1,
    expectationTableVersion: GATE6_EXPECTATION_TABLE_VERSION,
    generatedAtMs: options.nowMs,
    targetUids: { ...options.uids },
    baselineMode: baseline === null ? 'record' : 'compare',
    strictWitnessObservationRefs: strict,
    ok: assertions.every((assertion) => assertion.ok),
    findingCount,
    assertions,
    observed,
    baseline: observedBaseline,
  };
}

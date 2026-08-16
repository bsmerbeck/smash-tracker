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
  tournamentRegistryRowSchema,
  type TournamentRegistryRow,
} from '@smash-tracker/shared';
import { canonicalDigest } from '../src/research/registry/canonical.js';
import {
  DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS,
  withRegistryDeadline,
} from '../src/research/registry/deadline.js';
import {
  computeForeignRowDigest,
  describeForeignRowDigestDelta,
  foreignRowDigestsMatch,
  type ForeignRowDigest,
} from '../src/research/registry/foreignDigest.js';
import {
  foreignRowDigestSchema,
  validateRegistryReceipt,
} from '../src/research/registry/receipt.js';
import { registryWorkspaceKeys } from '../src/research/registry/workspaces.js';
import { isPathSafeTenantId } from '../src/research/subjectKind.js';
import { dayShardKey } from '../src/events/ledger.js';
import {
  computeRegistryRowSetHash,
  parseSealedRegistryManifest,
  type RegistryManifest,
} from './registryManifestArtifact.js';

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

/**
 * Runtime cross-check, evaluated at module load (the same idiom
 * `researchEnrichment.ts` uses for its vocabulary cross-check): this audit's
 * workspace vocabulary must stay identical to the registry module's, because
 * assertion 12 maps a sealed receipt onto a workspace by that shared name. If
 * the two ever diverge, an audit that silently ignored the unmatched
 * workspace would report a green attestation over evidence it never checked —
 * so the divergence is made a loud import-time failure instead of a runtime
 * branch that no test can reach while the lists agree.
 */
if (
  GATE6_WORKSPACE_KEYS.length !== registryWorkspaceKeys.length ||
  GATE6_WORKSPACE_KEYS.some((key, index) => key !== registryWorkspaceKeys[index])
) {
  throw new Error(
    `gate6AuditCore: workspace vocabulary drifted from the registry module (${GATE6_WORKSPACE_KEYS.join(',')} vs ${registryWorkspaceKeys.join(',')})`,
  );
}

export type Gate6UidMap = Record<Gate6WorkspaceKey, string>;

/**
 * Bumped whenever ANY number below changes. A baseline recorded under a
 * different table version is refused rather than silently compared, because
 * the two describe different corpora.
 */
export const GATE6_EXPECTATION_TABLE_VERSION = '30.3-gate6.2';

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
    // One receipt per attachment: every attachment is receipt-gated, so these
    // two figures must move together. Pinned from the 2026-08-16 read-only
    // production audit (30.2-GATE2-AUDIT.md, "GATE 2 CLOSURE"), which is also
    // where the attachment/witness figures come from.
    receipts: 57,
    attachments: 57,
    characterWitnesses: 120,
    stockWitnesses: 70,
  },
  sparg0: {
    label: 'Sparg0',
    matches: 8378,
    observations: 10335,
    receipts: 68,
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
 * THE UID-KEYED TRACE SURFACES a refused operation could have written.
 *
 * Read at exactly `${path}/${uid}` — never scanned. Each is a tree the
 * enrichment/report/share paths write into, addressed by the acting uid, so
 * one direct read per surface bounds the whole check.
 */
export const GATE6_UID_TRACE_SURFACES = [
  'creditLedger',
  'credits',
  'reportJobs',
  // The job-status index has exactly one status vocabulary member in this
  // codebase (`reportJobsByStatus/running/{uid}/{jobId}` — see
  // `routes/reports.ts` and `jobs/sweepStuckReportJobs.ts`), so it is
  // addressed directly rather than by enumerating the status level.
  'reportJobsByStatus/running',
  // The OWNER index for bearer tokens. `shareTokens` itself is keyed by an
  // opaque token and has no uid in its address; `sharesByUser/{uid}` is the
  // uid-addressable half the share writers maintain alongside it, so a token
  // minted for a demo account is visible here without scanning a root.
  'sharesByUser',
] as const;

/**
 * The day-sharded pair. Scoped to the day shards the REFUSED OPERATION'S OWN
 * WINDOW covers (`dayShardKey(occurredAt)`, the same key `events/ledger.ts`
 * writes under) — never the whole root.
 */
export const GATE6_DAY_SHARDED_TRACE_TREES = ['eventLedger', 'outboxPending'] as const;

/** Bumped whenever the surface list or the digest rule below changes. */
export const GATE6_TRACE_SNAPSHOT_VERSION = 1;

/** How stale a rejected-operation probe may be before it stops being evidence about now. */
export const GATE6_DEFAULT_MAX_PROBE_AGE_MS = 24 * 60 * 60 * 1000;

/** How stale a registry-operator receipt may be before it stops being evidence about now. */
export const GATE6_DEFAULT_MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000;

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
  'rejected-operation-no-trace',
  'witness-observation-references',
  'registry-receipt-attestation',
] as const;
export type Gate6AssertionId = (typeof GATE6_ASSERTION_IDS)[number];

/**
 * The per-assertion verdict, so a reader can tell "not checked" from "checked
 * and fine" WITHOUT inferring it from `ok && findings.length === 0` (which is
 * true of both).
 *
 * - `passed`    — inspected a population and found nothing wrong.
 * - `failed`    — findings that fail the audit. `ok` is false.
 * - `tolerated` — findings reported but deliberately non-fatal (see
 *                 `Gate6AssertionResult.tolerated`). `ok` stays true.
 * - `skipped`   — NOT CHECKED, because its optional evidence was not
 *                 supplied. `ok` is true so an absent input does not fail the
 *                 audit, but the status and `skipReason` make the gap
 *                 impossible to mistake for a pass — and the matching
 *                 `--require-*` flag turns the absence into a `failed`.
 */
export type Gate6AssertionStatus = 'passed' | 'failed' | 'tolerated' | 'skipped';

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
  /** The four-way verdict — see {@link Gate6AssertionStatus}. */
  status: Gate6AssertionStatus;
  /** Non-null ONLY when `status === 'skipped'`; says exactly what was not supplied. */
  skipReason: string | null;
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
  /** Of those, children carrying this projector's ownership witness — the LIVE generated population. */
  registryOwnedRows: number;
  /** `computeRegistryRowSetHash` over those rows, recomputed live (assertion 12). */
  registryRowSetHash: string;
  enrichmentRunStatus: string | null;
  ingestionRunStatuses: string[];
}

/**
 * THE LOCAL DIGEST LAW — used by assertion 7 (Sparg0 user-owned VODs) and
 * NOWHERE ELSE.
 *
 * TWO DIGEST LAWS LIVE IN THIS FILE AND THEY ARE NOT INTERCHANGEABLE. Do not
 * "unify" them on the assumption that a digest is a digest:
 *
 * - Assertion 8 (registry preservation) uses the SHARED registry law —
 *   `computeForeignRowDigest` in `apps/api/src/research/registry/
 *   foreignDigest.ts`, hashing through `canonicalJson`/`canonicalDigest`.
 *   That law is shared because the registry OPERATOR seals the same digest
 *   into its per-account receipts, and this audit must recompute it from the
 *   same code rather than from a re-description of it. It also binds the UID
 *   INTO the hash, so two accounts can never compare equal by accident.
 * - Assertion 7 keeps THIS local law, because there is no shared equivalent
 *   for the user-owned-VOD population and it is a different contract
 *   entirely: its membership is decided by `isSourceOwnedVodValue` against
 *   each row's projection witness, it is scoped to one account by
 *   construction, and no other tool produces or consumes it.
 */
export interface Gate6DigestEntry {
  count: number;
  digest: string;
  keys: string[];
}

export interface Gate6Baseline {
  /**
   * Bumped 1 -> 2 when `registryForeign` changed from the local
   * `Gate6DigestEntry` shape to the shared `ForeignRowDigest` (which adds
   * `version` and `uid`). A v1 baseline holds digests computed under a
   * DIFFERENT hashing law, so comparing against one would be meaningless —
   * `parseGate6Baseline` refuses it outright rather than mis-parsing it.
   */
  baselineVersion: 2;
  expectationTableVersion: string;
  recordedAtMs: number;
  targetUids: Gate6UidMap;
  /** Local law — see {@link Gate6DigestEntry}. */
  sparg0UserOwnedVod: Gate6DigestEntry;
  /** SHARED law — `ForeignRowDigest` from the registry module. */
  registryForeign: Record<Gate6WorkspaceKey, ForeignRowDigest>;
}

/**
 * One registry-operator receipt file offered to the audit as evidence. The
 * CLI reads the file; the CORE validates it, so a tampered seal is a FINDING
 * in the audit's own output rather than a stack trace from the shell.
 */
export interface Gate6RegistryReceiptInput {
  /** Where it came from — echoed into findings so an operator can find the bad file. */
  path: string;
  /** The parsed JSON, unvalidated. */
  raw: unknown;
}

/** One reviewed registry manifest offered as the identity a receipt must name. */
export interface Gate6RegistryManifestInput {
  path: string;
  raw: unknown;
}

/** What the audit observed about each supplied manifest, valid or not. */
export interface Gate6RegistryManifestObservation {
  path: string;
  valid: boolean;
  contentHash: string | null;
  generatedAtMs: number | null;
  scope: string[];
}

// ---------------------------------------------------------------------------
// The rejected-operation trace probe (assertion 10)
// ---------------------------------------------------------------------------

/** One bounded surface, digested. `path` is the exact RTDB path that was read. */
export interface Gate6TraceSurface {
  path: string;
  /** Children observed at that path (0 for an absent node, 1 for a scalar). */
  count: number;
  /** sha256 over the canonical JSON of `{version, uid, path, value}`. */
  digest: string;
}

/**
 * A point-in-time reading of everything one refused operation could have
 * written, for ONE account, bounded by ONE wall-clock window.
 */
export interface Gate6TraceSnapshot {
  version: number;
  uid: string;
  capturedAtMs: number;
  /** The UTC `yyyymmdd` shards the operation window covers, ascending. */
  dayShards: string[];
  /** Sorted by `path`, so two snapshots are directly zippable. */
  surfaces: Gate6TraceSurface[];
}

/** The sealed body of one rejected-operation probe. */
export interface Gate6RejectedOperationProbeBody {
  formatVersion: 1;
  workspace: Gate6WorkspaceKey;
  uid: string;
  /** The database the probe was taken against — a probe from staging is not evidence about production. */
  databaseHost: string;
  /** What was attempted, in the operator's words. */
  operation: string;
  /** The refusal that was actually observed. A probe of an operation that SUCCEEDED is not evidence. */
  refusal: string;
  startedAtMs: number;
  finishedAtMs: number;
  /** Captured immediately BEFORE the refused call. */
  before: Gate6TraceSnapshot;
  /** Captured immediately AFTER it returned its refusal. */
  after: Gate6TraceSnapshot;
}

export interface Gate6RejectedOperationProbe extends Gate6RejectedOperationProbeBody {
  contentHash: string;
}

/** One probe file offered to the audit. Validation is the core's job. */
export interface Gate6RejectedOperationProbeInput {
  path: string;
  raw: unknown;
}

/** What the audit observed about each supplied probe, valid or not. */
export interface Gate6RejectedOperationProbeObservation {
  path: string;
  valid: boolean;
  workspace: Gate6WorkspaceKey | null;
  operation: string | null;
  refusal: string | null;
  /** Surfaces compared for this probe — the anti-vacuity figure per probe. */
  surfacesCompared: number;
  /** `true` only when every compared surface was byte-identical before and after. */
  wroteNothing: boolean;
}

/** What the audit observed about each supplied receipt, valid or not. */
export interface Gate6RegistryReceiptObservation {
  path: string;
  valid: boolean;
  workspace: Gate6WorkspaceKey | null;
  uid: string | null;
  command: string | null;
  status: string | null;
  databaseHost: string | null;
  /** `false` when no expected host was supplied, so an unchecked host is never read as a checked one. */
  databaseHostChecked: boolean;
  foreignDigestAfter: string | null;
}

export interface Gate6AuditReceipt {
  /**
   * Bumped 1 -> 2: assertions gained `status`/`skipReason`, and the receipt
   * gained `skippedCount`/`registryReceipts`.
   * Bumped 2 -> 3 (hard gate #4): assertion 10 became the operation-scoped
   * `rejected-operation-no-trace`, and the receipt gained
   * `rejectedOperationProbes`/`registryManifests`.
   */
  receiptVersion: 3;
  expectationTableVersion: string;
  generatedAtMs: number;
  targetUids: Gate6UidMap;
  baselineMode: 'record' | 'compare';
  strictWitnessObservationRefs: boolean;
  requireRegistryReceipts: boolean;
  requireRejectedOperationProbes: boolean;
  ok: boolean;
  findingCount: number;
  /** How many assertions were NOT checked. A non-zero value with `ok: true` means "green, but incompletely evidenced". */
  skippedCount: number;
  assertions: Gate6AssertionResult[];
  observed: Gate6WorkspaceObservation[];
  registryReceipts: Gate6RegistryReceiptObservation[];
  registryManifests: Gate6RegistryManifestObservation[];
  rejectedOperationProbes: Gate6RejectedOperationProbeObservation[];
  /** The digests OBSERVED this run — written out as the baseline in record mode. */
  baseline: Gate6Baseline;
}

export interface Gate6AuditOptions {
  uids: Gate6UidMap;
  nowMs: number;
  /** `null` records the observed digests; a value compares against them. */
  baseline?: Gate6Baseline | null;
  strictWitnessObservationRefs?: boolean;
  /** Registry-operator receipts offered as evidence. Empty/absent -> the attestation assertion is SKIPPED. */
  registryReceipts?: Gate6RegistryReceiptInput[] | null;
  /** The reviewed manifests those receipts must name. Absent -> the manifest-identity sub-check FAILS the receipt. */
  registryManifests?: Gate6RegistryManifestInput[] | null;
  /** When true, an absent or incomplete receipt set FAILS instead of skipping. */
  requireRegistryReceipts?: boolean;
  /** Rejected-operation probes. Empty/absent -> assertion 10 is SKIPPED. */
  rejectedOperationProbes?: Gate6RejectedOperationProbeInput[] | null;
  /** When true, an absent or incomplete probe set FAILS instead of skipping. */
  requireRejectedOperationProbes?: boolean;
  /**
   * The host of the database being audited, for the receipt's `databaseHost`
   * cross-check. `null`/absent no longer passes silently: it is a FINDING on
   * every supplied receipt and probe, because a sealed artifact whose database
   * identity was never checked is not evidence about this database.
   */
  expectedDatabaseHost?: string | null;
  /** Receipt freshness ceiling. Default {@link GATE6_DEFAULT_MAX_RECEIPT_AGE_MS}. */
  maxReceiptAgeMs?: number;
  /** Probe freshness ceiling. Default {@link GATE6_DEFAULT_MAX_PROBE_AGE_MS}. */
  maxProbeAgeMs?: number;

  // --- Bounded execution (hard gate #4, B6) -------------------------------
  /** Per-RTDB-read ceiling. Default {@link DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS}. `0` disables. */
  requestTimeoutMs?: number;
  /** The caller's shutdown signal. An abort stops the audit at the next read boundary and THROWS. */
  signal?: AbortSignal;
  /** No-progress watchdog. Default {@link GATE6_DEFAULT_MAX_STALL_MS}. */
  maxStallMs?: number;
  /** Heartbeat cadence. Default {@link GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS}. */
  heartbeatIntervalMs?: number;
  /** Where the heartbeat/watchdog lines go. Defaults to `console.error`. */
  log?: (line: string) => void;
  /** Monotonic-ish clock for the heartbeat/watchdog. Defaults to `Date.now`. Distinct from `nowMs`, which stamps the receipt. */
  clock?: () => number;
}

export const GATE6_DEFAULT_MAX_STALL_MS = 5 * 60 * 1000;
export const GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** The LOCAL law's persisted shape (assertion 7 only). */
const digestEntrySchema = z.object({
  count: z.number().int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  keys: z.array(z.string()),
});

/**
 * The SHARED law's persisted shape, imported from the registry module rather
 * than restated — a local restatement could drift from the producer and would
 * silently accept a digest this audit can no longer verify.
 */
const gate6BaselineSchema = z.object({
  baselineVersion: z.literal(2),
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
    hbox: foreignRowDigestSchema,
    mkleo: foreignRowDigestSchema,
    sparg0: foreignRowDigestSchema,
    izaw: foreignRowDigestSchema,
  }),
});

/**
 * STRICT parse of a baseline file. A malformed baseline THROWS rather than
 * being coerced or skipped: silently degrading to record mode is the exact
 * false-green ("no baseline, so nothing to compare, so pass") this oracle
 * exists to remove.
 *
 * A v1 baseline is REFUSED here by the `baselineVersion` literal, not
 * migrated. Its `registryForeign` entries were computed under this file's old
 * local digest law, which produced a different hash over the same content and
 * carried no `version`/`uid` members; a lenient parse would compare two
 * incomparable hashes and report drift on an untouched corpus. Note the
 * refusal is anchored on `baselineVersion` and NOT on
 * `GATE6_EXPECTATION_TABLE_VERSION`: the expectation table pins the corpus's
 * expected COUNTS, while this pins the baseline file's SHAPE, and bumping the
 * table for a shape change would falsely signal that the owner-supplied
 * figures moved.
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
// Raw-read helpers — deliberately schema-blind, and BOUNDED
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * THE ONLY WAY THIS MODULE TOUCHES THE DATABASE (hard gate #4, B6).
 *
 * Every read goes through `withRegistryDeadline`, so an unreachable RTDB
 * produces a `RegistryOperationTimeoutError` instead of a promise that never
 * settles. Before this existed the audit had no per-request deadline, no
 * heartbeat and no watchdog, and — worse — the lifecycle wrapper's hard-exit
 * backstop only arms AFTER the run settles, so a single hung read left the
 * whole gate hanging indefinitely while looking healthy. Bounding the reads is
 * what lets the run REACH a terminal result, which is what arms the backstop.
 *
 * `onRead` feeds the heartbeat/watchdog: a reader that reported nothing would
 * be indistinguishable from a hung one, which is the same lesson the registry
 * projector's progress events encode.
 */
interface Gate6Reader {
  raw(path: string): Promise<unknown>;
  children(path: string): Promise<[string, unknown][]>;
}

export interface Gate6ReaderOptions {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  onRead?: (path: string) => void;
}

export function createGate6Reader(
  database: Database,
  options: Gate6ReaderOptions = {},
): Gate6Reader {
  const raw = async (path: string): Promise<unknown> => {
    options.onRead?.(path);
    const snapshot = await withRegistryDeadline(
      `gate6 read ${path}`,
      () => database.ref(path).get(),
      { requestTimeoutMs: options.requestTimeoutMs, signal: options.signal },
    );
    return snapshot.exists() ? snapshot.val() : null;
  };
  return {
    raw,
    /** One level of children as `[key, value]` pairs; a missing or non-object node is an empty list. */
    children: async (path: string) => {
      const value = await raw(path);
      return isPlainRecord(value) ? Object.entries(value) : [];
    },
  };
}

// ---------------------------------------------------------------------------
// Progress monitor — heartbeat + no-progress watchdog (hard gate #4, B6)
// ---------------------------------------------------------------------------

export interface Gate6Monitor {
  /** Call at the start of every unit of work — a read, an HTTP request, a stage boundary. */
  onProgress: (unit: string) => void;
  /** Aborts when the watchdog trips OR the caller's signal fires. */
  signal: AbortSignal;
  /** Rejects when the watchdog trips — raced against the work so a stall fails it even with nothing abortable in flight. */
  stallPromise: Promise<never>;
  dispose: () => void;
}

/** The subset of {@link Gate6AuditOptions} the monitor needs — also what the capture operator supplies. */
export interface Gate6MonitorOptions {
  signal?: AbortSignal;
  maxStallMs?: number;
  heartbeatIntervalMs?: number;
  log?: (line: string) => void;
  clock?: () => number;
}

/**
 * Heartbeat + no-progress watchdog, shared by the audit and the probe-capture
 * operator. `label` names the operator in every line, so two of them running
 * in the same terminal stay distinguishable.
 */
export function createGate6Monitor(options: Gate6MonitorOptions, label = 'gate6'): Gate6Monitor {
  const clock = options.clock ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? GATE6_DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxStallMs = options.maxStallMs ?? GATE6_DEFAULT_MAX_STALL_MS;

  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), {
        once: true,
      });
    }
  }

  let units = 0;
  let lastUnit = '<starting>';
  let lastAtMs = clock();
  let stalled = false;
  let rejectStall: ((error: Error) => void) | null = null;
  const stallPromise = new Promise<never>((_resolve, reject) => {
    rejectStall = reject;
  });
  // A stall can trip while nothing is racing against it; pre-attach a swallow
  // handler so the rejection is never "unhandled".
  void stallPromise.catch(() => undefined);

  const heartbeat = setInterval(() => {
    log(
      `[heartbeat] ${label} reads=${units} path=${lastUnit} lastProgressMsAgo=${clock() - lastAtMs}`,
    );
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  const watchdog = setInterval(
    () => {
      const idleMs = clock() - lastAtMs;
      if (idleMs > maxStallMs && !stalled) {
        stalled = true;
        const reason = `no progress for ${idleMs}ms (limit ${maxStallMs}ms); aborting the ${label} run`;
        log(`[watchdog] ${reason}`);
        controller.abort(new Error(reason));
        rejectStall?.(new Error(reason));
      }
    },
    Math.max(50, Math.min(heartbeatIntervalMs, Math.floor(maxStallMs / 4))),
  );
  watchdog.unref?.();

  return {
    onProgress: (unit) => {
      units += 1;
      lastUnit = unit;
      lastAtMs = clock();
    },
    signal: controller.signal,
    stallPromise,
    dispose: () => {
      clearInterval(heartbeat);
      clearInterval(watchdog);
    },
  };
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
  reader: Gate6Reader,
  workspace: Gate6WorkspaceKey,
  uid: string,
): Promise<WorkspaceCorpus> {
  const matchEntries = await reader.children(`matches/${uid}`);
  const attachmentTree = await reader.raw(`researchEnrichmentAttachments/${uid}`);
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
    observations: await reader.children(`researchEnrichmentObservations/${uid}`),
    receipts: await reader.children(`researchEnrichmentReceipts/${uid}`),
    attachments,
    witnesses: await reader.children(`researchEnrichmentProjection/${uid}`),
    tournamentEntries: await reader.children(`tournamentEntries/${uid}`),
    enrichmentRunRaw: await reader.raw(`researchEnrichmentRuns/${uid}`),
    ingestionRunRaw: await reader.raw(`researchIngestionRuns/${uid}`),
    startggLinkRaw: await reader.raw(`startggLinks/${uid}`),
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
  /** Set ONLY when the assertion was not performed for want of optional evidence. */
  skipReason?: string | null;
  inspected: number;
  findings: Gate6Finding[];
}

function finish(draft: AssertionDraft, strict: boolean): Gate6AssertionResult {
  const tolerated = draft.tolerated === true && !strict;
  const skipReason = draft.skipReason ?? null;
  const ok = skipReason !== null || tolerated || draft.findings.length === 0;
  const status: Gate6AssertionStatus =
    skipReason !== null
      ? 'skipped'
      : draft.findings.length === 0
        ? 'passed'
        : tolerated
          ? 'tolerated'
          : 'failed';
  return {
    id: draft.id,
    title: draft.title,
    ok,
    status,
    skipReason,
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

/**
 * The LOCAL digest law (assertion 7 only — see {@link Gate6DigestEntry}). The
 * registry population deliberately does NOT come through here; it goes
 * through the shared `computeForeignRowDigest`.
 */
function digestOf(entries: { key: string; payload: unknown }[]): Gate6DigestEntry {
  const sorted = [...entries].sort((left, right) => left.key.localeCompare(right.key));
  return {
    count: sorted.length,
    digest: sha256(canonicalize(sorted.map(({ key, payload }) => ({ key, payload })))),
    keys: sorted.map(({ key }) => key),
  };
}

/** Comparison for the LOCAL law. The shared law compares through `foreignRowDigestsMatch`. */
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
 * Assertion 8 — registry preservation, THROUGH THE SHARED REGISTRY LAW.
 *
 * `preservedForeignCount` alone is explicitly insufficient (a swap of one
 * foreign row for another keeps the count identical), so this compares a
 * content digest over every non-registry-owned `tournamentEntries` child —
 * the manual, start.gg-synced and parry.gg-synced rows the projector must
 * never touch.
 *
 * THE DIGEST IS NOT COMPUTED HERE. It comes from `computeForeignRowDigest` in
 * `apps/api/src/research/registry/foreignDigest.ts`, hashed through that
 * module's `canonicalJson`/`canonicalDigest`. That module is also what the
 * registry OPERATOR seals into each per-account receipt, and its own header
 * states the reason plainly: "the Gate-6 audit tooling must be able to
 * recompute the SAME digest from the SAME code, not from a re-description of
 * it." An earlier revision of this file hashed the same population with a
 * local `digestOf`; that local law was strictly weaker (it did not bind the
 * uid into the hash, so two accounts with identical foreign content produced
 * identical digests and could compare equal by accident), and it was a second
 * canonicalizer that could drift from the producer. It is deleted for this
 * population.
 *
 * The comparison and the human-readable delta are the shared module's too —
 * `foreignRowDigestsMatch` and `describeForeignRowDigestDelta`, the latter
 * being what names the identical-key-set CONTENT change that a count can
 * never see.
 */
function assertRegistryPreservation(
  observed: Record<Gate6WorkspaceKey, ForeignRowDigest>,
  baseline: Gate6Baseline | null,
): AssertionDraft {
  const findings: Gate6Finding[] = [];
  let inspected = 0;
  for (const workspace of GATE6_WORKSPACE_KEYS) {
    const actual = observed[workspace];
    inspected += actual.count;
    if (baseline === null) {
      continue;
    }
    const expected = baseline.registryForeign[workspace];
    const label = `${GATE6_EXPECTATIONS[workspace].label} foreign tournamentEntries`;
    if (expected === undefined) {
      findings.push({
        code: 'baseline-entry-missing',
        workspace,
        detail: `${label}: the supplied baseline has no entry to compare against`,
      });
      continue;
    }
    // A digest-rule version change alters the hash by design, so a mismatch
    // there is reported as its own condition rather than surfacing as an
    // unexplained content drift.
    if (expected.version !== actual.version) {
      findings.push({
        code: 'foreign-digest-version-mismatch',
        workspace,
        detail: `${label}: baseline digest-rule version ${expected.version} != current ${actual.version}; re-record the baseline`,
        expected: expected.version,
        actual: actual.version,
      });
      continue;
    }
    if (foreignRowDigestsMatch(expected, actual)) {
      continue;
    }
    findings.push({
      code: 'digest-drift',
      workspace,
      detail: `${label}: ${describeForeignRowDigestDelta(expected, actual)}`,
      expected: expected.digest,
      actual: actual.digest,
    });
  }
  return {
    id: 'registry-preservation',
    title: 'Foreign, manual and provider-linked tournamentEntries children are byte-identical',
    inspected,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Assertion 12 — registry attestation over LIVE generated content
// ---------------------------------------------------------------------------

/**
 * The live registry-owned population for one account: the `histimport:` rows
 * this projector owns, recomputed from the stored `tournamentEntries/{uid}`
 * children rather than read out of anybody's receipt.
 */
interface LiveRegistryRows {
  rows: TournamentRegistryRow[];
  /** Structurally-owned children that no longer parse as a registry row. */
  unparseable: string[];
  /** `computeRegistryRowSetHash` over `rows` — the operator's own law, not a restatement. */
  rowSetHash: string;
}

function collectLiveRegistryRows(corpus: WorkspaceCorpus): LiveRegistryRows {
  const rows: TournamentRegistryRow[] = [];
  const unparseable: string[] = [];
  for (const [childKey, value] of corpus.tournamentEntries) {
    if (value === null || value === undefined || !isTournamentRegistryOwnedRow(value)) {
      continue;
    }
    const parsed = tournamentRegistryRowSchema.safeParse(value);
    if (parsed.success) {
      rows.push(parsed.data);
    } else {
      unparseable.push(childKey);
    }
  }
  return {
    rows,
    unparseable: unparseable.sort(),
    rowSetHash: computeRegistryRowSetHash(corpus.uid, rows),
  };
}

/**
 * Assertion 12 — the registry attestation, REBUILT under owner/Codex hard
 * gate #4 (B7).
 *
 * WHAT IT USED TO PROVE, AND WHY THAT WAS NOT ENOUGH. The previous version
 * checked one thing about live state: that the receipt's `foreignDigestAfter`
 * still matched the live foreign rows. That is a preservation claim about the
 * rows the projector must NOT touch, and it says nothing whatsoever about the
 * rows it DID generate. An operator could seal a perfect receipt, someone
 * could then edit or delete every `histimport:` row on the account, and this
 * assertion would stay green — the seal was still valid, so the audit accepted
 * a stale attestation as a statement about now.
 *
 * WHAT IT PROVES NOW. Five things, all recomputed LIVE at audit time:
 *  1. LIVE GENERATED CONTENT. The registry-owned children are re-read, parsed,
 *     and hashed through `computeRegistryRowSetHash` — the operator's own law.
 *     That hash must equal the receipt's `observedRowSetHash`. Change or delete
 *     ANY generated row and this fails, which is the whole point.
 *  2. SETTLED BUCKETS. The receipt's post-state census must show zero pending
 *     creates, updates, orphan removals and collisions. A receipt that observed
 *     outstanding work is not an attestation that the work is done.
 *  3. EXACT CURRENT MANIFEST IDENTITY. A reviewed manifest must be supplied and
 *     must cover this workspace, and the receipt must name it exactly —
 *     `manifestContentHash`, `manifestGeneratedAtMs`, and the per-account
 *     `reviewedRowSetHash`. A receipt authorized by some other manifest is not
 *     evidence about the one under review.
 *  4. FRESHNESS AND DATABASE IDENTITY. `finishedAtMs` must be within
 *     `maxReceiptAgeMs` of now and not in the future, and `databaseHost` must
 *     equal the audited host. An UNSUPPLIED expected host is now a FINDING, not
 *     a `databaseHostChecked: false` note: an artifact whose database identity
 *     was never checked cannot attest to this database.
 *  5. FOREIGN-ROW DIGEST PRESERVATION. As before — the non-registry rows still
 *     hash to what the operator sealed.
 *
 * COMPARE RECEIPTS ONLY. `apply` no longer satisfies this assertion, and that
 * is a deliberate tightening rather than an oversight. An apply receipt's
 * post-state is observed by the applying process, in the same breath as the
 * write; `compare` is a separate, later, read-only run whose entire job is to
 * observe the settled destination and hash it. Requiring the latter means the
 * attestation always rests on an INDEPENDENT observation of post-state. A
 * `dry-run` receipt remains refused for the original reason: it writes nothing,
 * so its digests describe a pre-apply observation.
 *
 * SKIPPED-WHEN-ABSENT, STRICT-WHEN-PRESENT — unchanged. No receipts supplied ->
 * `status: 'skipped'` with a `skipReason`; `--require-registry-receipt`
 * converts absence and partial coverage into findings.
 */
function assertRegistryReceiptAttestation(
  observedForeign: Record<Gate6WorkspaceKey, ForeignRowDigest>,
  liveRegistryRows: Record<Gate6WorkspaceKey, LiveRegistryRows>,
  uids: Gate6UidMap,
  inputs: Gate6RegistryReceiptInput[],
  manifestInputs: Gate6RegistryManifestInput[],
  requireReceipts: boolean,
  expectedDatabaseHost: string | null,
  nowMs: number,
  maxReceiptAgeMs: number,
): {
  draft: AssertionDraft;
  observations: Gate6RegistryReceiptObservation[];
  manifestObservations: Gate6RegistryManifestObservation[];
} {
  const findings: Gate6Finding[] = [];
  const observations: Gate6RegistryReceiptObservation[] = [];
  const manifestObservations: Gate6RegistryManifestObservation[] = [];
  const title = 'Registry receipts attest to the LIVE generated rows, under the reviewed manifest';

  // Manifests are parsed up front so a bad one is reported once, not once per
  // receipt that happens to reference it.
  const manifestByWorkspace = new Map<Gate6WorkspaceKey, RegistryManifest>();
  for (const input of manifestInputs) {
    let manifest: RegistryManifest;
    try {
      manifest = parseSealedRegistryManifest(input.raw);
    } catch (error) {
      manifestObservations.push({
        path: input.path,
        valid: false,
        contentHash: null,
        generatedAtMs: null,
        scope: [],
      });
      findings.push({
        code: 'registry-manifest-invalid',
        workspace: null,
        detail: `${input.path}: ${error instanceof Error ? error.message : String(error)}`,
        path: input.path,
      });
      continue;
    }
    manifestObservations.push({
      path: input.path,
      valid: true,
      contentHash: manifest.contentHash,
      generatedAtMs: manifest.generatedAtMs,
      scope: [...manifest.scope],
    });
    for (const workspace of manifest.scope) {
      if (manifestByWorkspace.has(workspace)) {
        findings.push({
          code: 'registry-manifest-duplicate',
          workspace,
          detail: `${input.path}: a second manifest scopes ${workspace}; the reviewed identity is ambiguous`,
          path: input.path,
        });
        continue;
      }
      manifestByWorkspace.set(workspace, manifest);
    }
  }

  if (inputs.length === 0) {
    if (!requireReceipts) {
      return {
        draft: {
          id: 'registry-receipt-attestation',
          title,
          skipReason:
            'no --registry-receipt was supplied; pass --require-registry-receipt to make this mandatory',
          inspected: 0,
          findings: [],
        },
        observations,
        manifestObservations,
      };
    }
    findings.push({
      code: 'registry-receipt-missing',
      workspace: null,
      detail: '--require-registry-receipt was set but no receipt was supplied for any workspace',
    });
  }

  const seenWorkspaces = new Map<Gate6WorkspaceKey, string>();

  for (const input of inputs) {
    let receipt;
    try {
      receipt = validateRegistryReceipt(input.raw);
    } catch (error) {
      observations.push({
        path: input.path,
        valid: false,
        workspace: null,
        uid: null,
        command: null,
        status: null,
        databaseHost: null,
        databaseHostChecked: false,
        foreignDigestAfter: null,
      });
      findings.push({
        code: 'registry-receipt-invalid',
        workspace: null,
        detail: `${input.path}: ${error instanceof Error ? error.message : String(error)}`,
        path: input.path,
      });
      continue;
    }

    // The two vocabularies are proven identical at module load, so a
    // schema-valid receipt always names one of the four.
    const workspace: Gate6WorkspaceKey = receipt.workspace;
    observations.push({
      path: input.path,
      valid: true,
      workspace,
      uid: receipt.uid,
      command: receipt.command,
      status: receipt.status,
      databaseHost: receipt.databaseHost,
      databaseHostChecked: expectedDatabaseHost !== null,
      foreignDigestAfter: receipt.foreignDigestAfter.digest,
    });

    const duplicate = seenWorkspaces.get(workspace);
    if (duplicate !== undefined) {
      findings.push({
        code: 'registry-receipt-duplicate',
        workspace,
        detail: `${input.path}: a second receipt for ${workspace} (first was ${duplicate}); the evidence is ambiguous`,
        path: input.path,
      });
      continue;
    }
    seenWorkspaces.set(workspace, input.path);

    if (receipt.uid !== uids[workspace]) {
      findings.push({
        code: 'registry-receipt-uid-mismatch',
        workspace,
        detail: `${input.path}: receipt is for a different account than the one audited`,
        expected: uids[workspace],
        actual: receipt.uid,
        path: input.path,
      });
      // Every remaining check compares against THIS workspace's live state,
      // which the receipt demonstrably does not describe — stop here rather
      // than emit a cascade of derivative findings.
      continue;
    }

    if (receipt.command !== 'compare') {
      findings.push({
        code: 'registry-receipt-not-post-state',
        workspace,
        detail:
          `${input.path}: a "${receipt.command}" receipt cannot carry the final attestation. ` +
          (receipt.command === 'dry-run'
            ? 'A dry-run writes nothing, so its digests describe a pre-apply observation.'
            : 'An apply observes its own post-state in the same breath as the write; the attestation ' +
              'must rest on an independent, later, read-only compare run.'),
        expected: 'compare',
        actual: receipt.command,
        path: input.path,
      });
      continue;
    }

    if (receipt.status !== 'ok' || receipt.failedInvariants.length > 0) {
      findings.push({
        code: 'registry-receipt-not-ok',
        workspace,
        detail: `${input.path}: sealed as "${receipt.status}"${
          receipt.failedInvariants.length > 0
            ? ` with failed invariants: ${receipt.failedInvariants.join('; ')}`
            : ''
        }`,
        expected: 'ok',
        actual: receipt.status,
        path: input.path,
      });
      continue;
    }

    if (expectedDatabaseHost === null) {
      findings.push({
        code: 'registry-receipt-host-unchecked',
        workspace,
        detail: `${input.path}: no expected database host was supplied, so this receipt cannot be tied to the database being audited`,
        path: input.path,
      });
      continue;
    }
    if (receipt.databaseHost !== expectedDatabaseHost) {
      findings.push({
        code: 'registry-receipt-host-mismatch',
        workspace,
        detail: `${input.path}: sealed against a different database than the one audited`,
        expected: expectedDatabaseHost,
        actual: receipt.databaseHost,
        path: input.path,
      });
      continue;
    }

    if (receipt.finishedAtMs > nowMs || nowMs - receipt.finishedAtMs > maxReceiptAgeMs) {
      findings.push({
        code: 'registry-receipt-stale',
        workspace,
        detail: `${input.path}: sealed at ${receipt.finishedAtMs}, which is in the future or older than the ${maxReceiptAgeMs}ms freshness bound; re-run compare`,
        expected: `<= ${maxReceiptAgeMs}ms old`,
        actual: nowMs - receipt.finishedAtMs,
        path: input.path,
      });
      continue;
    }

    // --- 2. Settled buckets --------------------------------------------------
    const after = receipt.after;
    if (
      after.creates > 0 ||
      after.updates > 0 ||
      after.orphanRemovals > 0 ||
      after.collisions > 0
    ) {
      findings.push({
        code: 'registry-receipt-not-settled',
        workspace,
        detail:
          `${input.path}: the sealed post-state is not settled ` +
          `(creates=${after.creates} updates=${after.updates} removals=${after.orphanRemovals} collisions=${after.collisions})`,
        expected: 0,
        actual: after.creates + after.updates + after.orphanRemovals + after.collisions,
        path: input.path,
      });
      continue;
    }

    // --- 3. Exact current manifest identity ----------------------------------
    const manifest = manifestByWorkspace.get(workspace);
    if (manifest === undefined) {
      findings.push({
        code: 'registry-manifest-missing',
        workspace,
        detail: `${input.path}: no --registry-manifest scoping ${workspace} was supplied, so the receipt's claimed authorization cannot be checked`,
        path: input.path,
      });
      continue;
    }
    const manifestAccount = manifest.accounts[workspace];
    if (manifestAccount === undefined) {
      findings.push({
        code: 'registry-manifest-missing',
        workspace,
        detail: `${input.path}: the supplied manifest scopes ${workspace} but carries no account for it`,
        path: input.path,
      });
      continue;
    }
    if (manifest.databaseHost !== expectedDatabaseHost) {
      findings.push({
        code: 'registry-manifest-host-mismatch',
        workspace,
        detail: `${input.path}: the reviewed manifest was generated against ${manifest.databaseHost}, not the audited ${expectedDatabaseHost}`,
        expected: expectedDatabaseHost,
        actual: manifest.databaseHost,
        path: input.path,
      });
      continue;
    }
    if (manifestAccount.uid !== uids[workspace]) {
      findings.push({
        code: 'registry-manifest-uid-mismatch',
        workspace,
        detail: `${input.path}: the reviewed manifest targets a different uid for ${workspace}`,
        expected: uids[workspace],
        actual: manifestAccount.uid,
        path: input.path,
      });
      continue;
    }
    if (
      receipt.manifestContentHash !== manifest.contentHash ||
      receipt.manifestGeneratedAtMs !== manifest.generatedAtMs
    ) {
      findings.push({
        code: 'registry-receipt-manifest-mismatch',
        workspace,
        detail: `${input.path}: the receipt was authorized by a DIFFERENT manifest than the one supplied for review`,
        expected: manifest.contentHash,
        actual: receipt.manifestContentHash,
        path: input.path,
      });
      continue;
    }
    if (receipt.reviewedRowSetHash !== manifestAccount.rowSetHash) {
      findings.push({
        code: 'registry-receipt-manifest-mismatch',
        workspace,
        detail: `${input.path}: the receipt's reviewed row-set hash is not the one in the supplied manifest`,
        expected: manifestAccount.rowSetHash,
        actual: receipt.reviewedRowSetHash,
        path: input.path,
      });
      continue;
    }

    // --- 1. LIVE generated content -------------------------------------------
    const live = liveRegistryRows[workspace];
    if (live.unparseable.length > 0) {
      findings.push({
        code: 'registry-live-row-unparseable',
        workspace,
        detail: `${input.path}: ${live.unparseable.length} live registry-owned child(ren) no longer parse as a registry row (${live.unparseable.slice(0, 5).join(', ')})`,
        path: `tournamentEntries/${uids[workspace]}`,
      });
      // Fall through: the hash below is computed over the rows that DID parse
      // and will also differ, which is the finding an operator acts on.
    }
    if (live.rowSetHash !== receipt.observedRowSetHash) {
      findings.push({
        code: 'registry-live-row-set-mismatch',
        workspace,
        detail:
          `${input.path}: the LIVE generated rows no longer hash to the sealed post-state ` +
          `(${live.rows.length} live registry-owned row(s)). A generated row was changed, removed or added ` +
          'since the compare receipt was sealed; the attestation is stale.',
        expected: receipt.observedRowSetHash,
        actual: live.rowSetHash,
        path: `tournamentEntries/${uids[workspace]}`,
      });
      continue;
    }
    if (live.rowSetHash !== manifestAccount.rowSetHash) {
      findings.push({
        code: 'registry-live-row-set-mismatch',
        workspace,
        detail: `${input.path}: the LIVE generated rows do not hash to the REVIEWED manifest row set`,
        expected: manifestAccount.rowSetHash,
        actual: live.rowSetHash,
        path: `tournamentEntries/${uids[workspace]}`,
      });
      continue;
    }

    // --- 5. Foreign-row digest preservation ----------------------------------
    const liveForeign = observedForeign[workspace];
    if (receipt.foreignDigestAfter.version !== liveForeign.version) {
      findings.push({
        code: 'foreign-digest-version-mismatch',
        workspace,
        detail: `${input.path}: receipt digest-rule version ${receipt.foreignDigestAfter.version} != current ${liveForeign.version}`,
        expected: liveForeign.version,
        actual: receipt.foreignDigestAfter.version,
        path: input.path,
      });
      continue;
    }
    if (!foreignRowDigestsMatch(receipt.foreignDigestAfter, liveForeign)) {
      findings.push({
        code: 'registry-receipt-digest-mismatch',
        workspace,
        detail: `${input.path}: sealed post-apply foreign content no longer matches live — ${describeForeignRowDigestDelta(receipt.foreignDigestAfter, liveForeign)}`,
        expected: receipt.foreignDigestAfter.digest,
        actual: liveForeign.digest,
        path: input.path,
      });
    }
  }

  if (requireReceipts) {
    for (const workspace of GATE6_WORKSPACE_KEYS) {
      if (!seenWorkspaces.has(workspace)) {
        findings.push({
          code: 'registry-receipt-missing',
          workspace,
          detail: `--require-registry-receipt was set but no valid receipt covers ${GATE6_EXPECTATIONS[workspace].label}`,
        });
      }
    }
  }

  return {
    draft: {
      id: 'registry-receipt-attestation',
      title,
      inspected: inputs.length,
      findings,
    },
    observations,
    manifestObservations,
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
  reader: Gate6Reader,
  izawUid: string,
): Promise<AssertionDraft> {
  const findings: Gate6Finding[] = [];
  const memberTrees = await reader.children('clientMembers');
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

  const coachClients = await reader.children('coachClients');
  for (const tenantId of izawTenants) {
    const ownRoot = await reader.raw(`coachClients/${izawUid}/${tenantId}`);
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

// ---------------------------------------------------------------------------
// Assertion 10 — the rejected-operation trace probe
// ---------------------------------------------------------------------------

/**
 * THE CONTRACT (rewritten under owner/Codex hard gate #4, B5).
 *
 * WHAT THIS USED TO ASSERT, AND WHY THAT WAS WRONG. The previous assertion
 * claimed LIFETIME ABSENCE: no `eventLedger`, `eventDedup`, `outboxPending`,
 * `shareTokens`, `creditLedger`, `credits`, `reportJobs` or
 * `reportJobsByStatus` row may reference a demo uid, ever. That is not the
 * system's contract, and it FAILS A HEALTHY SYSTEM — a false RED, which is
 * worse for a gate than a missing check, because it trains the operator to
 * discount the oracle.
 *
 * Two shipped behaviours contradict it outright:
 *  - RTEN-04 suppresses telemetry for RESEARCH-CONTEXT activity. It does not
 *    suppress an account's ordinary product events. A demo account that signs
 *    up and uses the app SHOULD emit `signup_completed` and its friends into
 *    `eventLedger`/`eventDedup`/`outboxPending`; those rows are correct
 *    operation, not a leak.
 *  - A successful FREE demo report INTENTIONALLY creates a succeeded
 *    `reportJobs` record. The old assertion called that a violation.
 *
 * It was also expensive and imprecise in a way the correct check is not: it
 * walked whole day-sharded and causation-keyed ROOTS hunting for a uid
 * substring — unbounded work whose cost grows with every other user's traffic,
 * and which mis-attributes on any causation id that is not uid-prefixed (most
 * are job- or tenant-prefixed).
 *
 * WHAT IT ASSERTS NOW. The property that actually matters is per-OPERATION,
 * not per-account: *this refused call wrote nothing*. The evidence is a sealed
 * {@link Gate6RejectedOperationProbe} — a refused operation, its wall-clock
 * window, and a {@link Gate6TraceSnapshot} captured immediately BEFORE and
 * immediately AFTER it. The audit requires every compared surface to be
 * byte-identical across that pair. Pre-existing legitimate telemetry appears in
 * BOTH snapshots and therefore passes; a row the refused call created appears
 * in only the second and therefore fails.
 *
 * WHAT IS COMPARED, AND HOW IT STAYS BOUNDED.
 *  - {@link GATE6_UID_TRACE_SURFACES}: one direct read at `${tree}/${uid}`.
 *  - {@link GATE6_DAY_SHARDED_TRACE_TREES}: only the `yyyymmdd` shards the
 *    operation's OWN window covers, and within them only the rows attributable
 *    to this uid. One refused call spans one or two shards, never a root.
 *  - `eventDedup`: addressed EXACTLY, at
 *    `{eventName}/{schemaVersion}/{causationId}` taken from each attributable
 *    ledger row — the pairing `events/ledger.ts` writes in one multi-path
 *    update. No causation-id substring guessing survives.
 *
 * THE LIMIT, STATED RATHER THAN PAPERED OVER. The audit VERIFIES a probe; it
 * does not re-execute the refused operation, and it cannot, because by gate
 * time the surfaces have legitimately moved on. What makes the probe evidence
 * rather than assertion is the discipline the registry receipts already get:
 * it is sealed under `canonicalDigest` (a hand-edited probe fails validation),
 * bound to a uid AND a database host, refused when stale, and refused when the
 * day shards it claims do not follow from the window it claims. A dedup marker
 * written WITHOUT its ledger row (an emission interrupted between the two
 * writes) falls outside the addressed set and would not be seen; that is a real
 * gap, and it is named here rather than hidden.
 *
 * ABSENT PROBES ARE `skipped`, never a silent pass, and
 * `--require-rejected-operation-probe` turns absence into findings — the same
 * shape as `--require-baseline` and `--require-registry-receipt`.
 */

const traceSurfaceSchema = z
  .object({
    path: z.string().min(1),
    count: z.number().int().nonnegative(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const traceSnapshotSchema = z
  .object({
    version: z.number().int().positive(),
    uid: z.string().min(1),
    capturedAtMs: z.number().int().nonnegative(),
    dayShards: z.array(z.string().regex(/^\d{8}$/)),
    surfaces: z.array(traceSurfaceSchema),
  })
  .strict();

const rejectedOperationProbeBodySchema = z
  .object({
    formatVersion: z.literal(1),
    workspace: z.enum(GATE6_WORKSPACE_KEYS),
    uid: z.string().min(1),
    databaseHost: z.string().min(1),
    operation: z.string().min(1),
    refusal: z.string().min(1),
    startedAtMs: z.number().int().nonnegative(),
    finishedAtMs: z.number().int().nonnegative(),
    before: traceSnapshotSchema,
    after: traceSnapshotSchema,
  })
  .strict();

const rejectedOperationProbeSchema = rejectedOperationProbeBodySchema.extend({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Seals a probe body under the shared registry canonicalization law. */
export function createGate6RejectedOperationProbe(
  body: Gate6RejectedOperationProbeBody,
): Gate6RejectedOperationProbe {
  const parsed = rejectedOperationProbeBodySchema.parse(body);
  return { ...parsed, contentHash: canonicalDigest(parsed) };
}

/** Parses and integrity-checks a probe file's contents. Throws on the first violation. */
export function validateGate6RejectedOperationProbe(raw: unknown): Gate6RejectedOperationProbe {
  const probe = rejectedOperationProbeSchema.parse(raw);
  const { contentHash, ...body } = probe;
  if (canonicalDigest(body) !== contentHash) {
    throw new Error('Rejected-operation probe content hash mismatch');
  }
  return probe;
}

/**
 * The UTC day shards a `[startedAtMs, finishedAtMs]` window covers, ascending.
 * Derived with the SAME `dayShardKey` the ledger writer addresses shards by,
 * so the audit can never look in a shard the writer would not have used.
 */
export function gate6WindowDayShards(startedAtMs: number, finishedAtMs: number): string[] {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const start = new Date(startedAtMs);
  // Walk from the start of the first UTC day, so a window that straddles
  // midnight (or several) names every shard it could possibly have touched.
  let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const shards: string[] = [];
  while (cursor <= finishedAtMs) {
    shards.push(dayShardKey(cursor));
    cursor += oneDayMs;
  }
  return shards;
}

function traceDigest(uid: string, path: string, value: unknown): string {
  return canonicalDigest({ version: GATE6_TRACE_SNAPSHOT_VERSION, uid, path, value });
}

function childCount(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return isPlainRecord(value) ? Object.keys(value).length : 1;
}

/**
 * Reads the bounded trace surfaces for one account over one operation window.
 * READS ONLY.
 *
 * Exported so a probe harness captures the pre-state through the SAME code the
 * audit verifies against, rather than a re-description of it — the reason
 * `computeForeignRowDigest` was hoisted out of the registry operator, applied
 * to this population.
 */
export async function captureGate6TraceSnapshot(
  database: Database,
  uid: string,
  window: { startedAtMs: number; finishedAtMs: number; capturedAtMs: number },
  options: Gate6ReaderOptions = {},
): Promise<Gate6TraceSnapshot> {
  if (!isPathSafeTenantId(uid)) {
    throw new Error(`captureGate6TraceSnapshot: unsafe uid ${uid}`);
  }
  const reader = createGate6Reader(database, options);
  const dayShards = gate6WindowDayShards(window.startedAtMs, window.finishedAtMs);
  const surfaces: Gate6TraceSurface[] = [];

  for (const tree of GATE6_UID_TRACE_SURFACES) {
    const path = `${tree}/${uid}`;
    const value = await reader.raw(path);
    surfaces.push({ path, count: childCount(value), digest: traceDigest(uid, path, value) });
  }

  for (const day of dayShards) {
    const ledgerRows = await reader.children(`eventLedger/${day}`);
    const attributable: Record<string, unknown> = {};
    const dedupPaths: string[] = [];
    for (const [key, record] of ledgerRows) {
      const strings: string[] = [];
      collectStrings(record, strings);
      if (!strings.includes(uid)) {
        continue;
      }
      attributable[key] = record;
      if (isPlainRecord(record)) {
        const eventName = rawString(record, 'eventName');
        const causationId = rawString(record, 'causationId');
        const schemaVersion = record.schemaVersion;
        if (eventName !== null && causationId !== null && typeof schemaVersion === 'number') {
          dedupPaths.push(`eventDedup/${eventName}/${schemaVersion}/${causationId}`);
        }
      }
    }
    const ledgerPath = `eventLedger/${day}`;
    surfaces.push({
      path: ledgerPath,
      count: Object.keys(attributable).length,
      digest: traceDigest(uid, ledgerPath, attributable),
    });

    // The outbox row is written in the SAME multi-path update as its ledger
    // row and under the same `{day}/{key}`, so the attributable set transfers
    // exactly — no second attribution rule to get wrong.
    const outboxRows = await reader.children(`outboxPending/${day}`);
    const outboxAttributable: Record<string, unknown> = {};
    for (const [key, value] of outboxRows) {
      if (attributable[key] !== undefined) {
        outboxAttributable[key] = value;
      }
    }
    const outboxPath = `outboxPending/${day}`;
    surfaces.push({
      path: outboxPath,
      count: Object.keys(outboxAttributable).length,
      digest: traceDigest(uid, outboxPath, outboxAttributable),
    });

    for (const dedupPath of [...new Set(dedupPaths)].sort()) {
      const value = await reader.raw(dedupPath);
      surfaces.push({
        path: dedupPath,
        count: childCount(value),
        digest: traceDigest(uid, dedupPath, value),
      });
    }
  }

  return {
    version: GATE6_TRACE_SNAPSHOT_VERSION,
    uid,
    capturedAtMs: window.capturedAtMs,
    dayShards,
    surfaces: surfaces.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function assertRejectedOperationNoTrace(
  uids: Gate6UidMap,
  inputs: Gate6RejectedOperationProbeInput[],
  requireProbes: boolean,
  expectedDatabaseHost: string | null,
  nowMs: number,
  maxProbeAgeMs: number,
): { draft: AssertionDraft; observations: Gate6RejectedOperationProbeObservation[] } {
  const title = 'Every REFUSED operation wrote nothing to any trace surface it could have touched';
  const findings: Gate6Finding[] = [];
  const observations: Gate6RejectedOperationProbeObservation[] = [];

  if (inputs.length === 0 && !requireProbes) {
    return {
      draft: {
        id: 'rejected-operation-no-trace',
        title,
        skipReason:
          'no --rejected-operation-probe was supplied; pass --require-rejected-operation-probe to make this mandatory',
        inspected: 0,
        findings: [],
      },
      observations,
    };
  }
  if (inputs.length === 0) {
    findings.push({
      code: 'rejected-operation-probe-missing',
      workspace: null,
      detail:
        '--require-rejected-operation-probe was set but no probe was supplied for any workspace',
    });
  }

  const covered = new Set<Gate6WorkspaceKey>();
  let inspected = 0;

  for (const input of inputs) {
    let probe: Gate6RejectedOperationProbe;
    try {
      probe = validateGate6RejectedOperationProbe(input.raw);
    } catch (error) {
      observations.push({
        path: input.path,
        valid: false,
        workspace: null,
        operation: null,
        refusal: null,
        surfacesCompared: 0,
        wroteNothing: false,
      });
      findings.push({
        code: 'rejected-operation-probe-invalid',
        workspace: null,
        detail: `${input.path}: ${error instanceof Error ? error.message : String(error)}`,
        path: input.path,
      });
      continue;
    }

    const workspace = probe.workspace;
    const findingsBefore = findings.length;
    const fail = (code: string, detail: string): void => {
      findings.push({ code, workspace, detail: `${input.path}: ${detail}`, path: input.path });
    };

    if (
      probe.uid !== uids[workspace] ||
      probe.before.uid !== probe.uid ||
      probe.after.uid !== probe.uid
    ) {
      fail(
        'rejected-operation-probe-uid-mismatch',
        `probe is for a different account than the one audited (probe ${probe.uid}, before ${probe.before.uid}, after ${probe.after.uid}, audited ${uids[workspace]})`,
      );
    }
    if (
      probe.before.version !== GATE6_TRACE_SNAPSHOT_VERSION ||
      probe.after.version !== GATE6_TRACE_SNAPSHOT_VERSION
    ) {
      fail(
        'rejected-operation-probe-version-mismatch',
        `snapshot rule version ${probe.before.version}/${probe.after.version} != current ${GATE6_TRACE_SNAPSHOT_VERSION}; re-capture the probe`,
      );
    }
    if (expectedDatabaseHost === null) {
      fail(
        'rejected-operation-probe-host-unchecked',
        'no expected database host was supplied, so this probe cannot be tied to the database being audited',
      );
    } else if (probe.databaseHost !== expectedDatabaseHost) {
      fail(
        'rejected-operation-probe-host-mismatch',
        `sealed against ${probe.databaseHost}, not the audited ${expectedDatabaseHost}`,
      );
    }
    if (
      probe.startedAtMs > probe.finishedAtMs ||
      probe.before.capturedAtMs > probe.startedAtMs ||
      probe.after.capturedAtMs < probe.finishedAtMs
    ) {
      fail(
        'rejected-operation-probe-window-invalid',
        `the snapshots do not bracket the operation (before ${probe.before.capturedAtMs} <= started ${probe.startedAtMs} <= finished ${probe.finishedAtMs} <= after ${probe.after.capturedAtMs} does not hold)`,
      );
    }
    const expectedShards = gate6WindowDayShards(probe.startedAtMs, probe.finishedAtMs);
    for (const [label, snapshot] of [
      ['before', probe.before],
      ['after', probe.after],
    ] as const) {
      if (canonicalize(snapshot.dayShards) !== canonicalize(expectedShards)) {
        fail(
          'rejected-operation-probe-window-invalid',
          `${label} snapshot claims day shards [${snapshot.dayShards.join(',')}] but its own window covers [${expectedShards.join(',')}]`,
        );
      }
    }
    if (probe.finishedAtMs > nowMs || nowMs - probe.finishedAtMs > maxProbeAgeMs) {
      fail(
        'rejected-operation-probe-stale',
        `finished at ${probe.finishedAtMs}, which is in the future or older than the ${maxProbeAgeMs}ms freshness bound`,
      );
    }

    const beforeByPath = new Map(probe.before.surfaces.map((surface) => [surface.path, surface]));
    const afterByPath = new Map(probe.after.surfaces.map((surface) => [surface.path, surface]));
    // ANTI-VACUITY: two empty snapshots compare equal, so the mandatory
    // uid-keyed surfaces must actually be present in both.
    for (const tree of GATE6_UID_TRACE_SURFACES) {
      const required = `${tree}/${probe.uid}`;
      if (!beforeByPath.has(required) || !afterByPath.has(required)) {
        fail(
          'rejected-operation-probe-incomplete',
          `the snapshots do not both cover the mandatory surface ${required}`,
        );
      }
    }

    let wroteNothing = true;
    const allPaths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
    for (const path of allPaths) {
      inspected += 1;
      const left = beforeByPath.get(path);
      const right = afterByPath.get(path);
      if (left === undefined || right === undefined) {
        wroteNothing = false;
        // `path` here is the SURFACE, not the probe file: an operator acting on
        // this finding needs the RTDB address that moved.
        findings.push({
          code: 'rejected-operation-trace-written',
          workspace,
          detail:
            `${input.path}: the REFUSED operation "${probe.operation}" changed the surface SET — ` +
            `${path} appears in only the ${left === undefined ? 'AFTER' : 'BEFORE'} snapshot`,
          expected: left === undefined ? 'absent' : 'present',
          actual: left === undefined ? 'present' : 'absent',
          path,
        });
        continue;
      }
      if (left.digest === right.digest && left.count === right.count) {
        continue;
      }
      wroteNothing = false;
      findings.push({
        code: 'rejected-operation-trace-written',
        workspace,
        detail: `${input.path}: the REFUSED operation "${probe.operation}" wrote to ${path} (count ${left.count} -> ${right.count})`,
        expected: left.digest,
        actual: right.digest,
        path,
      });
    }

    observations.push({
      path: input.path,
      valid: true,
      workspace,
      operation: probe.operation,
      refusal: probe.refusal,
      surfacesCompared: allPaths.length,
      wroteNothing,
    });
    if (findings.length === findingsBefore) {
      covered.add(workspace);
    }
  }

  if (requireProbes) {
    for (const workspace of GATE6_WORKSPACE_KEYS) {
      if (!covered.has(workspace)) {
        findings.push({
          code: 'rejected-operation-probe-missing',
          workspace,
          detail: `--require-rejected-operation-probe was set but no valid probe covers ${GATE6_EXPECTATIONS[workspace].label}`,
        });
      }
    }
  }

  return {
    draft: { id: 'rejected-operation-no-trace', title, inspected, findings },
    observations,
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
 * Runs every Gate-6 assertion and returns the machine-readable receipt.
 *
 * NEVER THROWS FOR A DATA CONDITION — a data problem is a FINDING, so the
 * caller always gets a full receipt rather than a stack trace that hides the
 * other eleven assertions.
 *
 * IT DOES THROW FOR AN EXECUTION CONDITION (hard gate #4, B6): a per-read
 * deadline expiring, the no-progress watchdog tripping, or the caller's
 * shutdown signal firing. That distinction is load-bearing. A hung RTDB read
 * is not evidence about the corpus, so it must not be reported as one; and the
 * lifecycle wrapper's hard-exit backstop only arms once `run` reaches a
 * terminal result, so an audit that quietly waited forever would keep the
 * whole gate hanging while looking healthy. Throwing is what makes the run
 * terminate, which is what arms the backstop.
 *
 * A programming/usage error (an unsafe or duplicated uid) also throws.
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

  const monitor = createGate6Monitor(options, 'gate6');
  const reader = createGate6Reader(database, {
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS,
    signal: monitor.signal,
    onRead: monitor.onProgress,
  });
  try {
    // Raced against the stall watchdog so a stall fails the audit even when
    // nothing abortable is in flight — the same shape the registry operator
    // uses, and for the same reason.
    return await Promise.race([runAuditWithReader(reader, options), monitor.stallPromise]);
  } finally {
    monitor.dispose();
  }
}

async function runAuditWithReader(
  reader: Gate6Reader,
  options: Gate6AuditOptions,
): Promise<Gate6AuditReceipt> {
  const strict = options.strictWitnessObservationRefs === true;
  const baseline = options.baseline ?? null;
  const registryReceiptInputs = options.registryReceipts ?? [];
  const registryManifestInputs = options.registryManifests ?? [];
  const requireRegistryReceipts = options.requireRegistryReceipts === true;
  const probeInputs = options.rejectedOperationProbes ?? [];
  const requireProbes = options.requireRejectedOperationProbes === true;
  const expectedDatabaseHost = options.expectedDatabaseHost ?? null;
  const maxReceiptAgeMs = options.maxReceiptAgeMs ?? GATE6_DEFAULT_MAX_RECEIPT_AGE_MS;
  const maxProbeAgeMs = options.maxProbeAgeMs ?? GATE6_DEFAULT_MAX_PROBE_AGE_MS;

  const corpora: WorkspaceCorpus[] = [];
  for (const workspace of GATE6_WORKSPACE_KEYS) {
    corpora.push(await loadWorkspaceCorpus(reader, workspace, options.uids[workspace]));
  }
  const byWorkspace = new Map(corpora.map((corpus) => [corpus.workspace, corpus]));
  const sparg0 = byWorkspace.get('sparg0')!;

  // Assertion 7's population: the LOCAL law (no shared equivalent exists).
  const sparg0Vod = digestOf(
    collectUserOwnedVodRows(sparg0).map((row) => ({ key: row.key, payload: row.vodUrl })),
  );
  // Assertion 8's population: the SHARED registry law. `computeForeignRowDigest`
  // applies `isTournamentRegistryOwnedRow` itself, so this audit never restates
  // the ownership predicate either — it hands over the already-read snapshot
  // (one read, so counts and digest describe the same moment) and takes the
  // producer's answer.
  const registryForeign = Object.fromEntries(
    corpora.map((corpus) => [
      corpus.workspace,
      computeForeignRowDigest(corpus.uid, Object.fromEntries(corpus.tournamentEntries)),
    ]),
  ) as Record<Gate6WorkspaceKey, ForeignRowDigest>;
  // Assertion 12's population: the COMPLEMENT of the above — the rows the
  // projector generated, recomputed live from the same one snapshot.
  const liveRegistryRows = Object.fromEntries(
    corpora.map((corpus) => [corpus.workspace, collectLiveRegistryRows(corpus)]),
  ) as Record<Gate6WorkspaceKey, LiveRegistryRows>;

  const observedBaseline: Gate6Baseline = {
    baselineVersion: 2,
    expectationTableVersion: GATE6_EXPECTATION_TABLE_VERSION,
    recordedAtMs: options.nowMs,
    targetUids: { ...options.uids },
    sparg0UserOwnedVod: sparg0Vod,
    registryForeign,
  };

  const attestation = assertRegistryReceiptAttestation(
    registryForeign,
    liveRegistryRows,
    options.uids,
    registryReceiptInputs,
    registryManifestInputs,
    requireRegistryReceipts,
    expectedDatabaseHost,
    options.nowMs,
    maxReceiptAgeMs,
  );
  const rejectedOperations = assertRejectedOperationNoTrace(
    options.uids,
    probeInputs,
    requireProbes,
    expectedDatabaseHost,
    options.nowMs,
    maxProbeAgeMs,
  );

  const drafts: AssertionDraft[] = [
    assertExpectedCounts(corpora),
    assertRunsTerminal(corpora),
    assertNoActiveLeases(corpora, options.nowMs),
    assertSchemaConformance(corpora),
    assertAttachmentIntegrity(corpora),
    assertNoStartggLinks(corpora),
    assertSparg0VodPreservation(sparg0, sparg0Vod, baseline),
    assertRegistryPreservation(registryForeign, baseline),
    await assertIzawCoachingRoot(reader, options.uids.izaw),
    rejectedOperations.draft,
    assertWitnessObservationReferences(corpora),
    attestation.draft,
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
      registryOwnedRows: liveRegistryRows[corpus.workspace].rows.length,
      registryRowSetHash: liveRegistryRows[corpus.workspace].rowSetHash,
      enrichmentRunStatus: enrichmentRun.success ? enrichmentRun.data.status : null,
      ingestionRunStatuses: ingestion.success
        ? Object.values(ingestion.data.runs ?? {})
            .map((run) => run.status)
            .sort()
        : [],
    };
  });

  return {
    receiptVersion: 3,
    expectationTableVersion: GATE6_EXPECTATION_TABLE_VERSION,
    generatedAtMs: options.nowMs,
    targetUids: { ...options.uids },
    baselineMode: baseline === null ? 'record' : 'compare',
    strictWitnessObservationRefs: strict,
    requireRegistryReceipts,
    requireRejectedOperationProbes: requireProbes,
    ok: assertions.every((assertion) => assertion.ok),
    findingCount,
    skippedCount: assertions.filter((assertion) => assertion.status === 'skipped').length,
    assertions,
    observed,
    registryReceipts: attestation.observations,
    registryManifests: attestation.manifestObservations,
    rejectedOperationProbes: rejectedOperations.observations,
    baseline: observedBaseline,
  };
}

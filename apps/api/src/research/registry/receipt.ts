import { z } from 'zod';
import { canonicalDigest } from './canonical.js';
import { registryWorkspaceKeySchema } from './workspaces.js';

/**
 * Phase 30.3 registry-operator hardening (owner directive): the DURABLE
 * PER-ACCOUNT RECEIPT.
 *
 * The enrichment wave's lesson was that a production apply which reports
 * only to a terminal is unauditable after the fact — the operator's memory
 * of "what actually happened to mkleo" is not evidence. Every registry
 * subcommand therefore writes one JSON receipt PER ACCOUNT, on every
 * terminal path (success, refusal, and failure alike), to a path the
 * operator prints.
 *
 * A receipt answers, without needing the console scrollback:
 * - WHICH database (host) and WHICH destination uid was touched;
 * - WHICH reviewed manifest authorized it (`manifestContentHash`);
 * - what the registry looked like before and after (counts);
 * - whether the non-registry rows survived untouched (foreign-row digest,
 *   recorded PRE-apply and POST-apply — see `foreignDigest.ts`);
 * - the terminal status and the exact invariants that failed.
 *
 * It lives beside the projector, not in the CLI, so audit tooling can
 * `validateRegistryReceipt` a file instead of re-implementing the schema.
 * `contentHash` seals the body under the same canonicalization law the
 * manifest uses, so a hand-edited receipt fails validation loudly.
 */

export const REGISTRY_RECEIPT_FORMAT_VERSION = 1;

const hashHexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const registryReceiptCommandSchema = z.enum(['dry-run', 'apply', 'compare']);
export type RegistryReceiptCommand = z.infer<typeof registryReceiptCommandSchema>;

/**
 * Terminal status:
 * - `ok`       — every invariant held.
 * - `refused`  — a PRE-write invariant failed; nothing was written.
 * - `failed`   — the account's work ran and an invariant failed (or the
 *                operation threw). The receipt's `writes` member says
 *                exactly what, if anything, was committed first.
 */
export const registryReceiptStatusSchema = z.enum(['ok', 'refused', 'failed']);
export type RegistryReceiptStatus = z.infer<typeof registryReceiptStatusSchema>;

/** One point-in-time census of `tournamentEntries/{uid}` and the derivation behind it. */
export const registryCountSnapshotSchema = z
  .object({
    /** Children stored under `tournamentEntries/{uid}` in total. */
    entryChildren: z.number().int().nonnegative(),
    /** Of those, children carrying this projector's ownership witness. */
    registryOwnedRows: z.number().int().nonnegative(),
    /** Of those, children that are NOT registry-owned (manual/startgg-sync/parrygg-sync/corrupt). */
    foreignRows: z.number().int().nonnegative(),
    sourceSets: z.number().int().nonnegative(),
    corruptSourceRecords: z.number().int().nonnegative(),
    derivedRows: z.number().int().nonnegative(),
    creates: z.number().int().nonnegative(),
    updates: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    collisions: z.number().int().nonnegative(),
    orphanRemovals: z.number().int().nonnegative(),
  })
  .strict();
export type RegistryCountSnapshot = z.infer<typeof registryCountSnapshotSchema>;

export const foreignRowDigestSchema = z
  .object({
    version: z.number().int().positive(),
    uid: z.string().min(1),
    count: z.number().int().nonnegative(),
    keys: z.array(z.string()),
    digest: hashHexSchema,
  })
  .strict();

export const registryWriteLedgerSchema = z
  .object({
    written: z.array(z.string()),
    removed: z.array(z.string()),
    /** Writes/deletes the projector ABORTED because a foreign value was present at commit time. */
    abortedForeign: z.array(z.string()),
    writesPerformed: z.number().int().nonnegative(),
  })
  .strict();
export type RegistryWriteLedger = z.infer<typeof registryWriteLedgerSchema>;

const receiptBodySchema = z
  .object({
    formatVersion: z.literal(REGISTRY_RECEIPT_FORMAT_VERSION),
    command: registryReceiptCommandSchema,
    workspace: registryWorkspaceKeySchema,
    label: z.string().min(1),
    /** Database IDENTITY — the host the operator was actually pointed at. */
    databaseHost: z.string().min(1),
    /** Destination uid. */
    uid: z.string().min(1),
    /** The reviewed manifest that authorized this run; `null` for `dry-run`, which PRODUCES the manifest. */
    manifestContentHash: hashHexSchema.nullable(),
    manifestGeneratedAtMs: z.number().int().nonnegative().nullable(),
    /** The reviewed per-account row-set hash; `null` for `dry-run`. */
    reviewedRowSetHash: hashHexSchema.nullable(),
    /** The row-set hash the operator actually derived at the START of this run. */
    observedRowSetHash: hashHexSchema,
    startedAtMs: z.number().int().nonnegative(),
    finishedAtMs: z.number().int().nonnegative(),
    status: registryReceiptStatusSchema,
    /** Every invariant that failed, in the order detected. Empty iff `status === 'ok'`. */
    failedInvariants: z.array(z.string()),
    before: registryCountSnapshotSchema,
    after: registryCountSnapshotSchema,
    foreignDigestBefore: foreignRowDigestSchema,
    foreignDigestAfter: foreignRowDigestSchema,
    /** Derived convenience: `foreignDigestBefore.digest === foreignDigestAfter.digest`. */
    foreignDigestStable: z.boolean(),
    /** What the writer committed. `null` for read-only commands and for refusals. */
    writes: registryWriteLedgerSchema.nullable(),
  })
  .strict();
export type RegistryReceiptBody = z.infer<typeof receiptBodySchema>;

export const registryReceiptSchema = receiptBodySchema.extend({
  contentHash: hashHexSchema,
});
export type RegistryReceipt = z.infer<typeof registryReceiptSchema>;

export function computeRegistryReceiptHash(body: RegistryReceiptBody): string {
  return canonicalDigest(receiptBodySchema.parse(body));
}

/**
 * Seals a receipt body. Cross-checks the two derived members the schema
 * cannot express — a receipt that claims `ok` while listing failed
 * invariants (or the reverse) would be worse than no receipt at all.
 */
export function createRegistryReceipt(body: RegistryReceiptBody): RegistryReceipt {
  const parsed = receiptBodySchema.parse(body);
  if ((parsed.status === 'ok') !== (parsed.failedInvariants.length === 0)) {
    throw new Error('Receipt status and failedInvariants disagree');
  }
  if (
    parsed.foreignDigestStable !==
    (parsed.foreignDigestBefore.digest === parsed.foreignDigestAfter.digest)
  ) {
    throw new Error('Receipt foreignDigestStable does not match the recorded digests');
  }
  return { ...parsed, contentHash: computeRegistryReceiptHash(parsed) };
}

/** Parses and integrity-checks a receipt file's contents. Throws on the first violation. */
export function validateRegistryReceipt(raw: unknown): RegistryReceipt {
  const receipt = registryReceiptSchema.parse(raw);
  const { contentHash, ...body } = receipt;
  if (computeRegistryReceiptHash(body) !== contentHash) {
    throw new Error('Receipt content hash mismatch');
  }
  return receipt;
}

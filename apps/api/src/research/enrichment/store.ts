import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  researchEnrichmentAttachmentRecordSchema,
  researchEnrichmentObservationRecordSchema,
  researchEnrichmentResolutionReceiptRecordSchema,
  RESEARCH_ENRICHMENT_PROVIDERS,
  type ResearchEnrichmentAttachmentRecord,
  type ResearchEnrichmentAttachmentSource,
  type ResearchEnrichmentObservationRecord,
  type ResearchEnrichmentResolutionReceiptRecord,
} from '@smash-tracker/shared';
import type { ResearchSourceSetRecord } from '@smash-tracker/shared';
import { isPathSafeTenantId } from '../subjectKind.js';
import { deriveReceiptId } from './resolution.js';

/**
 * Phase 30.2 Plan 07 (ENR-04/ENR-05/ENR-06, cycle-1 review MEDIUM 7,
 * cycle-2 review HIGH 1): the enrichment store, following
 * `apps/api/src/research/ingestion/supplements.ts`'s four ordered write
 * steps verbatim — guard every path segment before constructing a
 * reference, validate rather than sanitize, parse the record with
 * conditional-spread before setting, and safe-parse each child
 * independently on read.
 *
 * This module never mutates a provider record, performs no authorization of
 * its own (the route layer's `requireResearchTenantAdmin` in
 * `apps/api/src/routes/research.ts` is the single authorization site for
 * this family), and emits nothing.
 *
 * Storage layout:
 * - `researchEnrichmentObservations/{tenantId}/{observationId}`
 * - `researchEnrichmentReceipts/{tenantId}/{observationId}`
 * - `researchEnrichmentAttachments/{tenantId}/{targetSetId}/{observationId}`
 *
 * THE STRUCTURAL BARRIER (this module's whole reason to exist): a matching
 * status stored on an observation record is NOT the barrier — and neither
 * is a type-narrowed function parameter, because type narrowing does not
 * exist at RUNTIME. An earlier draft had `attachResolvedObservation` accept
 * a type-narrowed `matched` outcome object and check only its tag and
 * confidence at runtime; a caller inside this package could hand it a
 * hand-built `{ tag: 'matched', confidence: 'high', targetSetId }` object
 * and open the barrier (cycle-1 review MEDIUM 7). `attachResolvedObservation`
 * below therefore takes IDENTIFIERS ONLY — an observation id and a receipt
 * id, never a record, never an outcome, never a target set id, never a
 * confidence — and RELOADS both the stored observation and its persisted
 * receipt from the database before writing anything. A record whose status
 * member has been forged still creates no attachment; a caller who ALSO
 * forges the candidate list still creates no attachment, because the
 * receipt lives in a DIFFERENT tree, bound to the observation's content
 * hash, and is never trusted merely for existing (cycle-2 review HIGH 1):
 * `writeResolutionReceipt` itself reloads the stored observation and
 * recomputes the receipt's own id from its content before ever persisting
 * it, so a fingerprint-copied fabricated receipt cannot even enter the
 * receipt tree.
 */

export type EnrichmentStoreOutcome =
  | 'created'
  | 'replaced'
  | 'rejected-key'
  | 'rejected-provenance'
  | 'rejected-not-attachable'
  | 'rejected-no-receipt'
  | 'rejected-receipt-mismatch'
  | 'rejected-candidate';

function observationRef(database: Database, tenantId: string, observationId: string) {
  return database.ref(`researchEnrichmentObservations/${tenantId}/${observationId}`);
}

function observationsRef(database: Database, tenantId: string) {
  return database.ref(`researchEnrichmentObservations/${tenantId}`);
}

function receiptRef(database: Database, tenantId: string, observationId: string) {
  return database.ref(`researchEnrichmentReceipts/${tenantId}/${observationId}`);
}

function attachmentRef(
  database: Database,
  tenantId: string,
  targetSetId: string,
  observationId: string,
) {
  return database.ref(`researchEnrichmentAttachments/${tenantId}/${targetSetId}/${observationId}`);
}

function attachmentsForSetRef(database: Database, tenantId: string, targetSetId: string) {
  return database.ref(`researchEnrichmentAttachments/${tenantId}/${targetSetId}`);
}

function attachmentsTreeRef(database: Database, tenantId: string) {
  return database.ref(`researchEnrichmentAttachments/${tenantId}`);
}

// ---------------------------------------------------------------------------
// Observation write / read
// ---------------------------------------------------------------------------

export interface WriteEnrichmentObservationResult {
  outcome: EnrichmentStoreOutcome;
}

/**
 * Writes one observation at its own key. Guards every path segment before
 * constructing a reference (rejected-key, no write). Rejects a provider
 * other than the Liquipedia literal (rejected-provenance, no write) — a
 * defensive runtime check alongside the schema's own single-member enum,
 * since this function's caller is not guaranteed to be type-checked code.
 * Idempotent per observation id: an identical replay REPLACES in place,
 * never duplicating a child.
 */
export async function writeEnrichmentObservation(
  database: Database,
  tenantId: string,
  record: ResearchEnrichmentObservationRecord,
): Promise<WriteEnrichmentObservationResult> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(record.observationId)) {
    return { outcome: 'rejected-key' };
  }
  if (!(RESEARCH_ENRICHMENT_PROVIDERS as readonly string[]).includes(record.sourceProvider)) {
    return { outcome: 'rejected-provenance' };
  }

  const ref = observationRef(database, tenantId, record.observationId);
  const existing = await ref.get();
  const isNew = !existing.exists();

  const parsed = researchEnrichmentObservationRecordSchema.parse(record);
  await ref.set(parsed);

  return { outcome: isNew ? 'created' : 'replaced' };
}

/** Guards every path segment before constructing a reference; returns null (never throws) for an unsafe id or an unparseable/absent record. */
export async function readEnrichmentObservation(
  database: Database,
  tenantId: string,
  observationId: string,
): Promise<ResearchEnrichmentObservationRecord | null> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(observationId)) {
    return null;
  }
  const snapshot = await observationRef(database, tenantId, observationId).get();
  if (!snapshot.exists()) {
    return null;
  }
  const parsed = researchEnrichmentObservationRecordSchema.safeParse(snapshot.val());
  return parsed.success ? parsed.data : null;
}

/** Safe-parses every child independently (one malformed sibling never hides the rest); returns an empty array for an unsafe tenant id. */
export async function listEnrichmentObservations(
  database: Database,
  tenantId: string,
): Promise<ResearchEnrichmentObservationRecord[]> {
  if (!isPathSafeTenantId(tenantId)) {
    return [];
  }
  const snapshot = await observationsRef(database, tenantId).get();
  if (!snapshot.exists()) {
    return [];
  }
  const raw = snapshot.val() as Record<string, unknown>;
  return Object.values(raw).flatMap((value) => {
    const parsed = researchEnrichmentObservationRecordSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

// ---------------------------------------------------------------------------
// Resolution receipt write / read
// ---------------------------------------------------------------------------

export interface WriteResolutionReceiptResult {
  outcome: EnrichmentStoreOutcome;
}

/**
 * Persists a receipt built by `resolution.ts`'s `buildResolutionReceipt` to
 * `researchEnrichmentReceipts/{tenantId}/{observationId}`, parsed through
 * `researchEnrichmentResolutionReceiptRecordSchema` before the write so the
 * schema's own single-candidate invariant is enforced at the boundary.
 *
 * Does NOT trust the caller's object beyond schema shape (cycle-2 review
 * HIGH 1): before writing, this function RELOADS the stored observation at
 * the receipt's own `observationId` and refuses (`rejected-receipt-
 * mismatch`, no write) unless the receipt's fingerprint members equal the
 * STORED observation's, AND it RECOMPUTES the deterministic `receiptId`
 * from the receipt's own content (the same derivation
 * `buildResolutionReceipt` uses) and refuses unless the recomputed id
 * equals the receipt's stated `receiptId`. A fingerprint-copied fabricated
 * receipt is therefore rejected at persist time — the receipt tree only
 * ever holds receipts that BOTH corroborate a stored observation AND
 * self-derive their own id.
 */
export async function writeResolutionReceipt(
  database: Database,
  tenantId: string,
  receipt: ResearchEnrichmentResolutionReceiptRecord,
): Promise<WriteResolutionReceiptResult> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(receipt.observationId)) {
    return { outcome: 'rejected-key' };
  }

  const shapeParsed = researchEnrichmentResolutionReceiptRecordSchema.safeParse(receipt);
  if (!shapeParsed.success) {
    return { outcome: 'rejected-receipt-mismatch' };
  }

  const storedRecord = await readEnrichmentObservation(database, tenantId, receipt.observationId);
  if (!storedRecord) {
    return { outcome: 'rejected-receipt-mismatch' };
  }

  const fingerprintMatches =
    receipt.sourceRevisionId === storedRecord.sourceRevisionId &&
    receipt.sourceContentHash === storedRecord.sourceContentHash &&
    receipt.parserVersion === storedRecord.parserVersion;
  if (!fingerprintMatches) {
    return { outcome: 'rejected-receipt-mismatch' };
  }

  const recomputedReceiptId = deriveReceiptId({
    observationId: receipt.observationId,
    resolverVersion: receipt.resolverVersion,
    sourceContentHash: receipt.sourceContentHash,
  });
  if (recomputedReceiptId !== receipt.receiptId) {
    return { outcome: 'rejected-receipt-mismatch' };
  }

  const ref = receiptRef(database, tenantId, receipt.observationId);
  const existing = await ref.get();
  const isNew = !existing.exists();
  await ref.set(shapeParsed.data);

  return { outcome: isNew ? 'created' : 'replaced' };
}

/** Guards every path segment before constructing a reference; returns null (never throws) for an unsafe id or an unparseable/absent record. */
export async function readResolutionReceipt(
  database: Database,
  tenantId: string,
  observationId: string,
): Promise<ResearchEnrichmentResolutionReceiptRecord | null> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(observationId)) {
    return null;
  }
  const snapshot = await receiptRef(database, tenantId, observationId).get();
  if (!snapshot.exists()) {
    return null;
  }
  const parsed = researchEnrichmentResolutionReceiptRecordSchema.safeParse(snapshot.val());
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Attachment writers — the structural barrier
// ---------------------------------------------------------------------------

export interface AttachResolvedObservationResult {
  outcome: EnrichmentStoreOutcome;
}

/**
 * THE STRUCTURAL BARRIER. Takes IDENTIFIERS ONLY — never a record, never an
 * outcome, never a target set id, never a confidence. Everything this
 * function decides on is RELOADED from the database inside the function
 * body, so a fabricated in-memory claim has nothing to fabricate against.
 *
 * 1. Guard `tenantId`/`observationId` — `rejected-key`, no write.
 * 2. Reload the stored observation — absent/unparseable ->
 *    `rejected-not-attachable`.
 * 3. Reload the stored receipt at the observation's own key — absent ->
 *    `rejected-no-receipt`.
 * 4. Require the reloaded receipt's `receiptId` to equal the SUPPLIED
 *    `receiptId`, RECOMPUTE the deterministic id from the reloaded
 *    receipt's own content and require it to equal BOTH (cycle-2 review
 *    HIGH 1 — a stored-but-tampered receipt whose id no longer derives from
 *    its content is refused even though it was read from the receipt
 *    tree), require the receipt's `observationId` to equal the reloaded
 *    observation's, require `confidence` to be the literal high, require
 *    `candidateTargetSetIds` to have length exactly 1, and require that
 *    single candidate to equal `targetSetId` — any failure ->
 *    `rejected-receipt-mismatch`.
 * 5. Require the receipt's fingerprint (`sourceRevisionId`,
 *    `sourceContentHash`, `parserVersion`) to equal the reloaded
 *    observation's — any failure -> `rejected-receipt-mismatch`.
 * 6. Only then write the attachment, with `attachmentSource: 'resolver'`
 *    and the `receiptId` recorded on it.
 */
export async function attachResolvedObservation(
  database: Database,
  tenantId: string,
  observationId: string,
  receiptId: string,
  nowMs: number,
): Promise<AttachResolvedObservationResult> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(observationId)) {
    return { outcome: 'rejected-key' };
  }

  const storedRecord = await readEnrichmentObservation(database, tenantId, observationId);
  if (!storedRecord) {
    return { outcome: 'rejected-not-attachable' };
  }

  const storedReceipt = await readResolutionReceipt(database, tenantId, observationId);
  if (!storedReceipt) {
    return { outcome: 'rejected-no-receipt' };
  }

  const recomputedReceiptId = deriveReceiptId({
    observationId: storedReceipt.observationId,
    resolverVersion: storedReceipt.resolverVersion,
    sourceContentHash: storedReceipt.sourceContentHash,
  });

  const receiptSelfConsistent =
    storedReceipt.receiptId === receiptId &&
    recomputedReceiptId === receiptId &&
    recomputedReceiptId === storedReceipt.receiptId &&
    storedReceipt.observationId === storedRecord.observationId &&
    storedReceipt.confidence === 'high' &&
    storedReceipt.candidateTargetSetIds.length === 1 &&
    storedReceipt.candidateTargetSetIds[0] === storedReceipt.targetSetId;
  if (!receiptSelfConsistent) {
    return { outcome: 'rejected-receipt-mismatch' };
  }

  const fingerprintMatches =
    storedReceipt.sourceRevisionId === storedRecord.sourceRevisionId &&
    storedReceipt.sourceContentHash === storedRecord.sourceContentHash &&
    storedReceipt.parserVersion === storedRecord.parserVersion;
  if (!fingerprintMatches) {
    return { outcome: 'rejected-receipt-mismatch' };
  }

  const attachment = researchEnrichmentAttachmentRecordSchema.parse({
    observationId: storedRecord.observationId,
    targetSetId: storedReceipt.targetSetId,
    attachmentSource: 'resolver',
    attachedAtMs: nowMs,
    sourceRevisionId: storedRecord.sourceRevisionId,
    sourceContentHash: storedRecord.sourceContentHash,
    parserVersion: storedRecord.parserVersion,
    receiptId: storedReceipt.receiptId,
    ...(storedReceipt.evidence != null ? { matchEvidence: storedReceipt.evidence } : {}),
  } satisfies ResearchEnrichmentAttachmentRecord);

  const ref = attachmentRef(database, tenantId, storedReceipt.targetSetId, observationId);
  const existing = await ref.get();
  const isNew = !existing.exists();
  await ref.set(attachment);

  return { outcome: isNew ? 'created' : 'replaced' };
}

export interface ConfirmEnrichmentObservationByAdminResult {
  outcome: EnrichmentStoreOutcome;
}

/**
 * The SECOND and only other door — the deliberate human action. Requires
 * the supplied target set id to be a member of the STORED observation's
 * recorded candidate list (mirrors the shipped identity-confirmation rule
 * in `apps/api/src/research/ingestion/identity.ts`: a candidate is never
 * promoted by any writer other than an explicit admin action). Does NOT
 * require a receipt — that is exactly what distinguishes this door from the
 * automatic one.
 */
export async function confirmEnrichmentObservationByAdmin(
  database: Database,
  tenantId: string,
  observationId: string,
  targetSetId: string,
  adminUid: string,
  nowMs: number,
): Promise<ConfirmEnrichmentObservationByAdminResult> {
  if (
    !isPathSafeTenantId(tenantId) ||
    !isPathSafeProviderId(observationId) ||
    !isPathSafeProviderId(targetSetId)
  ) {
    return { outcome: 'rejected-key' };
  }

  const storedRecord = await readEnrichmentObservation(database, tenantId, observationId);
  if (!storedRecord) {
    return { outcome: 'rejected-not-attachable' };
  }

  const candidates = storedRecord.candidateTargetSetIds ?? [];
  if (!candidates.includes(targetSetId)) {
    return { outcome: 'rejected-candidate' };
  }

  const attachment = researchEnrichmentAttachmentRecordSchema.parse({
    observationId: storedRecord.observationId,
    targetSetId,
    attachmentSource: 'admin',
    attachedAtMs: nowMs,
    sourceRevisionId: storedRecord.sourceRevisionId,
    sourceContentHash: storedRecord.sourceContentHash,
    parserVersion: storedRecord.parserVersion,
    confirmedByUid: adminUid,
    confirmedAtMs: nowMs,
  } satisfies ResearchEnrichmentAttachmentRecord);

  const ref = attachmentRef(database, tenantId, targetSetId, observationId);
  const existing = await ref.get();
  const isNew = !existing.exists();
  await ref.set(attachment);

  return { outcome: isNew ? 'created' : 'replaced' };
}

/** Removes exactly one attachment, leaving the observation itself in place — the observation moves back into the review queue (`listEnrichmentReviewQueue` selects by attachment ABSENCE, never by the observation's own stored status). */
export async function deleteEnrichmentAttachment(
  database: Database,
  tenantId: string,
  targetSetId: string,
  observationId: string,
): Promise<{ ok: true }> {
  if (
    !isPathSafeTenantId(tenantId) ||
    !isPathSafeProviderId(targetSetId) ||
    !isPathSafeProviderId(observationId)
  ) {
    return { ok: true };
  }
  await attachmentRef(database, tenantId, targetSetId, observationId).remove();
  return { ok: true };
}

/** Safe-parses every child independently; returns an empty array for an unsafe tenant/target-set id or an absent subtree. */
export async function listAttachmentsForSet(
  database: Database,
  tenantId: string,
  targetSetId: string,
): Promise<ResearchEnrichmentAttachmentRecord[]> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(targetSetId)) {
    return [];
  }
  const snapshot = await attachmentsForSetRef(database, tenantId, targetSetId).get();
  if (!snapshot.exists()) {
    return [];
  }
  const raw = snapshot.val() as Record<string, unknown>;
  return Object.values(raw).flatMap((value) => {
    const parsed = researchEnrichmentAttachmentRecordSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Every observation id that currently has AT LEAST ONE attachment,
 * discovered by ONE read of the whole tenant attachment tree (a
 * `nested-two-level` shape — `{targetSetId}/{observationId}` — mirroring
 * `apps/api/src/research/migration/manifest.ts`'s `enumerateRecords`
 * `nested-two-level` walk).
 */
async function collectAttachedObservationIds(
  database: Database,
  tenantId: string,
): Promise<Set<string>> {
  const attached = new Set<string>();
  if (!isPathSafeTenantId(tenantId)) {
    return attached;
  }
  const snapshot = await attachmentsTreeRef(database, tenantId).get();
  const raw = snapshot.val() as Record<string, Record<string, unknown>> | null;
  if (raw === null || typeof raw !== 'object') {
    return attached;
  }
  for (const children of Object.values(raw)) {
    if (children === null || typeof children !== 'object') {
      continue;
    }
    for (const [observationId, value] of Object.entries(children)) {
      const parsed = researchEnrichmentAttachmentRecordSchema.safeParse(value);
      if (parsed.success) {
        attached.add(observationId);
      }
    }
  }
  return attached;
}

export interface RemoveSupersededObservationsResult {
  removedObservationIds: string[];
}

/**
 * 30.2 defect-C re-key reconciliation: removes a caller-identified set of
 * SUPERSEDED observations, cascading each one's derived state — its
 * attachments (found by one read of the tenant attachment tree) and its
 * resolution receipt — before the observation record itself.
 *
 * THE PROVABLY-OURS CONTRACT: the caller (the run driver's per-page
 * supersede pass) may name ONLY observations it has just re-extracted past —
 * records under this tenant's own observation tree, for a page this run
 * re-extracted, whose stored `parserVersion` differs from the version the
 * current extraction used. A record at the CURRENT parser version is never
 * eligible (a same-version count shrink is `refresh.ts`'s shrink-guard
 * jurisdiction, never silently deleted here). Projection WITNESSES that
 * reference a removed observation id are deliberately left in place: the
 * attribution schema tolerates a missing referenced observation, and the
 * witness's value-comparison ownership rule keeps a dangling reference
 * inert.
 */
export async function removeSupersededObservations(
  database: Database,
  tenantId: string,
  observationIds: string[],
): Promise<RemoveSupersededObservationsResult> {
  if (!isPathSafeTenantId(tenantId) || observationIds.length === 0) {
    return { removedObservationIds: [] };
  }
  const staleIds = observationIds.filter((observationId) => isPathSafeProviderId(observationId));
  if (staleIds.length === 0) {
    return { removedObservationIds: [] };
  }

  const attachmentsSnapshot = await attachmentsTreeRef(database, tenantId).get();
  const targetSetIdsByObservationId = new Map<string, string[]>();
  const rawAttachments = attachmentsSnapshot.val() as Record<
    string,
    Record<string, unknown>
  > | null;
  if (rawAttachments !== null && typeof rawAttachments === 'object') {
    for (const [targetSetId, children] of Object.entries(rawAttachments)) {
      if (children === null || typeof children !== 'object') {
        continue;
      }
      for (const observationId of Object.keys(children)) {
        const sets = targetSetIdsByObservationId.get(observationId) ?? [];
        sets.push(targetSetId);
        targetSetIdsByObservationId.set(observationId, sets);
      }
    }
  }

  const removedObservationIds: string[] = [];
  for (const observationId of staleIds) {
    for (const targetSetId of targetSetIdsByObservationId.get(observationId) ?? []) {
      if (isPathSafeProviderId(targetSetId)) {
        await attachmentRef(database, tenantId, targetSetId, observationId).remove();
      }
    }
    await receiptRef(database, tenantId, observationId).remove();
    await observationRef(database, tenantId, observationId).remove();
    removedObservationIds.push(observationId);
  }
  return { removedObservationIds };
}

/**
 * Every target set id that currently has AT LEAST ONE parseable attachment —
 * the reconciliation universe for a resumed run (30.2 reliability gate): a
 * crash between "attachment written" and "projection applied" leaves a set
 * in this list with no witness for its overlay keys, and ONLY a reader of
 * this list can find it again (the review queue can't — the observation is
 * attached and therefore no longer queued). One read of the whole tenant
 * attachment tree, same walk as `collectAttachedObservationIds`.
 */
export async function listAttachedTargetSetIds(
  database: Database,
  tenantId: string,
): Promise<string[]> {
  if (!isPathSafeTenantId(tenantId)) {
    return [];
  }
  const snapshot = await attachmentsTreeRef(database, tenantId).get();
  const raw = snapshot.val() as Record<string, Record<string, unknown>> | null;
  if (raw === null || typeof raw !== 'object') {
    return [];
  }
  const targetSetIds: string[] = [];
  for (const [targetSetId, children] of Object.entries(raw)) {
    if (children === null || typeof children !== 'object') {
      continue;
    }
    const hasParseableAttachment = Object.values(children).some(
      (value) => researchEnrichmentAttachmentRecordSchema.safeParse(value).success,
    );
    if (hasParseableAttachment) {
      targetSetIds.push(targetSetId);
    }
  }
  return targetSetIds.sort((a, b) => a.localeCompare(b));
}

/**
 * Returns every observation that does NOT currently have an attachment, in
 * DETERMINISTIC order (sorted by `observationId` — RTDB child iteration
 * order is not a contract). Selection is by attachment ABSENCE alone, never
 * by the observation's own stored `matchingStatus` — a `matched` status
 * with no real attachment (the forged-status adversarial case) still
 * appears here, and deleting an attachment moves its observation back into
 * this list on the very next read.
 */
export async function listEnrichmentReviewQueue(
  database: Database,
  tenantId: string,
): Promise<ResearchEnrichmentObservationRecord[]> {
  const [observations, attachedIds] = await Promise.all([
    listEnrichmentObservations(database, tenantId),
    collectAttachedObservationIds(database, tenantId),
  ]);
  return observations
    .filter((record) => !attachedIds.has(record.observationId))
    .sort((a, b) => a.observationId.localeCompare(b.observationId));
}

// ---------------------------------------------------------------------------
// Overlay — the anti-masquerade sibling reader
// ---------------------------------------------------------------------------

export interface EnrichmentOverlayEntry {
  observationId: string;
  attachmentSource: ResearchEnrichmentAttachmentSource;
  attachedAtMs: number;
  record: ResearchEnrichmentObservationRecord;
}

export interface ResearchEnrichmentOverlay {
  provider: ResearchSourceSetRecord;
  enriched: EnrichmentOverlayEntry[];
}

/**
 * A PURE function, copying the reason from `overlaySupplements` (ING-08):
 * the provider record is returned by REFERENCE under `provider` with
 * nothing added, removed, or changed, and every attached observation lands
 * in a SIBLING `enriched` list. A shallow-merge helper is deliberately NOT
 * provided anywhere in this module, because a merged object is exactly the
 * shape in which an enrichment could masquerade as a start.gg fact
 * (ENR-04) — including when an enrichment's field name would collide with
 * a provider field.
 */
export function overlayEnrichment(
  providerRecord: ResearchSourceSetRecord,
  attachments: ResearchEnrichmentAttachmentRecord[],
  observationsById: Record<string, ResearchEnrichmentObservationRecord>,
): ResearchEnrichmentOverlay {
  const enriched: EnrichmentOverlayEntry[] = [];
  for (const attachment of attachments) {
    const record = observationsById[attachment.observationId];
    if (!record) {
      // An attachment naming an observation the caller never loaded is
      // skipped, never fabricated — this function reads exactly what it is
      // handed and invents nothing.
      continue;
    }
    enriched.push({
      observationId: attachment.observationId,
      attachmentSource: attachment.attachmentSource,
      attachedAtMs: attachment.attachedAtMs,
      record,
    });
  }
  return { provider: providerRecord, enriched };
}

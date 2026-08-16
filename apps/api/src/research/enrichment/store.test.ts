import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import {
  LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
  LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
  type ResearchEnrichmentObservationRecord,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { buildResolutionReceipt, deriveReceiptId, type ResolutionOutcome } from './resolution.js';
import {
  attachResolvedObservation,
  confirmEnrichmentObservationByAdmin,
  deleteEnrichmentAttachment,
  listAttachmentsForSet,
  listEnrichmentObservations,
  listEnrichmentReviewQueue,
  overlayEnrichment,
  readEnrichmentObservation,
  readResolutionReceipt,
  sweepOutdatedFamilyObservations,
  writeEnrichmentObservation,
  writeResolutionReceipt,
} from './store.js';

const TENANT_ID = 'tenant-1';
const TARGET_SET_ID = 'startgg-set-1';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function makeObservationRecord(
  overrides: Partial<ResearchEnrichmentObservationRecord> = {},
): ResearchEnrichmentObservationRecord {
  return {
    observationId: 'obs-1',
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: 'Supernova/2026/Ultimate/Singles Bracket',
    sourcePageUrl: 'https://liquipedia.net/smash/Supernova/2026/Ultimate/Singles_Bracket',
    sourceRevisionId: 100,
    sourceContentHash: 'a'.repeat(64),
    parserVersion: 'liquipedia-bracket-legacy@1',
    templateFamily: 'legacy',
    fetchedAtMs: 1000,
    observedAtMs: 1000,
    matchingStatus: 'unmatched',
    candidateTargetSetIds: [TARGET_SET_ID],
    ...overrides,
  };
}

/** A genuine `matched` outcome the resolver could have produced — used to build a genuine receipt via `buildResolutionReceipt` without re-exercising `resolution.ts`'s own ladder tests. */
function matchedOutcomeFor(targetSetId: string): ResolutionOutcome {
  return { type: 'matched', targetSetId, confidence: 'high', evidence: ['slug-anchor'] };
}

async function seedGenuineReceipt(
  database: FakeDatabase,
  record: ResearchEnrichmentObservationRecord,
  nowMs: number,
) {
  await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
  const receipt = buildResolutionReceipt(record, matchedOutcomeFor(TARGET_SET_ID), nowMs)!;
  const receiptResult = await writeResolutionReceipt(asDatabase(database), TENANT_ID, receipt);
  return { receipt, receiptResult };
}

// ---------------------------------------------------------------------------
// writeEnrichmentObservation / readEnrichmentObservation / listEnrichmentObservations
// ---------------------------------------------------------------------------

describe('writeEnrichmentObservation', () => {
  it('returns created the first time and replaced on an identical replay, with no duplicate child', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();

    const first = await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
    expect(first.outcome).toBe('created');

    const second = await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
    expect(second.outcome).toBe('replaced');

    const stored = database.dump().researchEnrichmentObservations as Record<string, unknown>;
    expect(Object.keys(stored[TENANT_ID] as Record<string, unknown>)).toEqual(['obs-1']);
  });

  it('rejects an unsafe tenant id with rejected-key and writes nothing', async () => {
    const database = new FakeDatabase();
    const result = await writeEnrichmentObservation(
      asDatabase(database),
      'unsafe/tenant',
      makeObservationRecord(),
    );
    expect(result.outcome).toBe('rejected-key');
    expect(database.dump().researchEnrichmentObservations).toBeUndefined();
  });

  it('rejects an unsafe observation id with rejected-key and writes nothing', async () => {
    const database = new FakeDatabase();
    const result = await writeEnrichmentObservation(
      asDatabase(database),
      TENANT_ID,
      makeObservationRecord({ observationId: 'unsafe/id' }),
    );
    expect(result.outcome).toBe('rejected-key');
    expect(database.dump().researchEnrichmentObservations).toBeUndefined();
  });

  it('rejects a provider other than the Liquipedia literal with rejected-provenance and writes nothing', async () => {
    const database = new FakeDatabase();
    const record = {
      ...makeObservationRecord(),
      sourceProvider: 'startgg',
    } as unknown as ResearchEnrichmentObservationRecord;
    const result = await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
    expect(result.outcome).toBe('rejected-provenance');
    expect(database.dump().researchEnrichmentObservations).toBeUndefined();
  });
});

describe('readEnrichmentObservation / listEnrichmentObservations', () => {
  it('reads back a written observation', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    const read = await readEnrichmentObservation(asDatabase(database), TENANT_ID, 'obs-1');
    expect(read?.observationId).toBe('obs-1');
  });

  it('lists every observation for a tenant, skipping one malformed sibling', async () => {
    const database = new FakeDatabase();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, makeObservationRecord());
    database.seed(`researchEnrichmentObservations/${TENANT_ID}/obs-bad`, { not: 'valid' });

    const list = await listEnrichmentObservations(asDatabase(database), TENANT_ID);
    expect(list).toHaveLength(1);
    expect(list[0]!.observationId).toBe('obs-1');
  });
});

// ---------------------------------------------------------------------------
// writeResolutionReceipt
// ---------------------------------------------------------------------------

describe('writeResolutionReceipt', () => {
  it('persists a genuine receipt for a matched outcome, at the observation key, created then replaced', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
    const receipt = buildResolutionReceipt(record, matchedOutcomeFor(TARGET_SET_ID), 5000)!;

    const first = await writeResolutionReceipt(asDatabase(database), TENANT_ID, receipt);
    expect(first.outcome).toBe('created');

    const second = await writeResolutionReceipt(asDatabase(database), TENANT_ID, receipt);
    expect(second.outcome).toBe('replaced');

    const read = await readResolutionReceipt(asDatabase(database), TENANT_ID, 'obs-1');
    expect(read?.targetSetId).toBe(TARGET_SET_ID);
  });

  it('refuses a receipt whose single candidate does not equal its target set id (schema boundary)', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
    const badReceipt = {
      receiptId: 'whatever',
      observationId: 'obs-1',
      targetSetId: TARGET_SET_ID,
      confidence: 'high' as const,
      resolvedAtMs: 5000,
      resolverVersion: 'liquipedia-resolver@1',
      sourceRevisionId: record.sourceRevisionId,
      sourceContentHash: record.sourceContentHash,
      parserVersion: record.parserVersion,
      candidateTargetSetIds: ['some-other-set'],
    };
    const result = await writeResolutionReceipt(asDatabase(database), TENANT_ID, badReceipt);
    expect(result.outcome).toBe('rejected-receipt-mismatch');
  });

  it('rejects a receipt for an unsafe tenant id and writes nothing', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
    const receipt = buildResolutionReceipt(record, matchedOutcomeFor(TARGET_SET_ID), 5000)!;

    const result = await writeResolutionReceipt(asDatabase(database), 'unsafe/tenant', receipt);
    expect(result.outcome).toBe('rejected-key');
  });

  it('ADVERSARIAL (cycle-2 review HIGH 1): refuses a fabricated receipt whose receiptId does not derive from its own content, even when its fingerprint copies the real observation', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    const fabricatedReceipt = {
      receiptId: 'not-a-derived-id',
      observationId: record.observationId,
      targetSetId: TARGET_SET_ID,
      confidence: 'high' as const,
      resolvedAtMs: 5000,
      resolverVersion: 'liquipedia-resolver@1',
      sourceRevisionId: record.sourceRevisionId,
      sourceContentHash: record.sourceContentHash,
      parserVersion: record.parserVersion,
      candidateTargetSetIds: [TARGET_SET_ID],
    };

    const result = await writeResolutionReceipt(asDatabase(database), TENANT_ID, fabricatedReceipt);

    expect(result.outcome).toBe('rejected-receipt-mismatch');
    const stored = database.dump().researchEnrichmentReceipts as
      Record<string, unknown> | undefined;
    expect(stored).toBeUndefined();
  });

  it('ADVERSARIAL (cycle-2 review HIGH 1): refuses a fabricated receipt whose receiptId IS self-consistent but whose fingerprint does not match the stored observation', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    const fabricatedFingerprint = {
      sourceRevisionId: 999,
      sourceContentHash: 'f'.repeat(64),
      parserVersion: 'a-different-parser@9',
    };
    const selfConsistentId = deriveReceiptId({
      observationId: record.observationId,
      resolverVersion: 'liquipedia-resolver@1',
      sourceContentHash: fabricatedFingerprint.sourceContentHash,
    });
    const fabricatedReceipt = {
      receiptId: selfConsistentId,
      observationId: record.observationId,
      targetSetId: TARGET_SET_ID,
      confidence: 'high' as const,
      resolvedAtMs: 5000,
      resolverVersion: 'liquipedia-resolver@1',
      ...fabricatedFingerprint,
      candidateTargetSetIds: [TARGET_SET_ID],
    };

    const result = await writeResolutionReceipt(asDatabase(database), TENANT_ID, fabricatedReceipt);

    expect(result.outcome).toBe('rejected-receipt-mismatch');
    const stored = database.dump().researchEnrichmentReceipts as
      Record<string, unknown> | undefined;
    expect(stored).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// attachResolvedObservation — the structural barrier
// ---------------------------------------------------------------------------

describe('attachResolvedObservation', () => {
  it('creates an attachment only when a genuine, persisted receipt exists — created then replaced on replay', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await seedGenuineReceipt(database, record, 5000);
    const receipt = (await readResolutionReceipt(asDatabase(database), TENANT_ID, 'obs-1'))!;

    const first = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      receipt.receiptId,
      6000,
    );
    expect(first.outcome).toBe('created');

    const second = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      receipt.receiptId,
      6001,
    );
    expect(second.outcome).toBe('replaced');

    const attachments = await listAttachmentsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.attachmentSource).toBe('resolver');
    expect(attachments[0]!.receiptId).toBe(receipt.receiptId);
  });

  it('takes no record or outcome parameter — reloads both from the database', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await seedGenuineReceipt(database, record, 5000);
    const receipt = (await readResolutionReceipt(asDatabase(database), TENANT_ID, 'obs-1'))!;

    // The call site itself is the proof: only identifiers are passed.
    const result = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      record.observationId,
      receipt.receiptId,
      6000,
    );
    expect(result.outcome).toBe('created');
  });

  it('rejects an unsafe tenant/observation id with rejected-key and writes nothing', async () => {
    const database = new FakeDatabase();
    const result = await attachResolvedObservation(
      asDatabase(database),
      'unsafe/tenant',
      'obs-1',
      'receipt-1',
      6000,
    );
    expect(result.outcome).toBe('rejected-key');
    expect(database.dump().researchEnrichmentAttachments).toBeUndefined();
  });

  it('rejects an attempt against an observation that does not exist with rejected-not-attachable', async () => {
    const database = new FakeDatabase();
    const result = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'nonexistent-obs',
      'receipt-1',
      6000,
    );
    expect(result.outcome).toBe('rejected-not-attachable');
  });

  it('an attachment attempt with no persisted receipt returns rejected-no-receipt and writes nothing', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    const result = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      'some-plausible-receipt-id',
      6000,
    );

    expect(result.outcome).toBe('rejected-no-receipt');
    expect(database.dump().researchEnrichmentAttachments).toBeUndefined();
  });

  it('refuses when the supplied receiptId does not equal the stored receipt', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await seedGenuineReceipt(database, record, 5000);

    const result = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      'a-different-receipt-id',
      6000,
    );
    expect(result.outcome).toBe('rejected-receipt-mismatch');
  });

  it('a fingerprint mismatch between the reloaded receipt and the reloaded observation returns rejected-receipt-mismatch and writes nothing', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await seedGenuineReceipt(database, record, 5000);
    const receipt = (await readResolutionReceipt(asDatabase(database), TENANT_ID, 'obs-1'))!;

    // Simulate a refresh: the stored observation's content hash changes
    // after the receipt was written against the OLD content.
    database.seed(
      `researchEnrichmentObservations/${TENANT_ID}/obs-1/sourceContentHash`,
      'c'.repeat(64),
    );

    const result = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      receipt.receiptId,
      6000,
    );

    expect(result.outcome).toBe('rejected-receipt-mismatch');
    expect(database.dump().researchEnrichmentAttachments).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // MANDATORY adversarial tests (cycle-1 review MEDIUM 7 / cycle-2 review HIGH 1)
  // -------------------------------------------------------------------------

  it('ADVERSARIAL: a hand-forged matchingStatus on the stored observation creates NO attachment when driven through the writer', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    // Forge the stored status directly through the database, bypassing every writer.
    database.seed(`researchEnrichmentObservations/${TENANT_ID}/obs-1/matchingStatus`, 'matched');

    const result = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      'a-plausible-receipt-id',
      6000,
    );

    expect(result.outcome).toBe('rejected-no-receipt');
    expect(database.dump().researchEnrichmentAttachments).toBeUndefined();

    const attachments = await listAttachmentsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    expect(attachments).toEqual([]);

    const providerRecord = {
      providerSetId: TARGET_SET_ID,
      classification: 'complete',
      ruleId: 'R',
      apiIds: { setId: TARGET_SET_ID },
      ingestionRunId: 'run-1',
      fetchedAtMs: 1,
      lastObservedAtMs: 1,
    } as never;
    const overlay = overlayEnrichment(providerRecord, attachments, {});
    expect(overlay.enriched).toEqual([]);
  });

  it('ADVERSARIAL: forging BOTH the status AND a single-element candidateTargetSetIds still creates no attachment, because no receipt exists to cite', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    database.seed(`researchEnrichmentObservations/${TENANT_ID}/obs-1/matchingStatus`, 'matched');
    database.seed(`researchEnrichmentObservations/${TENANT_ID}/obs-1/candidateTargetSetIds`, [
      'fabricated-target-set',
    ]);

    const result = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      'a-plausible-receipt-id',
      6000,
    );

    expect(result.outcome).toBe('rejected-no-receipt');
    expect(database.dump().researchEnrichmentAttachments).toBeUndefined();
  });

  it('ADVERSARIAL: a receipt written against stale content cannot authorise an attachment against refreshed content', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await seedGenuineReceipt(database, record, 5000);
    const receipt = (await readResolutionReceipt(asDatabase(database), TENANT_ID, 'obs-1'))!;

    database.seed(
      `researchEnrichmentObservations/${TENANT_ID}/obs-1/sourceContentHash`,
      'd'.repeat(64),
    );
    database.seed(
      `researchEnrichmentObservations/${TENANT_ID}/obs-1/sourceRevisionId`,
      record.sourceRevisionId + 1,
    );

    const result = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      receipt.receiptId,
      6000,
    );

    expect(result.outcome).toBe('rejected-receipt-mismatch');
    expect(database.dump().researchEnrichmentAttachments).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// confirmEnrichmentObservationByAdmin — the second door
// ---------------------------------------------------------------------------

describe('confirmEnrichmentObservationByAdmin', () => {
  it('creates an attachment WITHOUT any receipt when the target set id is a member of the recorded candidate list', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord({ candidateTargetSetIds: [TARGET_SET_ID, 'other-set'] });
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    const result = await confirmEnrichmentObservationByAdmin(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      TARGET_SET_ID,
      'admin-uid-1',
      7000,
    );

    expect(result.outcome).toBe('created');
    const attachments = await listAttachmentsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.attachmentSource).toBe('admin');
    expect(attachments[0]!.confirmedByUid).toBe('admin-uid-1');
    expect(attachments[0]!.confirmedAtMs).toBe(7000);
    expect(attachments[0]!.receiptId).toBeUndefined();
  });

  it('refuses a target set id absent from the recorded candidate list with rejected-candidate', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord({ candidateTargetSetIds: ['other-set'] });
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    const result = await confirmEnrichmentObservationByAdmin(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      TARGET_SET_ID,
      'admin-uid-1',
      7000,
    );

    expect(result.outcome).toBe('rejected-candidate');
    const attachments = await listAttachmentsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    expect(attachments).toEqual([]);
  });

  it('rejects confirmation against an absent observation with rejected-not-attachable', async () => {
    const database = new FakeDatabase();
    const result = await confirmEnrichmentObservationByAdmin(
      asDatabase(database),
      TENANT_ID,
      'nonexistent-obs',
      TARGET_SET_ID,
      'admin-uid-1',
      7000,
    );
    expect(result.outcome).toBe('rejected-not-attachable');
  });
});

// ---------------------------------------------------------------------------
// Review queue + deletion
// ---------------------------------------------------------------------------

describe('listEnrichmentReviewQueue / deleteEnrichmentAttachment', () => {
  it('returns unattached observations in deterministic order and never returns matched-and-attached ones', async () => {
    const database = new FakeDatabase();
    const ambiguous = makeObservationRecord({
      observationId: 'obs-b',
      matchingStatus: 'ambiguous',
    });
    const conflicting = makeObservationRecord({
      observationId: 'obs-a',
      matchingStatus: 'conflicting',
    });
    const attachedRecord = makeObservationRecord({
      observationId: 'obs-z',
      matchingStatus: 'matched',
    });

    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, ambiguous);
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, conflicting);
    await seedGenuineReceipt(database, attachedRecord, 5000);
    const receipt = (await readResolutionReceipt(asDatabase(database), TENANT_ID, 'obs-z'))!;
    await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-z',
      receipt.receiptId,
      6000,
    );

    const queue = await listEnrichmentReviewQueue(asDatabase(database), TENANT_ID);
    expect(queue.map((entry) => entry.observationId)).toEqual(['obs-a', 'obs-b']);
  });

  it('deleting an attachment leaves the observation in place and moves it back into the review queue', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await seedGenuineReceipt(database, record, 5000);
    const receipt = (await readResolutionReceipt(asDatabase(database), TENANT_ID, 'obs-1'))!;
    await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      receipt.receiptId,
      6000,
    );

    const beforeQueue = await listEnrichmentReviewQueue(asDatabase(database), TENANT_ID);
    expect(beforeQueue).toEqual([]);

    await deleteEnrichmentAttachment(asDatabase(database), TENANT_ID, TARGET_SET_ID, 'obs-1');

    const stillPresent = await readEnrichmentObservation(asDatabase(database), TENANT_ID, 'obs-1');
    expect(stillPresent).not.toBeNull();

    const afterQueue = await listEnrichmentReviewQueue(asDatabase(database), TENANT_ID);
    expect(afterQueue.map((entry) => entry.observationId)).toEqual(['obs-1']);
  });
});

// ---------------------------------------------------------------------------
// overlayEnrichment — the anti-masquerade sibling reader
// ---------------------------------------------------------------------------

describe('overlayEnrichment', () => {
  it('returns the provider record by reference with nothing added, alongside a separate enriched sibling', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await seedGenuineReceipt(database, record, 5000);
    const receipt = (await readResolutionReceipt(asDatabase(database), TENANT_ID, 'obs-1'))!;
    await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      receipt.receiptId,
      6000,
    );

    const attachments = await listAttachmentsForSet(asDatabase(database), TENANT_ID, TARGET_SET_ID);
    const providerRecord = {
      providerSetId: TARGET_SET_ID,
      classification: 'complete',
      ruleId: 'R',
      apiIds: { setId: TARGET_SET_ID },
      ingestionRunId: 'run-1',
      fetchedAtMs: 1,
      lastObservedAtMs: 1,
    } as never;

    const overlay = overlayEnrichment(providerRecord, attachments, { 'obs-1': record });

    expect(overlay.provider).toBe(providerRecord);
    expect(overlay.enriched).toHaveLength(1);
    expect(overlay.enriched[0]!.observationId).toBe('obs-1');
    expect(overlay.enriched[0]!.record).toBe(record);
  });
});

// ---------------------------------------------------------------------------
// 30.2 version-wide stale-record sweep — the page-scoped supersede pass can
// never reach outdated records on pages the current expansion no longer
// visits; this sweep removes exactly the bracket-family records whose
// parserVersion differs from the current family constant, and nothing else.
// ---------------------------------------------------------------------------

describe('sweepOutdatedFamilyObservations', () => {
  async function seedRecord(
    database: FakeDatabase,
    overrides: Partial<ResearchEnrichmentObservationRecord>,
  ): Promise<void> {
    await writeEnrichmentObservation(
      asDatabase(database),
      TENANT_ID,
      makeObservationRecord(overrides),
    );
  }

  it('removes ONLY outdated bracket-family records — current-version, vodlist and wikitext-probe records are untouched', async () => {
    const database = new FakeDatabase();
    await seedRecord(database, {
      observationId: 'legacy-old',
      templateFamily: 'legacy',
      parserVersion: 'liquipedia-bracket-legacy@1',
    });
    await seedRecord(database, {
      observationId: 'legacy-current',
      templateFamily: 'legacy',
      parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
    });
    await seedRecord(database, {
      observationId: 'match2-old',
      templateFamily: 'match2',
      parserVersion: 'liquipedia-bracket-match2@1',
    });
    await seedRecord(database, {
      observationId: 'match2-current',
      templateFamily: 'match2',
      parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_MATCH2,
    });
    await seedRecord(database, {
      observationId: 'vodlist-v1',
      templateFamily: 'vodlist',
      contentType: 'vod-reference',
      parserVersion: 'liquipedia-vodlist@1',
    });
    await seedRecord(database, {
      observationId: 'probe-v1',
      templateFamily: 'unknown',
      parserVersion: 'liquipedia-wikitext-probe@1',
      extractionFailed: true,
    });

    const result = await sweepOutdatedFamilyObservations(asDatabase(database), TENANT_ID);

    expect(result.removedObservationIds.sort()).toEqual(['legacy-old', 'match2-old']);
    expect(result.removedAttachmentCount).toBe(0);
    expect(result.removedReceiptCount).toBe(0);
    const survivors = (await listEnrichmentObservations(asDatabase(database), TENANT_ID))
      .map((record) => record.observationId)
      .sort();
    expect(survivors).toEqual(['legacy-current', 'match2-current', 'probe-v1', 'vodlist-v1']);
  });

  it('cascades and COUNTS a stale record still wired into an attachment and a receipt', async () => {
    const database = new FakeDatabase();
    await seedRecord(database, {
      observationId: 'legacy-old-wired',
      templateFamily: 'legacy',
      parserVersion: 'liquipedia-bracket-legacy@1',
    });
    await database
      .ref(`researchEnrichmentReceipts/${TENANT_ID}/legacy-old-wired`)
      .set({ receiptId: 'stale-receipt', observationId: 'legacy-old-wired' });
    await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/${TARGET_SET_ID}/legacy-old-wired`)
      .set({
        observationId: 'legacy-old-wired',
        targetSetId: TARGET_SET_ID,
        attachmentSource: 'resolver',
        attachedAtMs: 1,
        sourceRevisionId: 100,
        sourceContentHash: 'a'.repeat(64),
        parserVersion: 'liquipedia-bracket-legacy@1',
        receiptId: 'stale-receipt',
      });

    const result = await sweepOutdatedFamilyObservations(asDatabase(database), TENANT_ID);

    expect(result.removedObservationIds).toEqual(['legacy-old-wired']);
    expect(result.removedAttachmentCount).toBe(1);
    expect(result.removedReceiptCount).toBe(1);
    const attachment = await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/${TARGET_SET_ID}/legacy-old-wired`)
      .get();
    expect(attachment.exists()).toBe(false);
    const receipt = await database
      .ref(`researchEnrichmentReceipts/${TENANT_ID}/legacy-old-wired`)
      .get();
    expect(receipt.exists()).toBe(false);
  });

  it('is a no-op on an empty tenant', async () => {
    const database = new FakeDatabase();
    const result = await sweepOutdatedFamilyObservations(asDatabase(database), TENANT_ID);
    expect(result.removedObservationIds).toEqual([]);
    expect(result.removedAttachmentCount).toBe(0);
    expect(result.removedReceiptCount).toBe(0);
  });

  // 30.2 schema-blind-hygiene defect: old-generation records are MALFORMED
  // BY DEFINITION once the schema has evolved past them (production: all
  // 616+95 legacy@1 stragglers failed the current schema on the evolved
  // `games[].stocks` shape) — a schema-validating selection saw zero
  // candidates. The sweep must select from the RAW tree.
  it('sweeps a schema-INVALID old-generation record (old-shape stocks) that the schema-validating reader cannot even see', async () => {
    const database = new FakeDatabase();
    // Raw-seeded: fails the CURRENT schema even after the read-side
    // two-seat normalization (a wrong-typed seat, which no normalization
    // may repair) — exactly the class a prior schema generation leaves
    // behind, and one writeEnrichmentObservation could never produce.
    await database.ref(`researchEnrichmentObservations/${TENANT_ID}/old-shape-1`).set({
      observationId: 'old-shape-1',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'OldCup/2020/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/OldCup/2020/Bracket',
      sourceRevisionId: 5,
      sourceContentHash: 'a'.repeat(64),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 100,
      observedAtMs: 100,
      matchingStatus: 'unmatched',
      games: [{ ordinal: 1, stocks: [3, 'not-a-number'] }],
    });

    // Proof of the defect mechanism: the schema-validating reader skips it.
    const schemaVisible = await listEnrichmentObservations(asDatabase(database), TENANT_ID);
    expect(schemaVisible.find((record) => record.observationId === 'old-shape-1')).toBeUndefined();

    const result = await sweepOutdatedFamilyObservations(asDatabase(database), TENANT_ID);
    expect(result.removedObservationIds).toEqual(['old-shape-1']);
    const gone = await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}/old-shape-1`)
      .get();
    expect(gone.exists()).toBe(false);
  });

  it('leaves the SAME malformed shape untouched at the CURRENT family version — version, never validity, is the trigger', async () => {
    const database = new FakeDatabase();
    await database.ref(`researchEnrichmentObservations/${TENANT_ID}/current-but-malformed`).set({
      observationId: 'current-but-malformed',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'OldCup/2020/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/OldCup/2020/Bracket',
      sourceRevisionId: 5,
      sourceContentHash: 'a'.repeat(64),
      parserVersion: LIQUIPEDIA_PARSER_VERSION_BRACKET_LEGACY,
      templateFamily: 'legacy',
      fetchedAtMs: 100,
      observedAtMs: 100,
      matchingStatus: 'unmatched',
      games: [{ ordinal: 1, stocks: [3, 'not-a-number'] }],
    });
    const result = await sweepOutdatedFamilyObservations(asDatabase(database), TENANT_ID);
    expect(result.removedObservationIds).toEqual([]);
    const kept = await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}/current-but-malformed`)
      .get();
    expect(kept.exists()).toBe(true);
  });

  // 30.2 RTDB array-null-strip fix: the write side stores two-seat nullable
  // members in forms that survive an RTDB round trip byte-stably, and the
  // read side rebuilds the canonical tuples — the invariant is
  // parse(write(x)) deep-equals parse(read-back-of-write(x)). FakeDatabase
  // mirrors RTDB's array null-strip, so this round trip is the real shape.
  it('round-trips two-seat nullable members through RTDB-parity storage byte-stably', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord({
      observationId: 'round-trip-1',
      scores: [null, 3],
      games: [
        { ordinal: 1, stocks: [null, 0], rawChars: ['Cloud', null] },
        { ordinal: 2, stocks: [null, null] },
      ],
    });
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    const readBack = await readEnrichmentObservation(
      asDatabase(database),
      TENANT_ID,
      'round-trip-1',
    );
    expect(readBack).not.toBeNull();
    // The canonical parsed shape: null seats explicit, and the all-null
    // member OMITTED (all-unknown is semantically the absent member — the
    // documented normalization contract).
    expect(readBack!.scores).toEqual([null, 3]);
    expect(readBack!.games?.[0]?.stocks).toEqual([null, 0]);
    expect(readBack!.games?.[0]?.rawChars).toEqual(['Cloud', null]);
    expect(readBack!.games?.[1]?.stocks).toBeUndefined();

    // BYTE-STABILITY: the stored bytes contain no raw array nulls (the
    // one-null-seat members are the explicit numeric-keyed object form), so
    // re-writing the read-back record reproduces the identical bytes — the
    // corpus can never degrade again through this writer.
    const storedOnce = JSON.stringify(
      (database.dump().researchEnrichmentObservations as Record<string, unknown>)[TENANT_ID],
    );
    expect(storedOnce).toContain('{"1":3}');
    expect(storedOnce).not.toContain('null');
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, readBack!);
    const storedTwice = JSON.stringify(
      (database.dump().researchEnrichmentObservations as Record<string, unknown>)[TENANT_ID],
    );
    expect(storedTwice).toBe(storedOnce);
  });

  it('a raw child with missing/non-string family or version members matches neither predicate and is left alone', async () => {
    const database = new FakeDatabase();
    await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}/no-version-members`)
      .set({ someUnrelatedShape: true });
    await database.ref(`researchEnrichmentObservations/${TENANT_ID}/numeric-version`).set({
      templateFamily: 'legacy',
      parserVersion: 42,
    });
    const result = await sweepOutdatedFamilyObservations(asDatabase(database), TENANT_ID);
    expect(result.removedObservationIds).toEqual([]);
  });
});

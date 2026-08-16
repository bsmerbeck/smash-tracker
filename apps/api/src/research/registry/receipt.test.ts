import { describe, expect, it } from 'vitest';
import { computeForeignRowDigest } from './foreignDigest.js';
import {
  createRegistryReceipt,
  REGISTRY_RECEIPT_FORMAT_VERSION,
  validateRegistryReceipt,
  type RegistryCountSnapshot,
  type RegistryReceiptBody,
} from './receipt.js';

const UID = 'demo-hbox-uid-000000001';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function snapshot(overrides: Partial<RegistryCountSnapshot> = {}): RegistryCountSnapshot {
  return {
    entryChildren: 4,
    registryOwnedRows: 3,
    foreignRows: 1,
    sourceSets: 10,
    corruptSourceRecords: 0,
    derivedRows: 3,
    creates: 3,
    updates: 0,
    unchanged: 0,
    collisions: 0,
    orphanRemovals: 0,
    ...overrides,
  };
}

function body(overrides: Partial<RegistryReceiptBody> = {}): RegistryReceiptBody {
  const digest = computeForeignRowDigest(UID, { 'manual-1': { setsPlayed: 0 } });
  return {
    formatVersion: REGISTRY_RECEIPT_FORMAT_VERSION,
    command: 'apply',
    workspace: 'hbox',
    label: 'Hungrybox',
    databaseHost: 'smash-tracker-test.firebaseio.com',
    uid: UID,
    manifestContentHash: HASH_A,
    manifestGeneratedAtMs: 1_755_300_000_000,
    reviewedRowSetHash: HASH_B,
    observedRowSetHash: HASH_B,
    startedAtMs: 1_755_300_001_000,
    finishedAtMs: 1_755_300_002_000,
    status: 'ok',
    failedInvariants: [],
    before: snapshot(),
    after: snapshot({ creates: 0, unchanged: 3 }),
    foreignDigestBefore: digest,
    foreignDigestAfter: digest,
    foreignDigestStable: true,
    writes: {
      written: ['histimport:100'],
      removed: [],
      abortedForeign: [],
      writesPerformed: 1,
    },
    ...overrides,
  };
}

describe('createRegistryReceipt / validateRegistryReceipt', () => {
  it('seals a receipt and round-trips it through validation', () => {
    const receipt = createRegistryReceipt(body());
    expect(receipt.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(validateRegistryReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it('records the database identity, destination uid and manifest hash the run was authorized by', () => {
    const receipt = createRegistryReceipt(body());
    expect(receipt).toMatchObject({
      databaseHost: 'smash-tracker-test.firebaseio.com',
      uid: UID,
      manifestContentHash: HASH_A,
    });
  });

  it('rejects a hand-edited receipt', () => {
    const receipt = createRegistryReceipt(body());
    expect(() => validateRegistryReceipt({ ...receipt, status: 'failed' })).toThrow(
      /content hash mismatch/,
    );
  });

  it('rejects unknown keys (strict schema)', () => {
    const receipt = createRegistryReceipt(body());
    expect(() => validateRegistryReceipt({ ...receipt, extra: 1 })).toThrow();
  });

  it('refuses to seal a receipt whose status disagrees with its failed invariants', () => {
    expect(() => createRegistryReceipt(body({ failedInvariants: ['foreign-drift'] }))).toThrow(
      /status and failedInvariants disagree/,
    );
    expect(() => createRegistryReceipt(body({ status: 'failed', failedInvariants: [] }))).toThrow(
      /status and failedInvariants disagree/,
    );
  });

  it('refuses to seal a receipt whose foreignDigestStable claim contradicts the recorded digests', () => {
    expect(() =>
      createRegistryReceipt(
        body({
          foreignDigestAfter: computeForeignRowDigest(UID, {}),
          foreignDigestStable: true,
        }),
      ),
    ).toThrow(/foreignDigestStable does not match/);
  });

  it('accepts a refused receipt: pre-write failure, no write ledger', () => {
    const receipt = createRegistryReceipt(
      body({
        status: 'refused',
        failedInvariants: ['partially-applied: regenerate the manifest'],
        writes: null,
      }),
    );
    expect(receipt.status).toBe('refused');
    expect(receipt.writes).toBeNull();
  });

  it('accepts a dry-run receipt with no authorizing manifest', () => {
    const receipt = createRegistryReceipt(
      body({
        command: 'dry-run',
        manifestContentHash: null,
        manifestGeneratedAtMs: null,
        reviewedRowSetHash: null,
        writes: null,
      }),
    );
    expect(receipt.manifestContentHash).toBeNull();
  });
});

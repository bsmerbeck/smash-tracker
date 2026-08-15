import { describe, expect, it } from 'vitest';
import type { TournamentRegistryRow } from '@smash-tracker/shared';
import type { TournamentRegistryPlan } from '../src/research/registry/reconcile.js';
import {
  buildRegistryAccountManifest,
  buildRegistryComparisonRow,
  computeRegistryRowSetHash,
  createRegistryManifest,
  registryWorkspaceKeys,
  validateRegistryManifest,
  type RegistryManifestBody,
  type RegistryUidMap,
} from './registryManifestArtifact.js';

const NOW_MS = 1_755_300_000_000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const UIDS: RegistryUidMap = {
  hbox: 'demo-hbox-uid-000000001',
  mkleo: 'demo-mkleo-uid-00000001',
  sparg0: 'demo-sparg0-uid-0000001',
  izaw: 'demo-izaw-uid-000000001',
};

function makeRow(
  eventId: string,
  overrides: Partial<TournamentRegistryRow> = {},
): TournamentRegistryRow {
  return {
    entryId: `histimport:${eventId}`,
    origin: 'admin-imported',
    provider: 'startgg',
    startggEventId: eventId,
    eventName: 'Ultimate Singles',
    playedSetCount: 3,
    provenance: { source: 'research-import', importedAtMs: NOW_MS, asOfMs: NOW_MS - 1_000 },
    registryWitness: `research-import:v1:${eventId}`,
    firstSetAt: 1_700_000_000_000,
    lastSetAt: 1_700_000_500_000,
    setsPlayed: 3,
    ...overrides,
  };
}

function makePlan(uid: string, rows: TournamentRegistryRow[]): TournamentRegistryPlan {
  const writes: Record<string, TournamentRegistryRow> = {};
  for (const row of rows) {
    writes[row.entryId] = row;
  }
  return {
    uid,
    writes,
    creates: rows.map((row) => row.entryId).sort(),
    updates: [],
    unchanged: [],
    collisions: [],
    orphanRemovals: [],
    preservedForeignCount: 0,
    corruptSourceRecords: 0,
    sourceSetCount: rows.length * 2,
    skippedNoEventId: 0,
    skippedUnsafeEventId: 0,
    skippedExcludedClassification: 0,
    derivedRows: rows,
  };
}

function makeBody(): RegistryManifestBody {
  return {
    formatVersion: 1,
    generatedAtMs: NOW_MS - 60_000,
    databaseHost: 'smash-tracker-test.firebaseio.com',
    targetUids: UIDS,
    writesPerformed: 0,
    accounts: {
      hbox: buildRegistryAccountManifest('Hungrybox', makePlan(UIDS.hbox, [makeRow('100')])),
      mkleo: buildRegistryAccountManifest('MkLeo', makePlan(UIDS.mkleo, [makeRow('200')])),
      sparg0: buildRegistryAccountManifest('Sparg0', makePlan(UIDS.sparg0, [])),
      izaw: buildRegistryAccountManifest('IzAw', makePlan(UIDS.izaw, [makeRow('300')])),
    },
  };
}

describe('computeRegistryRowSetHash', () => {
  it('is order-independent over rows and ignores provenance.importedAtMs', () => {
    const a = makeRow('100');
    const b = makeRow('200');
    const reStamped: TournamentRegistryRow = {
      ...a,
      provenance: { ...a.provenance, importedAtMs: NOW_MS + 999_999 },
    };
    expect(computeRegistryRowSetHash('uid-1', [a, b])).toBe(
      computeRegistryRowSetHash('uid-1', [b, reStamped]),
    );
  });

  it('changes when any content member changes, and binds the uid', () => {
    const base = computeRegistryRowSetHash('uid-1', [makeRow('100')]);
    expect(computeRegistryRowSetHash('uid-1', [makeRow('100', { placement: 1 })])).not.toBe(base);
    expect(computeRegistryRowSetHash('uid-2', [makeRow('100')])).not.toBe(base);
  });

  it('does NOT ignore provenance.asOfMs (freshness is content)', () => {
    const base = computeRegistryRowSetHash('uid-1', [makeRow('100')]);
    const fresher = makeRow('100');
    fresher.provenance = { ...fresher.provenance, asOfMs: NOW_MS };
    expect(computeRegistryRowSetHash('uid-1', [fresher])).not.toBe(base);
  });
});

describe('buildRegistryAccountManifest', () => {
  it('distills a plan into counts, buckets, rows, and a matching row-set hash', () => {
    const rows = [makeRow('100'), makeRow('200')];
    const account = buildRegistryAccountManifest('Hungrybox', makePlan(UIDS.hbox, rows));
    expect(account).toMatchObject({
      label: 'Hungrybox',
      uid: UIDS.hbox,
      derivedRowCount: 2,
      creates: ['histimport:100', 'histimport:200'],
      updates: [],
      collisions: [],
      orphanRemovals: [],
    });
    expect(account.rowSetHash).toBe(computeRegistryRowSetHash(UIDS.hbox, rows));
  });
});

describe('createRegistryManifest / validateRegistryManifest', () => {
  it('round-trips a freshly created manifest', () => {
    const manifest = createRegistryManifest(makeBody());
    expect(validateRegistryManifest(manifest, UIDS, NOW_MS, MAX_AGE_MS)).toEqual(manifest);
  });

  it('rejects a tampered content hash', () => {
    const manifest = createRegistryManifest(makeBody());
    const tampered = { ...manifest, generatedAtMs: manifest.generatedAtMs + 1 };
    expect(() => validateRegistryManifest(tampered, UIDS, NOW_MS, MAX_AGE_MS)).toThrow(
      /content hash mismatch/,
    );
  });

  it('rejects a tampered account row set (row-set hash mismatch)', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `contentHash` is intentionally discarded
    const { contentHash: _contentHash, ...body } = createRegistryManifest(makeBody());
    const hbox = body.accounts.hbox;
    const tamperedBody: RegistryManifestBody = {
      ...body,
      accounts: {
        ...body.accounts,
        hbox: { ...hbox, rows: [makeRow('100', { placement: 1 })] },
      },
    };
    // Re-seal the outer hash so ONLY the inner row-set hash can catch it.
    const resealed = createRegistryManifest(tamperedBody);
    expect(() => validateRegistryManifest(resealed, UIDS, NOW_MS, MAX_AGE_MS)).toThrow(
      /row-set hash mismatch for hbox/,
    );
  });

  it('rejects unknown/extra keys at the top level (strict schema)', () => {
    const manifest = createRegistryManifest(makeBody());
    expect(() =>
      validateRegistryManifest({ ...manifest, extra: true }, UIDS, NOW_MS, MAX_AGE_MS),
    ).toThrow();
  });

  it('rejects a manifest whose target uids do not match the supplied flags', () => {
    const manifest = createRegistryManifest(makeBody());
    const otherUids: RegistryUidMap = { ...UIDS, hbox: 'different-uid-000000001' };
    expect(() => validateRegistryManifest(manifest, otherUids, NOW_MS, MAX_AGE_MS)).toThrow(
      /target UIDs do not match/,
    );
  });

  it('rejects duplicate destination uids', () => {
    const dupUids: RegistryUidMap = { ...UIDS, mkleo: UIDS.hbox };
    const body = makeBody();
    const manifest = createRegistryManifest({
      ...body,
      targetUids: dupUids,
      accounts: {
        ...body.accounts,
        mkleo: buildRegistryAccountManifest('MkLeo', makePlan(UIDS.hbox, [makeRow('200')])),
      },
    });
    expect(() => validateRegistryManifest(manifest, dupUids, NOW_MS, MAX_AGE_MS)).toThrow(
      /must be unique/,
    );
  });

  it('rejects a stale manifest and a future-dated manifest', () => {
    const manifest = createRegistryManifest(makeBody());
    expect(() =>
      validateRegistryManifest(manifest, UIDS, manifest.generatedAtMs + MAX_AGE_MS + 1, MAX_AGE_MS),
    ).toThrow(/stale or dated in the future/);
    expect(() =>
      validateRegistryManifest(manifest, UIDS, manifest.generatedAtMs - 1, MAX_AGE_MS),
    ).toThrow(/stale or dated in the future/);
  });

  it('rejects an account whose uid disagrees with the target map', () => {
    const body = makeBody();
    const manifest = createRegistryManifest({
      ...body,
      accounts: {
        ...body.accounts,
        izaw: buildRegistryAccountManifest('IzAw', makePlan(UIDS.hbox, [makeRow('300')])),
      },
    });
    expect(() => validateRegistryManifest(manifest, UIDS, NOW_MS, MAX_AGE_MS)).toThrow(
      /account UID mismatch for izaw/,
    );
  });

  it('rejects an action-bucket partition that does not cover the row set', () => {
    const body = makeBody();
    const hbox = body.accounts.hbox;
    const manifest = createRegistryManifest({
      ...body,
      accounts: {
        ...body.accounts,
        hbox: { ...hbox, creates: [] },
      },
    });
    expect(() => validateRegistryManifest(manifest, UIDS, NOW_MS, MAX_AGE_MS)).toThrow(
      /action-bucket partition mismatch for hbox/,
    );
  });

  it('rejects a writesPerformed other than the literal 0', () => {
    const manifest = createRegistryManifest(makeBody());
    expect(() =>
      validateRegistryManifest({ ...manifest, writesPerformed: 1 }, UIDS, NOW_MS, MAX_AGE_MS),
    ).toThrow();
  });
});

describe('buildRegistryComparisonRow', () => {
  it('reports exactMatch only when the row set matches and nothing is pending', () => {
    const rows = [makeRow('100')];
    const reviewed = buildRegistryAccountManifest('Hungrybox', makePlan(UIDS.hbox, rows));

    // Post-apply state: same rows, all unchanged, nothing pending.
    const settled: TournamentRegistryPlan = {
      ...makePlan(UIDS.hbox, rows),
      writes: {},
      creates: [],
      unchanged: rows.map((row) => row.entryId),
    };
    expect(buildRegistryComparisonRow('hbox', reviewed, settled)).toMatchObject({
      workspace: 'hbox',
      rowSetMatches: true,
      pendingCreates: 0,
      exactMatch: true,
    });

    // Drifted content: derivation no longer hashes to the reviewed set.
    const drifted: TournamentRegistryPlan = {
      ...settled,
      derivedRows: [makeRow('100', { placement: 1 })],
    };
    expect(buildRegistryComparisonRow('hbox', reviewed, drifted)).toMatchObject({
      rowSetMatches: false,
      exactMatch: false,
    });

    // Pending work: content matches but the destination still needs writes.
    const pending: TournamentRegistryPlan = {
      ...makePlan(UIDS.hbox, rows),
    };
    expect(buildRegistryComparisonRow('hbox', reviewed, pending)).toMatchObject({
      rowSetMatches: true,
      pendingCreates: 1,
      exactMatch: false,
    });
  });
});

describe('registryWorkspaceKeys', () => {
  it('names exactly the four demo workspaces', () => {
    expect(registryWorkspaceKeys).toEqual(['hbox', 'mkleo', 'sparg0', 'izaw']);
  });
});

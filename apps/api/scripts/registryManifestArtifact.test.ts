import { describe, expect, it } from 'vitest';
import type { TournamentRegistryRow } from '@smash-tracker/shared';
import { computeForeignRowDigest } from '../src/research/registry/foreignDigest.js';
import type { TournamentRegistryPlan } from '../src/research/registry/reconcile.js';
import {
  assessRegistryPreWriteGate,
  buildRegistryAccountManifest,
  buildRegistryComparisonRow,
  canonicalScope,
  classifyRegistryDrift,
  computeRegistryRowSetHash,
  createRegistryManifest,
  describeSourceCensusDelta,
  manifestScopedAccounts,
  parseSealedRegistryManifest,
  REGISTRY_FROZEN_SOURCE_SET_COUNTS,
  REGISTRY_MANIFEST_FORMAT_VERSION,
  registryWorkspaceKeys,
  sourceCensusOf,
  validateRegistryManifest,
  type RegistryManifestBody,
  type RegistryReviewedException,
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

const MANUAL_ENTRY = {
  eventName: 'Locals #42',
  firstSetAt: 1_700_000_000_000,
  lastSetAt: 1_700_000_000_000,
  setsPlayed: 0,
  source: 'manual',
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

function makePlan(
  uid: string,
  rows: TournamentRegistryRow[],
  foreign: Record<string, unknown> = {},
): TournamentRegistryPlan {
  const writes: Record<string, TournamentRegistryRow> = {};
  for (const row of rows) {
    writes[row.entryId] = row;
  }
  const foreignDigest = computeForeignRowDigest(uid, foreign);
  return {
    uid,
    writes,
    creates: rows.map((row) => row.entryId).sort(),
    updates: [],
    unchanged: [],
    collisions: [],
    orphanRemovals: [],
    preservedForeignCount: foreignDigest.count,
    foreignDigest,
    entryChildCount: foreignDigest.count,
    ownedRowCount: 0,
    corruptSourceRecords: 0,
    sourceSetCount: rows.length * 2,
    skippedNoEventId: 0,
    skippedUnsafeEventId: 0,
    skippedExcludedClassification: 0,
    derivedRows: rows,
  };
}

/**
 * A reviewed exception that exactly covers `makePlan`'s synthetic census.
 * The fixtures derive one or two rows, so their `sourceSetCount` is nowhere
 * near the owner-frozen production figure — which is precisely the condition
 * the pre-write gate refuses, and precisely what a reviewed exception exists
 * to authorize.
 */
function exceptionFor(
  overrides: Partial<RegistryReviewedException> = {},
): RegistryReviewedException {
  return {
    reason: 'synthetic fixture census, reviewed for the unit suite',
    reviewedAtMs: NOW_MS - 120_000,
    acceptedSourceSetCount: null,
    acceptedCorruptSourceRecords: 0,
    acceptedCollisions: [],
    ...overrides,
  };
}

function makeBody(): RegistryManifestBody {
  return {
    formatVersion: REGISTRY_MANIFEST_FORMAT_VERSION,
    generatedAtMs: NOW_MS - 60_000,
    databaseHost: 'smash-tracker-test.firebaseio.com',
    targetUids: UIDS,
    scope: [...registryWorkspaceKeys],
    writesPerformed: 0,
    accounts: {
      hbox: buildRegistryAccountManifest('Hungrybox', makePlan(UIDS.hbox, [makeRow('100')])),
      mkleo: buildRegistryAccountManifest('MkLeo', makePlan(UIDS.mkleo, [makeRow('200')])),
      sparg0: buildRegistryAccountManifest('Sparg0', makePlan(UIDS.sparg0, [])),
      izaw: buildRegistryAccountManifest('IzAw', makePlan(UIDS.izaw, [makeRow('300')])),
    },
  };
}

/** A single-account (`--account hbox`) manifest — the first-class per-account posture. */
function makeScopedBody(): RegistryManifestBody {
  return {
    formatVersion: REGISTRY_MANIFEST_FORMAT_VERSION,
    generatedAtMs: NOW_MS - 60_000,
    databaseHost: 'smash-tracker-test.firebaseio.com',
    targetUids: UIDS,
    scope: ['hbox'],
    writesPerformed: 0,
    accounts: {
      hbox: buildRegistryAccountManifest('Hungrybox', makePlan(UIDS.hbox, [makeRow('100')])),
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

  it('carries the plan foreign-row digest and its keys into the reviewable artifact', () => {
    const account = buildRegistryAccountManifest(
      'Hungrybox',
      makePlan(UIDS.hbox, [makeRow('100')], { 'manual-1': MANUAL_ENTRY }),
    );
    expect(account.preservedForeignCount).toBe(1);
    expect(account.preservedForeignKeys).toEqual(['manual-1']);
    expect(account.foreignDigest).toBe(
      computeForeignRowDigest(UIDS.hbox, { 'manual-1': MANUAL_ENTRY }).digest,
    );
  });
});

describe('createRegistryManifest / validateRegistryManifest', () => {
  it('round-trips a freshly created all-accounts manifest', () => {
    const manifest = createRegistryManifest(makeBody());
    expect(validateRegistryManifest(manifest, UIDS, NOW_MS, MAX_AGE_MS)).toEqual(manifest);
  });

  it('round-trips a single-account manifest and exposes just that account', () => {
    const manifest = createRegistryManifest(makeScopedBody());
    const validated = validateRegistryManifest(manifest, UIDS, NOW_MS, MAX_AGE_MS);
    expect(validated.scope).toEqual(['hbox']);
    expect(manifestScopedAccounts(validated).map((entry) => entry.workspace)).toEqual(['hbox']);
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
    const hbox = body.accounts.hbox!;
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
    const hbox = body.accounts.hbox!;
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

  it('rejects a scope that names an account the manifest does not carry', () => {
    const body = makeScopedBody();
    const manifest = createRegistryManifest({ ...body, scope: ['hbox', 'mkleo'] });
    expect(() => validateRegistryManifest(manifest, UIDS, NOW_MS, MAX_AGE_MS)).toThrow(
      /scope \[hbox,mkleo\] does not match its account set \[hbox\]/,
    );
  });

  it('rejects an account the scope does not name (a plan the owner never reviewed under this scope)', () => {
    const body = makeBody();
    const manifest = createRegistryManifest({ ...body, scope: ['hbox'] });
    expect(() => validateRegistryManifest(manifest, UIDS, NOW_MS, MAX_AGE_MS)).toThrow(
      /does not match its account set/,
    );
  });

  it('rejects a duplicated scope entry', () => {
    const body = makeScopedBody();
    const manifest = createRegistryManifest({ ...body, scope: ['hbox', 'hbox'] });
    expect(() => validateRegistryManifest(manifest, UIDS, NOW_MS, MAX_AGE_MS)).toThrow(
      /duplicate workspaces/,
    );
  });

  it('rejects a preserved-foreign key list that disagrees with its count', () => {
    const body = makeScopedBody();
    const hbox = body.accounts.hbox!;
    const manifest = createRegistryManifest({
      ...body,
      accounts: { hbox: { ...hbox, preservedForeignCount: 2 } },
    });
    expect(() => validateRegistryManifest(manifest, UIDS, NOW_MS, MAX_AGE_MS)).toThrow(
      /preserved-foreign count mismatch for hbox/,
    );
  });

  it('binds the scope into the content hash', () => {
    const full = createRegistryManifest(makeBody());
    const scoped = createRegistryManifest(makeScopedBody());
    expect(scoped.contentHash).not.toBe(full.contentHash);
  });
});

describe('canonicalScope', () => {
  it('orders and deduplicates against the canonical workspace order', () => {
    expect(canonicalScope(['izaw', 'hbox', 'izaw'])).toEqual(['hbox', 'izaw']);
  });
});

describe('classifyRegistryDrift', () => {
  const rows = [makeRow('100'), makeRow('200')];
  const reviewed = buildRegistryAccountManifest('Hungrybox', makePlan(UIDS.hbox, rows));

  function freshFrom(plan: TournamentRegistryPlan) {
    return buildRegistryAccountManifest('Hungrybox', plan);
  }

  it('passes an untouched destination', () => {
    const verdict = classifyRegistryDrift('hbox', reviewed, freshFrom(makePlan(UIDS.hbox, rows)));
    expect(verdict).toMatchObject({ kind: 'none', safeToApply: true });
  });

  it('refuses a PARTIALLY APPLIED manifest and directs the operator to regenerate', () => {
    // The interrupted-apply signature: identical derived content, but rows
    // the manifest planned to create are now already stored (unchanged).
    const resumed: TournamentRegistryPlan = {
      ...makePlan(UIDS.hbox, rows),
      writes: { [rows[1]!.entryId]: rows[1]! },
      creates: ['histimport:200'],
      unchanged: ['histimport:100'],
    };
    const verdict = classifyRegistryDrift('hbox', reviewed, freshFrom(resumed));
    expect(verdict.kind).toBe('partially-applied');
    expect(verdict.safeToApply).toBe(false);
    expect(verdict.alreadyApplied).toEqual(['histimport:100']);
    expect(verdict.message).toMatch(/PARTIALLY APPLIED/);
    expect(verdict.message).toMatch(/Do NOT re-run this manifest/);
    expect(verdict.message).toMatch(/regenerate a fresh/);
  });

  it('refuses source drift when the derived row set itself changed', () => {
    const drifted = makePlan(UIDS.hbox, [makeRow('100'), makeRow('200', { placement: 1 })]);
    const verdict = classifyRegistryDrift('hbox', reviewed, freshFrom(drifted));
    expect(verdict.kind).toBe('source-drift');
    expect(verdict.message).toMatch(/researchSource records changed/);
  });

  it('refuses foreign drift ahead of everything else, naming the changed keys', () => {
    const withForeign = buildRegistryAccountManifest(
      'Hungrybox',
      makePlan(UIDS.hbox, rows, { 'manual-1': MANUAL_ENTRY }),
    );
    const verdict = classifyRegistryDrift('hbox', reviewed, withForeign);
    expect(verdict.kind).toBe('foreign-drift');
    expect(verdict.message).toMatch(/NON-registry rows changed/);
    expect(verdict.message).toMatch(/manual-1/);
  });

  it('reports destination drift when buckets changed without any row being already applied', () => {
    // A pure create -> update reclassification: no census member moves, no
    // planned row is already stored, so neither `census-drift` nor
    // `partially-applied` applies and the residual bucket change is the
    // finding.
    const reclassified: TournamentRegistryPlan = {
      ...makePlan(UIDS.hbox, rows),
      creates: [],
      updates: ['histimport:100', 'histimport:200'],
    };
    const verdict = classifyRegistryDrift('hbox', reviewed, freshFrom(reclassified));
    expect(verdict.kind).toBe('destination-drift');
    expect(verdict.alreadyApplied).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Hard gate #4, B8 — the census freeze. The hole these close: every one of
  // these perturbations leaves `rowSetHash` IDENTICAL, and every one of them
  // used to classify as `none` and apply.
  // -------------------------------------------------------------------------

  it.each([
    ['corruptSourceRecords', { corruptSourceRecords: 7 }, /corruptSourceRecords 0 -> 7/],
    ['sourceSetCount', { sourceSetCount: 99 }, /sourceSetCount 4 -> 99/],
    ['skippedNoEventId', { skippedNoEventId: 3 }, /skippedNoEventId 0 -> 3/],
    ['skippedUnsafeEventId', { skippedUnsafeEventId: 2 }, /skippedUnsafeEventId 0 -> 2/],
    [
      'skippedExcludedClassification',
      { skippedExcludedClassification: 41 },
      /skippedExcludedClassification 0 -> 41/,
    ],
    ['collisions', { collisions: ['histimport:999'] }, /collisions \[\] -> \[histimport:999\]/],
    [
      'orphanRemovals',
      { orphanRemovals: ['histimport:orphan'] },
      /orphanRemovals \[\] -> \[histimport:orphan\]/,
    ],
  ])(
    'refuses CENSUS drift in %s even though the derived-row hash is unchanged',
    (_member, patch, expected) => {
      const drifted: TournamentRegistryPlan = { ...makePlan(UIDS.hbox, rows), ...patch };
      const fresh = freshFrom(drifted);
      // The precondition that makes this a real hole and not a tautology.
      expect(fresh.rowSetHash).toBe(reviewed.rowSetHash);
      expect(fresh.foreignDigest).toBe(reviewed.foreignDigest);

      const verdict = classifyRegistryDrift('hbox', reviewed, fresh);
      expect(verdict.kind).toBe('census-drift');
      expect(verdict.safeToApply).toBe(false);
      expect(verdict.message).toMatch(expected);
    },
  );

  it('ranks census drift below foreign and source drift, and above a partial apply', () => {
    const both: TournamentRegistryPlan = {
      ...makePlan(UIDS.hbox, rows),
      corruptSourceRecords: 5,
      creates: ['histimport:200'],
      unchanged: ['histimport:100'],
    };
    // A partially-applied signature AND a census move: the census is reported.
    expect(classifyRegistryDrift('hbox', reviewed, freshFrom(both)).kind).toBe('census-drift');

    const withForeign = buildRegistryAccountManifest(
      'Hungrybox',
      makePlan(UIDS.hbox, rows, { 'manual-1': MANUAL_ENTRY }),
    );
    expect(
      classifyRegistryDrift('hbox', reviewed, {
        ...withForeign,
        corruptSourceRecords: 5,
      }).kind,
    ).toBe('foreign-drift');
  });
});

describe('the source census (hard gate #4, B8)', () => {
  it('pins the owner-frozen sourceSetCount figures in committed source', () => {
    expect(REGISTRY_FROZEN_SOURCE_SET_COUNTS).toEqual({
      hbox: 8413,
      mkleo: 5314,
      sparg0: 6187,
      izaw: 640,
    });
  });

  it('normalizes array members so key ORDER is never mistaken for a census change', () => {
    const left = sourceCensusOf({
      ...makePlan(UIDS.hbox, []),
      collisions: ['b', 'a'],
      orphanRemovals: ['d', 'c'],
    });
    const right = sourceCensusOf({
      ...makePlan(UIDS.hbox, []),
      collisions: ['a', 'b'],
      orphanRemovals: ['c', 'd'],
    });
    expect(describeSourceCensusDelta(left, right)).toEqual([]);
  });
});

describe('assessRegistryPreWriteGate (hard gate #4, B8)', () => {
  const rows = [makeRow('100')];
  const clean = makePlan(UIDS.hbox, rows);
  /** The one census that satisfies the frozen contract without any exception. */
  const frozenCensus = { ...clean, sourceSetCount: REGISTRY_FROZEN_SOURCE_SET_COUNTS.hbox };

  it('passes a plan that matches the frozen census with no corruption and no collisions', () => {
    const reviewed = buildRegistryAccountManifest('Hungrybox', frozenCensus);
    expect(
      assessRegistryPreWriteGate('hbox', reviewed, sourceCensusOf(frozenCensus)),
    ).toMatchObject({ ok: true, kind: 'none' });
  });

  it('REFUSES a sourceSetCount that is not the owner-frozen figure', () => {
    const reviewed = buildRegistryAccountManifest('Hungrybox', clean);
    const verdict = assessRegistryPreWriteGate('hbox', reviewed, sourceCensusOf(clean));
    expect(verdict).toMatchObject({ ok: false, kind: 'frozen-source-set-drift' });
    expect(verdict.message).toMatch(/owner-frozen census for this account is 8413/);
    expect(verdict.message).toMatch(/--exceptions-in/);
  });

  it('REFUSES corrupt source records, and accepts them only under an EXACT reviewed exception', () => {
    const corrupt = { ...frozenCensus, corruptSourceRecords: 4 };
    const bare = buildRegistryAccountManifest('Hungrybox', corrupt);
    expect(assessRegistryPreWriteGate('hbox', bare, sourceCensusOf(corrupt))).toMatchObject({
      ok: false,
      kind: 'corrupt-source-records',
    });

    const excepted = buildRegistryAccountManifest(
      'Hungrybox',
      corrupt,
      exceptionFor({ acceptedCorruptSourceRecords: 4 }),
    );
    expect(assessRegistryPreWriteGate('hbox', excepted, sourceCensusOf(corrupt))).toMatchObject({
      ok: true,
      kind: 'none',
    });

    // One MORE corrupt record than the owner reviewed: the exception no
    // longer describes the condition, so the refusal stands.
    expect(
      assessRegistryPreWriteGate('hbox', excepted, {
        ...sourceCensusOf(corrupt),
        corruptSourceRecords: 5,
      }),
    ).toMatchObject({ ok: false, kind: 'corrupt-source-records' });
  });

  it('REFUSES collisions, and accepts only the EXACT reviewed collision set', () => {
    const collided = { ...frozenCensus, collisions: ['histimport:100'] };
    const bare = buildRegistryAccountManifest('Hungrybox', collided);
    expect(assessRegistryPreWriteGate('hbox', bare, sourceCensusOf(collided))).toMatchObject({
      ok: false,
      kind: 'collisions',
    });

    const excepted = buildRegistryAccountManifest(
      'Hungrybox',
      collided,
      exceptionFor({ acceptedCollisions: ['histimport:100'] }),
    );
    expect(assessRegistryPreWriteGate('hbox', excepted, sourceCensusOf(collided))).toMatchObject({
      ok: true,
      kind: 'none',
    });
    expect(
      assessRegistryPreWriteGate('hbox', excepted, {
        ...sourceCensusOf(collided),
        collisions: ['histimport:100', 'histimport:200'],
      }),
    ).toMatchObject({ ok: false, kind: 'collisions' });
  });

  it('refuses to BUILD a manifest whose reviewed exception does not describe its own plan', () => {
    expect(() =>
      buildRegistryAccountManifest(
        'Hungrybox',
        { ...frozenCensus, corruptSourceRecords: 4 },
        exceptionFor({ acceptedCorruptSourceRecords: 9 }),
      ),
    ).toThrow(/accepts 9 corrupt source record\(s\) but the plan has 4/);
    expect(() =>
      buildRegistryAccountManifest(
        'Hungrybox',
        frozenCensus,
        exceptionFor({ acceptedSourceSetCount: 77 }),
      ),
    ).toThrow(/accepts sourceSetCount 77 but the plan has 8413/);
  });

  it('refuses to VALIDATE a manifest whose reviewed exception was hand-edited after sealing', () => {
    const account = buildRegistryAccountManifest(
      'Hungrybox',
      { ...frozenCensus, corruptSourceRecords: 4 },
      exceptionFor({ acceptedCorruptSourceRecords: 4 }),
    );
    const tampered = createRegistryManifest({
      formatVersion: REGISTRY_MANIFEST_FORMAT_VERSION,
      generatedAtMs: NOW_MS - 60_000,
      databaseHost: 'smash-tracker-test.firebaseio.com',
      targetUids: UIDS,
      scope: ['hbox'],
      writesPerformed: 0,
      accounts: {
        hbox: {
          ...account,
          reviewedExceptions: { ...account.reviewedExceptions!, acceptedCorruptSourceRecords: 40 },
        },
      },
    });
    // Re-sealed, so the content hash is honest — but the exception no longer
    // covers the figures in its own manifest.
    expect(() => validateRegistryManifest(tampered, UIDS, NOW_MS, MAX_AGE_MS)).toThrow(
      /accepts 40 corrupt source record\(s\) but the plan has 4/,
    );
  });
});

describe('parseSealedRegistryManifest', () => {
  it('accepts a sealed manifest of ANY age — the audit needs identity, not freshness', () => {
    const manifest = createRegistryManifest(makeScopedBody());
    expect(parseSealedRegistryManifest(manifest).contentHash).toBe(manifest.contentHash);
    // validateRegistryManifest would refuse this same artifact for staleness.
    expect(() =>
      validateRegistryManifest(manifest, UIDS, NOW_MS + MAX_AGE_MS * 10, MAX_AGE_MS),
    ).toThrow(/stale/);
  });

  it('still refuses a broken seal', () => {
    const manifest = createRegistryManifest(makeScopedBody());
    expect(() =>
      parseSealedRegistryManifest({ ...manifest, generatedAtMs: manifest.generatedAtMs + 1 }),
    ).toThrow(/content hash mismatch/);
  });
});

describe('buildRegistryComparisonRow', () => {
  it('reports exactMatch only when the row set matches and nothing is pending', () => {
    const rows = [makeRow('100')];
    const reviewed = buildRegistryAccountManifest(
      'Hungrybox',
      makePlan(UIDS.hbox, rows),
      // The fixture census is synthetic, so the frozen-contract clause of
      // `exactMatch` needs the same reviewed exception a real deviation would.
      exceptionFor({ acceptedSourceSetCount: 2 }),
    );

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
      foreignDigestMatches: true,
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

  it('fails exactMatch when a foreign row changed even though the registry is settled', () => {
    const rows = [makeRow('100')];
    const reviewed = buildRegistryAccountManifest('Hungrybox', makePlan(UIDS.hbox, rows));
    const settledWithNewForeign: TournamentRegistryPlan = {
      ...makePlan(UIDS.hbox, rows, { 'manual-1': MANUAL_ENTRY }),
      writes: {},
      creates: [],
      unchanged: rows.map((row) => row.entryId),
    };
    expect(buildRegistryComparisonRow('hbox', reviewed, settledWithNewForeign)).toMatchObject({
      rowSetMatches: true,
      pendingCreates: 0,
      foreignDigestMatches: false,
      exactMatch: false,
    });
  });

  it('fails exactMatch on CENSUS drift alone — a settled registry is not a settled account (B8)', () => {
    const rows = [makeRow('100')];
    const reviewed = buildRegistryAccountManifest(
      'Hungrybox',
      makePlan(UIDS.hbox, rows),
      exceptionFor({ acceptedSourceSetCount: 2 }),
    );
    const settledButCorrupted: TournamentRegistryPlan = {
      ...makePlan(UIDS.hbox, rows),
      writes: {},
      creates: [],
      unchanged: rows.map((row) => row.entryId),
      corruptSourceRecords: 12,
    };
    const row = buildRegistryComparisonRow('hbox', reviewed, settledButCorrupted);
    expect(row).toMatchObject({
      rowSetMatches: true,
      foreignDigestMatches: true,
      pendingCreates: 0,
      pendingUpdates: 0,
      pendingRemovals: 0,
      collisions: 0,
      censusMatches: false,
      exactMatch: false,
    });
    expect(row.censusDelta).toEqual(['corruptSourceRecords 0 -> 12']);
  });

  it('fails exactMatch when the live census no longer satisfies the frozen contract', () => {
    const rows = [makeRow('100')];
    // No reviewed exception at all: the fixture census cannot satisfy the
    // frozen figure, so even a perfectly settled registry is not an exact
    // match.
    const reviewed = buildRegistryAccountManifest('Hungrybox', makePlan(UIDS.hbox, rows));
    const settled: TournamentRegistryPlan = {
      ...makePlan(UIDS.hbox, rows),
      writes: {},
      creates: [],
      unchanged: rows.map((row) => row.entryId),
    };
    expect(buildRegistryComparisonRow('hbox', reviewed, settled)).toMatchObject({
      censusMatches: true,
      frozenCensusOk: false,
      exactMatch: false,
    });
  });
});

describe('registryWorkspaceKeys', () => {
  it('names exactly the four demo workspaces', () => {
    expect(registryWorkspaceKeys).toEqual(['hbox', 'mkleo', 'sparg0', 'izaw']);
  });
});

import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import type { ResearchSourceSetRecord } from '@smash-tracker/shared';
import { FakeDatabase } from '../src/test-support/fakeDatabase.js';
import { computeForeignRowDigest } from '../src/research/registry/foreignDigest.js';
import { validateRegistryReceipt, type RegistryReceipt } from '../src/research/registry/receipt.js';
import { runRegistryOperator, type RegistryOperatorDeps } from './deriveTournamentRegistryCore.js';
import { validateRegistryManifest, type RegistryManifest } from './registryManifestArtifact.js';

/**
 * 30.3 operator hardening: the whole operator, exercised against
 * `FakeDatabase` with injected clock/log/filesystem — zero Firebase, zero
 * network. Everything the owner directive asks for that is NOT about process
 * termination is proven here; the termination matrix lives in
 * `deriveTournamentRegistryLifecycle.test.ts`.
 */

const UIDS = {
  hbox: 'demo-hbox-uid-000000001',
  mkleo: 'demo-mkleo-uid-00000001',
  sparg0: 'demo-sparg0-uid-0000001',
  izaw: 'demo-izaw-uid-000000001',
};
const HOST = 'smash-tracker-test.firebaseio.com';
const MANIFEST_PATH = '/work/registry-manifest.json';
const RECEIPT_DIR = '/work/receipts';
const EXCEPTIONS_PATH = '/work/reviewed-exceptions.json';

/**
 * Hard gate #4, B8: the fixtures seed two source records, so every plan here
 * deviates from the owner-frozen `sourceSetCount` (8413 for hbox) and is
 * refused PRE-WRITE unless the reviewed manifest authorizes that exact count.
 * The apply/compare fixtures therefore generate their manifest with a reviewed
 * exception — which also means the exception path is exercised by every apply
 * test rather than by one bespoke case.
 */
function exceptionsFile(
  overrides: {
    acceptedSourceSetCount?: number | null;
    acceptedCorruptSourceRecords?: number;
    acceptedCollisions?: string[];
  } = {},
): string {
  return JSON.stringify({
    hbox: {
      reason: 'synthetic two-record fixture census, reviewed for the operator unit suite',
      reviewedAtMs: 1_755_000_000_000,
      acceptedSourceSetCount: overrides.acceptedSourceSetCount ?? 2,
      acceptedCorruptSourceRecords: overrides.acceptedCorruptSourceRecords ?? 0,
      acceptedCollisions: overrides.acceptedCollisions ?? [],
    },
  });
}

const MANUAL_ENTRY = {
  eventName: 'Locals #42',
  firstSetAt: 1_700_000_000_000,
  lastSetAt: 1_700_000_000_000,
  setsPlayed: 0,
  source: 'manual',
};
const LEGACY_STARTGG_ENTRY = {
  eventId: 987,
  eventName: 'Ultimate Singles',
  tournamentName: 'Synced Weekly',
  firstSetAt: 1_690_000_000_000,
  lastSetAt: 1_690_000_500_000,
  setsPlayed: 5,
};

function makeRecord(providerSetId: string, eventId: string): ResearchSourceSetRecord {
  return {
    providerSetId,
    classification: 'complete',
    ruleId: 'R-COMPLETE',
    apiIds: { setId: providerSetId, eventId },
    ingestionRunId: 'run-1',
    fetchedAtMs: 1_754_000_000_000,
    lastObservedAtMs: 1_754_000_000_000,
    completedAt: 1_700_000_000,
    event: {
      eventId,
      name: 'Ultimate Singles',
      slug: `tournament/major-${eventId}/event/ultimate-singles`,
      tournamentName: `Major ${eventId}`,
      tournamentSlug: `tournament/major-${eventId}`,
      numEntrants: 128,
    },
    subjectEntrantId: 'e-subject',
    entrants: [{ entrantId: 'e-subject', name: 'Subject', seedNum: 5, placement: 3 }],
  };
}

interface Harness {
  fake: FakeDatabase;
  files: Map<string, string>;
  logs: string[];
  tables: object[][];
  deps: RegistryOperatorDeps;
}

function makeHarness(overrides: Partial<RegistryOperatorDeps> = {}): Harness {
  const fake = new FakeDatabase();
  const files = new Map<string, string>();
  const logs: string[] = [];
  const tables: object[][] = [];
  const deps: RegistryOperatorDeps = {
    database: fake as unknown as Database,
    databaseHost: HOST,
    now: () => Date.now(),
    log: (line) => logs.push(line),
    table: (rows) => tables.push(rows),
    readFileText: async (path) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: no such file '${path}'`);
      }
      return content;
    },
    writeFileText: async (path, content) => {
      files.set(path, content);
    },
    ...overrides,
  };
  return { fake, files, logs, tables, deps };
}

function seedHbox(fake: FakeDatabase): void {
  fake.seed(`researchSource/${UIDS.hbox}/sets/s1`, makeRecord('s1', '100'));
  fake.seed(`researchSource/${UIDS.hbox}/sets/s2`, makeRecord('s2', '200'));
}

function uidFlags(): string[] {
  return [
    '--hbox-uid',
    UIDS.hbox,
    '--mkleo-uid',
    UIDS.mkleo,
    '--sparg0-uid',
    UIDS.sparg0,
    '--izaw-uid',
    UIDS.izaw,
    '--receipt-dir',
    RECEIPT_DIR,
  ];
}

function receipts(harness: Harness): RegistryReceipt[] {
  return [...harness.files.entries()]
    .filter(([path]) => path.startsWith(`${RECEIPT_DIR}/registry-receipt-`))
    .map(([, content]) => validateRegistryReceipt(JSON.parse(content)));
}

function receiptFor(harness: Harness, command: string, workspace: string): RegistryReceipt {
  const match = receipts(harness).find(
    (receipt) => receipt.command === command && receipt.workspace === workspace,
  );
  if (!match) {
    throw new Error(`no ${command} receipt for ${workspace}`);
  }
  return match;
}

function readManifest(harness: Harness): RegistryManifest {
  return validateRegistryManifest(
    JSON.parse(harness.files.get(MANIFEST_PATH)!),
    UIDS,
    Date.now(),
    6 * 60 * 60 * 1000,
  );
}

function entriesOf(fake: FakeDatabase, uid: string): Record<string, unknown> {
  const tree = fake.dump() as Record<string, Record<string, unknown>>;
  return JSON.parse(JSON.stringify(tree.tournamentEntries?.[uid] ?? {})) as Record<string, unknown>;
}

async function dryRun(harness: Harness, extra: string[] = []): Promise<number> {
  return runRegistryOperator(
    ['dry-run', ...uidFlags(), '--manifest-out', MANIFEST_PATH, ...extra],
    harness.deps,
  );
}

/** A dry-run whose manifest carries the reviewed exception the fixture census needs. */
async function dryRunExcepted(
  harness: Harness,
  extra: string[] = [],
  exceptions = exceptionsFile(),
): Promise<number> {
  harness.files.set(EXCEPTIONS_PATH, exceptions);
  return dryRun(harness, ['--exceptions-in', EXCEPTIONS_PATH, ...extra]);
}

async function apply(harness: Harness, extra: string[] = []): Promise<number> {
  return runRegistryOperator(
    ['apply', ...uidFlags(), '--manifest-in', MANIFEST_PATH, ...extra],
    harness.deps,
  );
}

async function compare(harness: Harness, extra: string[] = []): Promise<number> {
  return runRegistryOperator(
    ['compare', ...uidFlags(), '--manifest-in', MANIFEST_PATH, ...extra],
    harness.deps,
  );
}

// ---------------------------------------------------------------------------

describe('argument surface', () => {
  it('rejects an unknown subcommand and a malformed flag pair', async () => {
    const harness = makeHarness();
    await expect(runRegistryOperator(['sync'], harness.deps)).rejects.toThrow(
      /Expected subcommand: dry-run, apply, compare/,
    );
    await expect(runRegistryOperator(['dry-run', '--hbox-uid'], harness.deps)).rejects.toThrow(
      /Invalid flag near --hbox-uid/,
    );
  });

  it('rejects an --account that is not one of the four demo workspaces', async () => {
    const harness = makeHarness();
    await expect(dryRun(harness, ['--account', 'supernova'])).rejects.toThrow(
      /--account must be one of hbox, mkleo, sparg0, izaw/,
    );
  });

  it('rejects duplicate destination uids', async () => {
    const harness = makeHarness();
    await expect(
      runRegistryOperator(
        [
          'dry-run',
          '--hbox-uid',
          UIDS.hbox,
          '--mkleo-uid',
          UIDS.hbox,
          '--sparg0-uid',
          UIDS.sparg0,
          '--izaw-uid',
          UIDS.izaw,
          '--manifest-out',
          MANIFEST_PATH,
        ],
        harness.deps,
      ),
    ).rejects.toThrow(/must be unique/);
  });

  it('rejects a non-positive bound', async () => {
    const harness = makeHarness();
    await expect(dryRun(harness, ['--request-timeout-ms', '0'])).rejects.toThrow(
      /--request-timeout-ms must be a positive integer/,
    );
    await expect(dryRun(harness, ['--max-stall-ms', 'abc'])).rejects.toThrow(
      /--max-stall-ms must be a positive integer/,
    );
  });
});

describe('dry-run', () => {
  it('is account-scoped: --account produces a single-account manifest and performs zero writes', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);

    expect(await dryRun(harness, ['--account', 'hbox'])).toBe(0);

    const manifest = readManifest(harness);
    expect(manifest.scope).toEqual(['hbox']);
    expect(manifest.writesPerformed).toBe(0);
    expect(manifest.accounts.mkleo).toBeUndefined();
    expect(manifest.accounts.hbox!.creates).toEqual(['histimport:100', 'histimport:200']);
    // Structural: the planner is read-only, so nothing landed in the registry.
    expect(entriesOf(harness.fake, UIDS.hbox)).toEqual({});
  });

  it('still supports all four accounts when --account is omitted', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    expect(await dryRun(harness)).toBe(0);
    expect(readManifest(harness).scope).toEqual(['hbox', 'mkleo', 'sparg0', 'izaw']);
    expect(receipts(harness)).toHaveLength(4);
  });

  it('writes a per-account receipt carrying host, uid, counts and the foreign digest, and reports its path', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/manual-1`, MANUAL_ENTRY);

    await dryRun(harness, ['--account', 'hbox']);

    const receipt = receiptFor(harness, 'dry-run', 'hbox');
    expect(receipt).toMatchObject({
      status: 'ok',
      databaseHost: HOST,
      uid: UIDS.hbox,
      manifestContentHash: null,
      foreignDigestStable: true,
      writes: null,
    });
    expect(receipt.before).toEqual(receipt.after);
    expect(receipt.before.foreignRows).toBe(1);
    expect(receipt.foreignDigestBefore.digest).toBe(
      computeForeignRowDigest(UIDS.hbox, { 'manual-1': MANUAL_ENTRY }).digest,
    );
    expect(harness.logs.some((line) => /\[receipt\] hbox: status=ok path=/.test(line))).toBe(true);
  });
});

describe('apply', () => {
  async function preparedApply(): Promise<Harness> {
    const harness = makeHarness();
    seedHbox(harness.fake);
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/manual-1`, MANUAL_ENTRY);
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/987`, LEGACY_STARTGG_ENTRY);
    await dryRunExcepted(harness, ['--account', 'hbox']);
    return harness;
  }

  it('applies one account, verifies it, and records before/after plus both foreign digests', async () => {
    const harness = await preparedApply();

    expect(await apply(harness, ['--account', 'hbox'])).toBe(0);

    const entries = entriesOf(harness.fake, UIDS.hbox);
    expect(Object.keys(entries).sort()).toEqual([
      '987',
      'histimport:100',
      'histimport:200',
      'manual-1',
    ]);
    // The two foreign rows are byte-identical after the apply.
    expect(entries['manual-1']).toEqual(MANUAL_ENTRY);
    expect(entries['987']).toEqual(LEGACY_STARTGG_ENTRY);

    const receipt = receiptFor(harness, 'apply', 'hbox');
    expect(receipt).toMatchObject({
      status: 'ok',
      foreignDigestStable: true,
      failedInvariants: [],
    });
    expect(receipt.manifestContentHash).toBe(readManifest(harness).contentHash);
    expect(receipt.before.creates).toBe(2);
    expect(receipt.after.creates).toBe(0);
    expect(receipt.after.unchanged).toBe(2);
    expect(receipt.writes).toMatchObject({
      written: ['histimport:100', 'histimport:200'],
      removed: [],
      abortedForeign: [],
    });
  });

  it('REFUSES a partially applied manifest and never re-runs it', async () => {
    const harness = await preparedApply();
    // Simulate an interrupted apply: one of the two planned rows landed.
    expect(await apply(harness, ['--account', 'hbox'])).toBe(0);
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/histimport:200`, null);
    // Now exactly one manifest row (histimport:100) is already applied.

    const rerun = makeHarness();
    // Reuse the same in-memory world for the second invocation.
    const second: Harness = { ...rerun, fake: harness.fake, files: harness.files };
    second.deps = {
      ...rerun.deps,
      database: harness.fake as unknown as Database,
      readFileText: async (path) => harness.files.get(path)!,
      writeFileText: async (path, content) => {
        harness.files.set(path, content);
      },
      log: (line) => second.logs.push(line),
      table: (rows) => second.tables.push(rows),
    };

    expect(await apply(second, ['--account', 'hbox'])).toBe(1);
    const refusal = second.logs.join('\n');
    expect(refusal).toMatch(/PARTIALLY APPLIED/);
    expect(refusal).toMatch(/Do NOT re-run this manifest/);
    expect(refusal).toMatch(/regenerate a fresh/);
    expect(refusal).toMatch(/Apply refused. NOTHING was written/);

    const receipt = receipts(second).find(
      (candidate) => candidate.command === 'apply' && candidate.status === 'refused',
    )!;
    expect(receipt.failedInvariants[0]).toMatch(/^partially-applied:/);
    expect(receipt.writes).toBeNull();
  });

  it('REFUSES when a non-registry row changed since the dry-run', async () => {
    const harness = await preparedApply();
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/manual-1`, {
      ...MANUAL_ENTRY,
      setsPlayed: 99,
    });

    expect(await apply(harness, ['--account', 'hbox'])).toBe(1);
    expect(harness.logs.join('\n')).toMatch(/NON-registry rows changed/);
    expect(receiptFor(harness, 'apply', 'hbox').status).toBe('refused');
    // Nothing was written despite the registry plan itself being unchanged.
    expect(Object.keys(entriesOf(harness.fake, UIDS.hbox)).sort()).toEqual(['987', 'manual-1']);
  });

  it('REFUSES when the source data drifted since the dry-run', async () => {
    const harness = await preparedApply();
    harness.fake.seed(`researchSource/${UIDS.hbox}/sets/s3`, makeRecord('s3', '300'));

    expect(await apply(harness, ['--account', 'hbox'])).toBe(1);
    expect(harness.logs.join('\n')).toMatch(/researchSource records changed/);
    expect(entriesOf(harness.fake, UIDS.hbox)['histimport:100']).toBeUndefined();
  });

  it('fails the run when a foreign value squats on a planned key at commit time', async () => {
    const harness = await preparedApply();
    // A foreign value lands between preflight and the write — the projector
    // aborts rather than clobbering, and the operator must exit nonzero.
    let seeded = false;
    const guarded = {
      ref: (path?: string) => {
        const ref = harness.fake.ref(path);
        return {
          ...ref,
          transaction: async (updateFn: (current: unknown) => unknown) => {
            if (!seeded) {
              seeded = true;
              harness.fake.seed(`tournamentEntries/${UIDS.hbox}/histimport:100`, MANUAL_ENTRY);
            }
            return ref.transaction(updateFn);
          },
        };
      },
    } as unknown as Database;

    const second: Harness = { ...harness, deps: { ...harness.deps, database: guarded } };
    expect(await apply(second, ['--account', 'hbox'])).toBe(1);

    const receipt = receipts(second).find(
      (candidate) => candidate.command === 'apply' && candidate.status === 'failed',
    )!;
    expect(receipt.failedInvariants.join(' ')).toMatch(/foreign-abort/);
    expect(receipt.writes!.abortedForeign).toContain('histimport:100');
    expect(harness.logs.join('\n')).toMatch(/Apply STOPPED after hbox/);
  });

  it('fails the run when a foreign row is mutated DURING the apply (digest invariant)', async () => {
    const harness = await preparedApply();
    let mutated = false;
    const mutating = {
      ref: (path?: string) => {
        const ref = harness.fake.ref(path);
        return {
          ...ref,
          transaction: async (updateFn: (current: unknown) => unknown) => {
            const result = await ref.transaction(updateFn);
            if (!mutated) {
              mutated = true;
              harness.fake.seed(`tournamentEntries/${UIDS.hbox}/manual-1`, {
                ...MANUAL_ENTRY,
                setsPlayed: 42,
              });
            }
            return result;
          },
        };
      },
    } as unknown as Database;

    const second: Harness = { ...harness, deps: { ...harness.deps, database: mutating } };
    expect(await apply(second, ['--account', 'hbox'])).toBe(1);

    const receipt = receipts(second).find(
      (candidate) => candidate.command === 'apply' && candidate.status === 'failed',
    )!;
    expect(receipt.foreignDigestStable).toBe(false);
    expect(receipt.failedInvariants.join(' ')).toMatch(
      /foreign-row-digest changed across the apply/,
    );
    expect(receipt.foreignDigestBefore.digest).not.toBe(receipt.foreignDigestAfter.digest);
  });

  it('refuses a manifest whose scope does not cover the requested account', async () => {
    const harness = await preparedApply();
    await expect(apply(harness, ['--account', 'mkleo'])).rejects.toThrow(
      /does not cover --account mkleo/,
    );
  });

  it('refuses a manifest sealed against a different database host', async () => {
    const harness = await preparedApply();
    const elsewhere: Harness = {
      ...harness,
      deps: { ...harness.deps, databaseHost: 'other-project.firebaseio.com' },
    };
    await expect(apply(elsewhere, ['--account', 'hbox'])).rejects.toThrow(
      /does not match the active database/,
    );
  });

  it('refuses a structurally invalid manifest', async () => {
    const harness = makeHarness();
    harness.files.set(MANIFEST_PATH, JSON.stringify({ formatVersion: 1 }));
    await expect(apply(harness, ['--account', 'hbox'])).rejects.toThrow();
  });

  it('refuses a stale manifest', async () => {
    const harness = await preparedApply();
    // Advance the operator's clock past the staleness window rather than
    // sleeping: the manifest was sealed microseconds ago.
    const later: Harness = {
      ...harness,
      deps: { ...harness.deps, now: () => Date.now() + 60_000 },
    };
    await expect(apply(later, ['--account', 'hbox', '--max-age-ms', '1000'])).rejects.toThrow(
      /stale or dated in the future/,
    );
  });
});

// ---------------------------------------------------------------------------
// Hard gate #4, B9 — `--account` is mandatory for apply.
// ---------------------------------------------------------------------------

describe('apply is account-scoped by construction (B9)', () => {
  it('REFUSES an apply with no --account, naming the correct per-account form', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/manual-1`, MANUAL_ENTRY);
    await dryRunExcepted(harness, ['--account', 'hbox']);

    await expect(apply(harness)).rejects.toThrow(
      /apply requires --account <hbox\|mkleo\|sparg0\|izaw>/,
    );
    // The message has to be actionable, not merely correct.
    await expect(apply(harness)).rejects.toThrow(/apply --account hbox/);
    // Nothing was written, and no receipt claims otherwise.
    expect(entriesOf(harness.fake, UIDS.hbox)).toEqual({ 'manual-1': MANUAL_ENTRY });
    expect(receipts(harness).some((receipt) => receipt.command === 'apply')).toBe(false);
  });

  it('still allows the all-accounts form for the two read-only subcommands', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    expect(await dryRun(harness)).toBe(0);
    // compare over all four accounts: nonzero (nothing applied) but not a
    // usage refusal — it planned, compared and wrote four receipts.
    expect(await compare(harness)).toBe(1);
    expect(receipts(harness).filter((receipt) => receipt.command === 'compare')).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Hard gate #4, B8 — the source census freeze at the operator boundary.
// ---------------------------------------------------------------------------

describe('the source census freeze (B8)', () => {
  it('REFUSES a pre-write whose sourceSetCount is not the owner-frozen figure', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    // No --exceptions-in: the manifest carries no authorization for the
    // fixture's two-record census.
    await dryRun(harness, ['--account', 'hbox']);

    expect(await apply(harness, ['--account', 'hbox'])).toBe(1);
    const log = harness.logs.join('\n');
    expect(log).toMatch(/owner-frozen census for this account is 8413/);
    expect(log).toMatch(/Apply refused. NOTHING was written/);
    expect(entriesOf(harness.fake, UIDS.hbox)).toEqual({});
    const receipt = receiptFor(harness, 'apply', 'hbox');
    expect(receipt.status).toBe('refused');
    expect(receipt.failedInvariants[0]).toMatch(/^frozen-source-set-drift:/);
    expect(receipt.writes).toBeNull();
  });

  it('warns about the pre-write gate at DRY-RUN time rather than only at apply', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    expect(await dryRun(harness, ['--account', 'hbox'])).toBe(0);
    expect(harness.logs.join('\n')).toMatch(
      /\[pre-write-gate\] frozen-source-set-drift: .*owner-frozen census/,
    );
  });

  it('REFUSES a pre-write on corrupt source records unless the manifest excepts that exact count', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    // One stored source child that no longer parses: skipped by the
    // projector, so it is invisible to every derived row.
    harness.fake.seed(`researchSource/${UIDS.hbox}/sets/broken`, { notASetRecord: true });

    await dryRunExcepted(
      harness,
      ['--account', 'hbox'],
      exceptionsFile({ acceptedSourceSetCount: 3 }),
    );
    expect(await apply(harness, ['--account', 'hbox'])).toBe(1);
    expect(harness.logs.join('\n')).toMatch(
      /1 stored source record\(s\) failed the source-record schema/,
    );
    expect(receiptFor(harness, 'apply', 'hbox').failedInvariants[0]).toMatch(
      /^corrupt-source-records:/,
    );
    expect(entriesOf(harness.fake, UIDS.hbox)).toEqual({});

    // Now with the exact reviewed exception the corruption becomes applyable.
    const excepted = makeHarness();
    seedHbox(excepted.fake);
    excepted.fake.seed(`researchSource/${UIDS.hbox}/sets/broken`, { notASetRecord: true });
    await dryRunExcepted(
      excepted,
      ['--account', 'hbox'],
      exceptionsFile({ acceptedSourceSetCount: 3, acceptedCorruptSourceRecords: 1 }),
    );
    expect(await apply(excepted, ['--account', 'hbox'])).toBe(0);
    expect(Object.keys(entriesOf(excepted.fake, UIDS.hbox)).sort()).toEqual([
      'histimport:100',
      'histimport:200',
    ]);
  });

  it('REFUSES a pre-write on a collision unless the manifest excepts that exact key set', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    // A foreign value squatting on a derived histimport: key.
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/histimport:100`, MANUAL_ENTRY);

    await dryRunExcepted(harness, ['--account', 'hbox']);
    expect(await apply(harness, ['--account', 'hbox'])).toBe(1);
    expect(harness.logs.join('\n')).toMatch(
      /collide with a FOREIGN value on their histimport: key/,
    );
    expect(receiptFor(harness, 'apply', 'hbox').failedInvariants[0]).toMatch(/^collisions:/);
    // The squatter is untouched.
    expect(entriesOf(harness.fake, UIDS.hbox)['histimport:100']).toEqual(MANUAL_ENTRY);
  });

  it('REFUSES an apply when the census moved even though the derived rows did not', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    await dryRunExcepted(harness, ['--account', 'hbox']);

    // A corrupt source record appears AFTER the review. It derives nothing, so
    // the row set — and therefore `rowSetHash` — is untouched. This is the
    // exact hole B8 closes.
    harness.fake.seed(`researchSource/${UIDS.hbox}/sets/broken`, { notASetRecord: true });

    expect(await apply(harness, ['--account', 'hbox'])).toBe(1);
    const log = harness.logs.join('\n');
    expect(log).toMatch(/the SOURCE CENSUS moved since the dry-run/);
    expect(log).toMatch(/sourceSetCount 2 -> 3/);
    expect(log).toMatch(/corruptSourceRecords 0 -> 1/);
    expect(receiptFor(harness, 'apply', 'hbox').failedInvariants[0]).toMatch(/^census-drift:/);
    expect(entriesOf(harness.fake, UIDS.hbox)).toEqual({});
  });

  it('FAILS a compare when the census moved after an otherwise settled apply', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    await dryRunExcepted(harness, ['--account', 'hbox']);
    expect(await apply(harness, ['--account', 'hbox'])).toBe(0);
    // Registry is settled; only the source census moves.
    harness.fake.seed(`researchSource/${UIDS.hbox}/sets/broken`, { notASetRecord: true });

    expect(await compare(harness, ['--account', 'hbox'])).toBe(1);
    const receipt = receipts(harness).find(
      (candidate) => candidate.command === 'compare' && candidate.status === 'failed',
    )!;
    expect(receipt.failedInvariants.join(' ')).toMatch(/censusMatches=false/);
    expect(receipt.failedInvariants.join(' ')).toMatch(/pendingCreates=0/);
    expect(receipt.failedInvariants.join(' ')).toMatch(/corruptSourceRecords 0 -> 1/);
  });

  it('refuses a dry-run whose reviewed exception does not describe the observed plan', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    // Claims 5 corrupt records; the plan has none.
    expect(
      await dryRunExcepted(
        harness,
        ['--account', 'hbox'],
        exceptionsFile({ acceptedCorruptSourceRecords: 5 }),
      ),
    ).toBe(1);
    expect(harness.logs.join('\n')).toMatch(
      /accepts 5 corrupt source record\(s\) but the plan has 0/,
    );
    expect(harness.files.has(MANIFEST_PATH)).toBe(false);
  });

  it('rejects a structurally invalid exceptions file rather than ignoring it', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    harness.files.set(EXCEPTIONS_PATH, JSON.stringify({ hbox: { reason: 'too short' } }));
    await expect(
      dryRun(harness, ['--account', 'hbox', '--exceptions-in', EXCEPTIONS_PATH]),
    ).rejects.toThrow();
  });
});

describe('compare', () => {
  it('reports an exact match after a successful apply and exits 0', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/manual-1`, MANUAL_ENTRY);
    await dryRunExcepted(harness, ['--account', 'hbox']);
    await apply(harness, ['--account', 'hbox']);

    expect(await compare(harness, ['--account', 'hbox'])).toBe(0);
    const receipt = receiptFor(harness, 'compare', 'hbox');
    expect(receipt.status).toBe('ok');
    expect(harness.logs.join('\n')).toMatch(/every scoped account exactly matches/);
  });

  it('exits nonzero and records the mismatch when the registry does not hold the reviewed rows', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    await dryRun(harness, ['--account', 'hbox']);

    // Never applied — compare must not call that a match.
    expect(await compare(harness, ['--account', 'hbox'])).toBe(1);
    const receipt = receiptFor(harness, 'compare', 'hbox');
    expect(receipt.status).toBe('failed');
    expect(receipt.failedInvariants.join(' ')).toMatch(/pendingCreates=2/);
  });

  it('exits nonzero when a foreign row changed after the apply, even with the registry settled', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/manual-1`, MANUAL_ENTRY);
    await dryRunExcepted(harness, ['--account', 'hbox']);
    await apply(harness, ['--account', 'hbox']);
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/manual-1`, {
      ...MANUAL_ENTRY,
      setsPlayed: 7,
    });

    expect(await compare(harness, ['--account', 'hbox'])).toBe(1);
    expect(receiptFor(harness, 'compare', 'hbox').failedInvariants.join(' ')).toMatch(
      /foreignDigestMatches=false/,
    );
  });
});

describe('observability and bounds', () => {
  it('emits a heartbeat naming account, stage, unit and counts', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    // A heartbeat every 5ms plus a deliberately slow read guarantees at least
    // one beat lands while the operator is mid-plan.
    const slow = {
      ref: (path?: string) => {
        const ref = harness.fake.ref(path);
        return {
          ...ref,
          get: async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return ref.get();
          },
        };
      },
    } as unknown as Database;
    const instrumented: Harness = { ...harness, deps: { ...harness.deps, database: slow } };

    expect(await dryRun(instrumented, ['--account', 'hbox', '--heartbeat-ms', '5'])).toBe(0);
    const beat = harness.logs.find((line) => line.startsWith('[heartbeat]'));
    expect(beat).toBeDefined();
    expect(beat).toMatch(/account=hbox/);
    expect(beat).toMatch(/stage=/);
    expect(beat).toMatch(/unit=/);
    expect(beat).toMatch(/derived=/);
    expect(beat).toMatch(/lastProgressMsAgo=/);
  });

  it('aborts on the no-progress watchdog and exits nonzero with a receipt', async () => {
    const harness = makeHarness();
    const hanging = {
      ref: () => ({ get: () => new Promise(() => undefined) }),
    } as unknown as Database;
    const stalled: Harness = { ...harness, deps: { ...harness.deps, database: hanging } };

    const code = await dryRun(stalled, [
      '--account',
      'hbox',
      '--max-stall-ms',
      '60',
      '--heartbeat-ms',
      '20',
      '--request-timeout-ms',
      '60000',
    ]);
    expect(code).toBe(1);
    expect(harness.logs.join('\n')).toMatch(/\[watchdog\] no progress for/);
    expect(harness.logs.join('\n')).toMatch(/NO manifest was written/);
    expect(harness.files.has(MANIFEST_PATH)).toBe(false);
    expect(receiptFor(harness, 'dry-run', 'hbox').status).toBe('failed');
  });

  it('aborts a hung RTDB read at --request-timeout-ms', async () => {
    const harness = makeHarness();
    const hanging = {
      ref: () => ({ get: () => new Promise(() => undefined) }),
    } as unknown as Database;
    const timedOut: Harness = { ...harness, deps: { ...harness.deps, database: hanging } };

    const code = await dryRun(timedOut, [
      '--account',
      'hbox',
      '--max-stall-ms',
      '60000',
      '--request-timeout-ms',
      '50',
    ]);
    expect(code).toBe(1);
    expect(harness.logs.join('\n')).toMatch(/exceeded its 50ms request timeout/);
    expect(receiptFor(harness, 'dry-run', 'hbox').failedInvariants.join(' ')).toMatch(
      /request timeout/,
    );
  });

  it('stops issuing work once the lifecycle signal aborts', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    const controller = new AbortController();
    controller.abort(new Error('terminated by SIGINT'));
    const interrupted: Harness = {
      ...harness,
      deps: { ...harness.deps, signal: controller.signal },
    };

    expect(await dryRun(interrupted, ['--account', 'hbox'])).toBe(1);
    expect(harness.logs.join('\n')).toMatch(/terminated by SIGINT/);
    expect(entriesOf(harness.fake, UIDS.hbox)).toEqual({});
  });

  it('reports a failed account without a manifest and still writes its receipt', async () => {
    const harness = makeHarness();
    const broken = {
      ref: () => ({ get: () => Promise.reject(new Error('connect ECONNREFUSED')) }),
    } as unknown as Database;
    const failing: Harness = { ...harness, deps: { ...harness.deps, database: broken } };

    expect(await dryRun(failing, ['--account', 'hbox'])).toBe(1);
    expect(harness.files.has(MANIFEST_PATH)).toBe(false);
    const receipt = receiptFor(harness, 'dry-run', 'hbox');
    expect(receipt.status).toBe('failed');
    expect(receipt.failedInvariants.join(' ')).toMatch(/ECONNREFUSED/);
  });
});

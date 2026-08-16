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
    await dryRun(harness, ['--account', 'hbox']);
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

describe('compare', () => {
  it('reports an exact match after a successful apply and exits 0', async () => {
    const harness = makeHarness();
    seedHbox(harness.fake);
    harness.fake.seed(`tournamentEntries/${UIDS.hbox}/manual-1`, MANUAL_ENTRY);
    await dryRun(harness, ['--account', 'hbox']);
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
    await dryRun(harness, ['--account', 'hbox']);
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

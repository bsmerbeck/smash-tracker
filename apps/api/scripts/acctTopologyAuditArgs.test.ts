import { describe, expect, it } from 'vitest';
import {
  buildAcctTopologyReceipt,
  parseAcctTopologyArgs,
  resolveSourceTenants,
} from './acctTopologyAudit.js';
import { computeArtifactHash } from './migrateManifestArtifact.js';

/**
 * Codex hard gate at `fb9a3930` (P1): four-account coverage must be SEALED.
 * The prior CLI accepted the same uid four times and omitted the subject uids
 * from a passing receipt, so an artifact could claim "four subjects" without
 * proving which four.
 */

const COACH = 'coach-uid-00000000001';
const HBOX = 'hbox-uid-000000000001';
const MKLEO = 'mkleo-uid-00000000001';
const SPARG0 = 'sparg0-uid-0000000001';
const IZAW = 'izaw-uid-000000000001';

function baseArgv(overrides: Record<string, string> = {}): string[] {
  const flags: Record<string, string> = {
    '--coach-uid': COACH,
    '--hbox-uid': HBOX,
    '--mkleo-uid': MKLEO,
    '--sparg0-uid': SPARG0,
    '--izaw-uid': IZAW,
    '--migration-manifest': './migration-manifest.json',
    '--reviewed-sha': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ...overrides,
  };
  return Object.entries(flags).flat();
}

/** A schema-valid manifest whose recorded hash is genuinely correct. */
function makeManifest(destUids: string[] = [HBOX, MKLEO, SPARG0, IZAW]) {
  const labels = ['Hungrybox', 'MkLeo', 'Sparg0', 'IzAw'];
  const withoutHash = {
    generatedAtMs: 1_786_463_913_238,
    dbIdentity: { host: 'smash-tracker-f97b7.firebaseio.com', projectId: null },
    sourceToDestMap: destUids.map((destUid, index) => ({
      sourceId: `0000000${index}-1111-4111-8111-11111111111${index}`,
      destUid,
      label: labels[index]!,
    })),
    workspaces: [],
    ok: true,
  };
  return { ...withoutHash, sha256: computeArtifactHash(withoutHash) };
}

describe('parseAcctTopologyArgs', () => {
  it('parses a complete command line', () => {
    const args = parseAcctTopologyArgs(baseArgv());
    expect(args.coachUid).toBe(COACH);
    expect(args.subjects.map((s) => s.uid)).toEqual([HBOX, MKLEO, SPARG0, IZAW]);
    expect(args.reviewedSha).toHaveLength(40);
  });

  it('rejects a DUPLICATE flag rather than silently taking the last value', () => {
    expect(() =>
      parseAcctTopologyArgs([...baseArgv(), '--hbox-uid', 'sneaky-uid-0000000001']),
    ).toThrow(/duplicate flag: --hbox-uid/);
  });

  it('rejects an UNKNOWN flag rather than ignoring a typo', () => {
    expect(() => parseAcctTopologyArgs([...baseArgv(), '--allow-empty-coach-tree'])).toThrow(
      /unknown flag: --allow-empty-coach-tree/,
    );
  });

  it('rejects a missing required flag', () => {
    const argv = baseArgv().filter((token, index, all) => {
      const previous = all[index - 1];
      return token !== '--reviewed-sha' && previous !== '--reviewed-sha';
    });
    expect(() => parseAcctTopologyArgs(argv)).toThrow(/--reviewed-sha is required/);
  });

  it('rejects a missing demo uid, naming it', () => {
    const argv = baseArgv().filter((token, index, all) => {
      const previous = all[index - 1];
      return token !== '--sparg0-uid' && previous !== '--sparg0-uid';
    });
    expect(() => parseAcctTopologyArgs(argv)).toThrow(/missing --sparg0-uid/);
  });

  it('rejects a non-positive bound', () => {
    expect(() => parseAcctTopologyArgs(baseArgv({ '--max-stall-ms': '0' }))).toThrow(
      /--max-stall-ms must be a positive integer/,
    );
  });
});

describe('resolveSourceTenants — binds the audited uids to the canonical manifest', () => {
  it('derives the four source tenants from a valid manifest', () => {
    const subjects = parseAcctTopologyArgs(baseArgv()).subjects;
    const { sourceTenants } = resolveSourceTenants(makeManifest(), subjects);
    expect(sourceTenants).toHaveLength(4);
    expect(sourceTenants.map((s) => s.label)).toEqual(['Hungrybox', 'MkLeo', 'Sparg0', 'IzAw']);
  });

  it('rejects a manifest whose recorded hash does not match its content', () => {
    const subjects = parseAcctTopologyArgs(baseArgv()).subjects;
    const tampered = { ...makeManifest(), generatedAtMs: 1 };
    expect(() => resolveSourceTenants(tampered, subjects)).toThrow(/hash mismatch/);
  });

  it('rejects DUPLICATE SUBSTITUTION: the same uid supplied four times', () => {
    const subjects = parseAcctTopologyArgs(
      baseArgv({ '--mkleo-uid': HBOX, '--sparg0-uid': HBOX, '--izaw-uid': HBOX }),
    ).subjects;
    // The manifest names four distinct destUids, so three of the four supplied
    // uids simply are not in it — the substitution cannot pass the binding.
    expect(() => resolveSourceTenants(makeManifest(), subjects)).toThrow(
      /is not one of the manifest's destUids/,
    );
  });

  it('rejects a uid that is not in the manifest at all', () => {
    const subjects = parseAcctTopologyArgs(
      baseArgv({ '--izaw-uid': 'stranger-uid-000000001' }),
    ).subjects;
    expect(() => resolveSourceTenants(makeManifest(), subjects)).toThrow(
      /--izaw-uid is not one of the manifest's destUids/,
    );
  });

  it('rejects a manifest with a duplicate destUid', () => {
    const subjects = parseAcctTopologyArgs(baseArgv()).subjects;
    expect(() => resolveSourceTenants(makeManifest([HBOX, HBOX, SPARG0, IZAW]), subjects)).toThrow(
      /duplicate destUid/,
    );
  });

  it('rejects a manifest that fails the strict schema', () => {
    const subjects = parseAcctTopologyArgs(baseArgv()).subjects;
    expect(() => resolveSourceTenants({ nope: true }, subjects)).toThrow(/schema validation/);
  });
});

describe('buildAcctTopologyReceipt — evidence identity round-trips through JSON', () => {
  const manifest = makeManifest();

  const result = {
    ok: true,
    coachUid: COACH,
    subjects: [
      { label: 'hbox', uid: HBOX },
      { label: 'mkleo', uid: MKLEO },
      { label: 'sparg0', uid: SPARG0 },
      { label: 'izaw', uid: IZAW },
    ],
    coachTenantIds: ['t-1'],
    membershipReads: 4,
    sourceDispositions: [],
    visibleSourceTenantCount: 0,
    findings: [],
  };

  const receipt = buildAcctTopologyReceipt({
    identity: {
      generatedAtMs: 1_786_500_000_000,
      reviewedSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      databaseHost: 'smash-tracker-f97b7.firebaseio.com',
      firebaseProjectId: 'smash-tracker-f97b7',
      databaseEmulatorHost: null,
    },
    manifestPath: './migration-manifest.json',
    manifest,
    bounds: { requestTimeoutMs: 30_000, maxStallMs: 300_000, heartbeatIntervalMs: 30_000 },
    exitCode: 0,
    result,
  });

  it('seals every required identity field', () => {
    expect(receipt).toMatchObject({
      receiptVersion: 2,
      audit: 'acct-topology',
      requirement: ['ACCT-01', 'ACCT-03'],
      generatedAtMs: 1_786_500_000_000,
      reviewedSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      databaseHost: 'smash-tracker-f97b7.firebaseio.com',
      firebaseProjectId: 'smash-tracker-f97b7',
      databaseEmulatorHost: null,
      exitCode: 0,
    });
  });

  it('names WHICH four accounts were audited, not merely that there were four', () => {
    expect(receipt.subjects).toEqual(result.subjects);
    expect(receipt.coachUid).toBe(COACH);
    expect(new Set(receipt.subjects.map((s) => s.uid)).size).toBe(4);
  });

  it('seals the manifest hash and its full source map', () => {
    expect(receipt.migrationManifest.sha256).toBe(manifest.sha256);
    expect(receipt.migrationManifest.sourceToDestMap).toEqual(manifest.sourceToDestMap);
  });

  it('survives a JSON round-trip byte-for-byte', () => {
    const roundTripped = JSON.parse(JSON.stringify(receipt));
    expect(roundTripped).toEqual(JSON.parse(JSON.stringify(receipt)));
    expect(roundTripped.subjects).toEqual(result.subjects);
    expect(roundTripped.migrationManifest.sha256).toBe(manifest.sha256);
    expect(roundTripped.databaseEmulatorHost).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { resolveTournamentTier, type ResearchSourceSetRecord } from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { computeForeignRowDigest } from './foreignDigest.js';
import {
  applyTournamentRegistryPlan,
  planTournamentRegistry,
  projectTournamentRegistry,
  type RegistryProgressEvent,
} from './reconcile.js';

const UID = 'demo-uid-1';
const NOW_MS = 1_755_000_000_000;
const LATER_MS = 1_756_000_000_000;

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function makeRecord(
  providerSetId: string,
  eventId: string,
  overrides: Partial<ResearchSourceSetRecord> = {},
): ResearchSourceSetRecord {
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
    ...overrides,
  };
}

function seedSources(database: FakeDatabase, records: ResearchSourceSetRecord[]): void {
  for (const record of records) {
    database.seed(`researchSource/${UID}/sets/${record.providerSetId}`, record);
  }
}

/** The three foreign entry shapes reconciliation must never touch. */
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
const PARRYGG_ENTRY = {
  eventName: 'Ultimate Singles',
  firstSetAt: 1_691_000_000_000,
  lastSetAt: 1_691_000_900_000,
  setsPlayed: 2,
  source: 'parrygg',
};

function entriesDump(database: FakeDatabase): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify((database.dump() as Record<string, unknown>).tournamentEntries ?? {}),
  ) as Record<string, unknown>;
}

describe('projectTournamentRegistry', () => {
  it('writes one owned registry row per derived event under tournamentEntries/{uid}/{entryId}', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100'), makeRecord('s2', '200')]);

    const { plan, apply } = await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);

    expect(plan.creates).toEqual(['histimport:100', 'histimport:200']);
    expect(apply.written).toEqual(['histimport:100', 'histimport:200']);
    expect(apply.writesPerformed).toBe(2);

    const entries = entriesDump(database)[UID] as Record<string, unknown>;
    expect(Object.keys(entries).sort()).toEqual(['histimport:100', 'histimport:200']);
    expect(entries['histimport:100']).toMatchObject({
      origin: 'admin-imported',
      provider: 'startgg',
      startggEventId: '100',
      registryWitness: 'research-import:v1:100',
      playedSetCount: 1,
      setsPlayed: 1,
      provenance: { source: 'research-import', importedAtMs: NOW_MS },
    });
  });

  it('is idempotent: a second run plans zero writes and leaves the tree byte-identical', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100'), makeRecord('s2', '200')]);

    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);
    const before = entriesDump(database);

    // A later clock must not matter: importedAtMs is preserved from the
    // stored rows, and asOfMs is derived from the data.
    const second = await projectTournamentRegistry(asDatabase(database), UID, LATER_MS);

    expect(second.plan.creates).toEqual([]);
    expect(second.plan.updates).toEqual([]);
    expect(second.plan.orphanRemovals).toEqual([]);
    expect(second.plan.unchanged).toEqual(['histimport:100', 'histimport:200']);
    expect(second.apply.writesPerformed).toBe(0);
    expect(entriesDump(database)).toEqual(before);
  });

  it('preserves the first-import stamp across a content-changing refresh', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);

    // The provider corrected the placement on a later observation.
    seedSources(database, [
      makeRecord('s1', '100', {
        lastObservedAtMs: 1_754_500_000_000,
        entrants: [{ entrantId: 'e-subject', name: 'Subject', seedNum: 5, placement: 1 }],
      }),
    ]);
    const second = await projectTournamentRegistry(asDatabase(database), UID, LATER_MS);

    expect(second.plan.updates).toEqual(['histimport:100']);
    const entries = entriesDump(database)[UID] as Record<string, Record<string, unknown>>;
    expect(entries['histimport:100']).toMatchObject({
      placement: 1,
      provenance: {
        importedAtMs: NOW_MS, // first-import stamp survives
        asOfMs: 1_754_500_000_000, // freshness follows the data
      },
    });
  });

  it('removes only witness-owned orphans and preserves manual + linked-sync entries byte-for-byte', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100'), makeRecord('s2', '999')]);
    database.seed(`tournamentEntries/${UID}/manual-locals-42-abc`, MANUAL_ENTRY);
    database.seed(`tournamentEntries/${UID}/987`, LEGACY_STARTGG_ENTRY);
    database.seed(`tournamentEntries/${UID}/pgg-weekly`, PARRYGG_ENTRY);

    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);
    const withOrphan = entriesDump(database)[UID] as Record<string, unknown>;
    expect(Object.keys(withOrphan).sort()).toEqual([
      '987',
      'histimport:100',
      'histimport:999',
      'manual-locals-42-abc',
      'pgg-weekly',
    ]);

    // Event 999's sets disappear from the source tier (a re-keyed event, a
    // correction) — its row is now a witness-owned orphan.
    await asDatabase(database).ref(`researchSource/${UID}/sets/s2`).remove();
    const second = await projectTournamentRegistry(asDatabase(database), UID, LATER_MS);

    expect(second.plan.orphanRemovals).toEqual(['histimport:999']);
    expect(second.apply.removed).toEqual(['histimport:999']);
    expect(second.plan.preservedForeignCount).toBe(3);

    const entries = entriesDump(database)[UID] as Record<string, unknown>;
    expect(Object.keys(entries).sort()).toEqual([
      '987',
      'histimport:100',
      'manual-locals-42-abc',
      'pgg-weekly',
    ]);
    // Byte-for-byte: the three foreign entries are structurally identical
    // to what was seeded, not merely present.
    expect(entries['manual-locals-42-abc']).toEqual(MANUAL_ENTRY);
    expect(entries['987']).toEqual(LEGACY_STARTGG_ENTRY);
    expect(entries['pgg-weekly']).toEqual(PARRYGG_ENTRY);
  });

  it('reports a foreign value on a histimport key as a collision and never writes over it', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    const squatter = { ...MANUAL_ENTRY, eventName: 'Squatter' };
    database.seed(`tournamentEntries/${UID}/histimport:100`, squatter);

    const { plan, apply } = await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);

    expect(plan.collisions).toEqual(['histimport:100']);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(apply.writesPerformed).toBe(0);
    const entries = entriesDump(database)[UID] as Record<string, unknown>;
    expect(entries['histimport:100']).toEqual(squatter);
  });

  it('skips corrupt source records (counted) and still projects the healthy ones', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    database.seed(`researchSource/${UID}/sets/corrupt`, { providerSetId: 'corrupt' });

    const { plan } = await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);

    expect(plan.corruptSourceRecords).toBe(1);
    expect(plan.sourceSetCount).toBe(2);
    expect(plan.creates).toEqual(['histimport:100']);
  });

  it('planTournamentRegistry performs zero writes of any kind', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    database.seed(`tournamentEntries/${UID}/manual-locals-42-abc`, MANUAL_ENTRY);
    const before = JSON.parse(JSON.stringify(database.dump()));

    const plan = await planTournamentRegistry(asDatabase(database), UID, NOW_MS);

    expect(plan.creates).toEqual(['histimport:100']);
    expect(JSON.parse(JSON.stringify(database.dump()))).toEqual(before);
  });

  it('aborts (never clobbers) when a foreign value lands on a planned key between plan and apply', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    const plan = await planTournamentRegistry(asDatabase(database), UID, NOW_MS);

    const squatter = { ...MANUAL_ENTRY, eventName: 'Race Winner' };
    database.seed(`tournamentEntries/${UID}/histimport:100`, squatter);

    const apply = await applyTournamentRegistryPlan(asDatabase(database), plan);

    expect(apply.abortedForeign).toEqual(['histimport:100']);
    expect(apply.writesPerformed).toBe(0);
    const entries = entriesDump(database)[UID] as Record<string, unknown>;
    expect(entries['histimport:100']).toEqual(squatter);
  });

  it('aborts an orphan delete when the child turns foreign between plan and apply', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100'), makeRecord('s2', '999')]);
    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);
    await asDatabase(database).ref(`researchSource/${UID}/sets/s2`).remove();

    const plan = await planTournamentRegistry(asDatabase(database), UID, LATER_MS);
    expect(plan.orphanRemovals).toEqual(['histimport:999']);

    // The owner hand-replaces the row with a manual entry before apply runs.
    const replacement = { ...MANUAL_ENTRY, eventName: 'Hand-Curated' };
    database.seed(`tournamentEntries/${UID}/histimport:999`, replacement);

    const apply = await applyTournamentRegistryPlan(asDatabase(database), plan);

    expect(apply.abortedForeign).toEqual(['histimport:999']);
    const entries = entriesDump(database)[UID] as Record<string, unknown>;
    expect(entries['histimport:999']).toEqual(replacement);
  });

  it('rejects an unsafe uid before any ref is constructed', async () => {
    const database = new FakeDatabase();
    await expect(planTournamentRegistry(asDatabase(database), 'bad.uid', NOW_MS)).rejects.toThrow(
      /Unsafe uid/,
    );
  });
});

/**
 * 30.3 operator hardening: the projector now also carries the census and the
 * foreign-row preservation witness the operator's receipts are built from,
 * and reports work-unit progress so the operator's heartbeat and no-progress
 * watchdog have something honest to measure.
 */
describe('plan census + foreign-row digest', () => {
  it('reports the entry census and digests exactly the non-owned children', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    database.seed(`tournamentEntries/${UID}/manual-1`, MANUAL_ENTRY);
    database.seed(`tournamentEntries/${UID}/987`, LEGACY_STARTGG_ENTRY);
    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);

    const plan = await planTournamentRegistry(asDatabase(database), UID, LATER_MS);
    expect(plan.entryChildCount).toBe(3);
    expect(plan.ownedRowCount).toBe(1);
    expect(plan.preservedForeignCount).toBe(2);
    expect(plan.foreignDigest.count).toBe(2);
    expect(plan.foreignDigest.keys).toEqual(['987', 'manual-1']);
    expect(plan.foreignDigest.digest).toBe(
      computeForeignRowDigest(UID, { 'manual-1': MANUAL_ENTRY, '987': LEGACY_STARTGG_ENTRY })
        .digest,
    );
  });

  it('keeps the digest byte-stable across an apply that only touches owned rows', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    database.seed(`tournamentEntries/${UID}/manual-1`, MANUAL_ENTRY);

    const before = await planTournamentRegistry(asDatabase(database), UID, NOW_MS);
    await applyTournamentRegistryPlan(asDatabase(database), before);
    const after = await planTournamentRegistry(asDatabase(database), UID, LATER_MS);

    expect(after.foreignDigest.digest).toBe(before.foreignDigest.digest);
  });
});

describe('progress reporting and bounded operations', () => {
  it('emits a progress event for every plan stage and every written child', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100'), makeRecord('s2', '200')]);

    const planEvents: RegistryProgressEvent[] = [];
    const plan = await planTournamentRegistry(asDatabase(database), UID, NOW_MS, {
      onProgress: (event) => planEvents.push(event),
    });
    expect(planEvents.map((event) => event.stage)).toEqual([
      'read-source',
      'derive',
      'read-entries',
      'diff',
    ]);
    expect(planEvents.at(-1)!.counts).toMatchObject({ derivedRows: 2, plannedWrites: 2 });

    const applyEvents: RegistryProgressEvent[] = [];
    await applyTournamentRegistryPlan(asDatabase(database), plan, {
      onProgress: (event) => applyEvents.push(event),
    });
    expect(applyEvents.map((event) => event.unit)).toEqual(['histimport:100', 'histimport:200']);
    expect(applyEvents.every((event) => event.stage === 'write')).toBe(true);
    expect(applyEvents.at(-1)!.counts.written).toBe(1);
  });

  it('emits a remove event per orphan deletion', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100'), makeRecord('s2', '999')]);
    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);
    await asDatabase(database).ref(`researchSource/${UID}/sets/s2`).remove();

    const plan = await planTournamentRegistry(asDatabase(database), UID, LATER_MS);
    const events: RegistryProgressEvent[] = [];
    await applyTournamentRegistryPlan(asDatabase(database), plan, {
      onProgress: (event) => events.push(event),
    });
    expect(events.filter((event) => event.stage === 'remove').map((event) => event.unit)).toEqual([
      'histimport:999',
    ]);
  });

  it('bounds a hung read by --request-timeout-ms instead of hanging forever', async () => {
    const hanging = {
      ref: () => ({ get: () => new Promise(() => undefined) }),
    } as unknown as Database;
    await expect(
      planTournamentRegistry(hanging, UID, NOW_MS, { requestTimeoutMs: 40 }),
    ).rejects.toThrow(/exceeded its 40ms request timeout/);
  });

  it('bounds a hung write transaction the same way', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    const plan = await planTournamentRegistry(asDatabase(database), UID, NOW_MS);
    const hangingWrites = {
      ref: () => ({ transaction: () => new Promise(() => undefined) }),
    } as unknown as Database;
    await expect(
      applyTournamentRegistryPlan(hangingWrites, plan, { requestTimeoutMs: 40 }),
    ).rejects.toThrow(/exceeded its 40ms request timeout/);
  });

  it('stops issuing writes once the shutdown signal aborts', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    const plan = await planTournamentRegistry(asDatabase(database), UID, NOW_MS);
    const controller = new AbortController();
    controller.abort(new Error('terminated by SIGINT'));

    await expect(
      applyTournamentRegistryPlan(asDatabase(database), plan, { signal: controller.signal }),
    ).rejects.toThrow(/terminated by SIGINT/);
    expect(entriesDump(database)[UID]).toBeUndefined();
  });
});

describe('per-event override carry-forward (39.2 F1)', () => {
  const TIER_OVERRIDE = { contractVersion: 1, tier: 'major', setAtMs: 1 };
  const RULESET_OVERRIDE = { contractVersion: 1, dsr: 'standard' as const };

  function storedRow(database: FakeDatabase, entryId: string): Record<string, unknown> {
    const entries = entriesDump(database)[UID] as Record<string, Record<string, unknown>>;
    const row = entries[entryId];
    if (row === undefined) {
      throw new Error(`No stored row for ${entryId}`);
    }
    return row;
  }

  /** The user's PATCH: adds the override members to the stored child, nothing else. */
  function setOverrides(database: FakeDatabase, entryId: string): void {
    database.seed(`tournamentEntries/${UID}/${entryId}`, {
      ...storedRow(database, entryId),
      tierOverride: TIER_OVERRIDE,
      rulesetOverride: RULESET_OVERRIDE,
    });
  }

  function withPlacement(placement: number): ResearchSourceSetRecord {
    return makeRecord('s1', '100', {
      lastObservedAtMs: 1_754_500_000_000,
      entrants: [{ entrantId: 'e-subject', name: 'Subject', seedNum: 5, placement }],
    });
  }

  it('store -> reconcile -> assert: both overrides survive a content-changing refresh', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);
    setOverrides(database, 'histimport:100');

    seedSources(database, [withPlacement(1)]);
    const second = await projectTournamentRegistry(asDatabase(database), UID, LATER_MS);

    expect(second.plan.updates).toEqual(['histimport:100']);
    expect(second.apply.written).toEqual(['histimport:100']);
    const row = storedRow(database, 'histimport:100');
    expect(row.placement).toBe(1);
    expect(row.tierOverride).toEqual(TIER_OVERRIDE);
    expect(row.rulesetOverride).toEqual(RULESET_OVERRIDE);
  });

  it('classifies an overridden row with no other change as unchanged, never a perpetual update', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);
    setOverrides(database, 'histimport:100');
    const before = structuredClone(database.dump());

    const second = await projectTournamentRegistry(asDatabase(database), UID, LATER_MS);

    expect(second.plan.unchanged).toEqual(['histimport:100']);
    expect(second.plan.updates).toEqual([]);
    expect(second.apply.writesPerformed).toBe(0);
    expect(database.dump()).toEqual(before);
  });

  it('keeps an override set between plan and apply (transaction replace branch)', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);

    // The plan sees NO override (none stored yet) and plans an update.
    seedSources(database, [withPlacement(2)]);
    const plan = await planTournamentRegistry(asDatabase(database), UID, LATER_MS);
    expect(plan.updates).toEqual(['histimport:100']);
    expect(plan.writes['histimport:100']).not.toHaveProperty('tierOverride');

    // The user sets both overrides after the plan was read.
    setOverrides(database, 'histimport:100');
    await applyTournamentRegistryPlan(asDatabase(database), plan);

    const row = storedRow(database, 'histimport:100');
    expect(row.placement).toBe(2);
    expect(row.tierOverride).toEqual(TIER_OVERRIDE);
    expect(row.rulesetOverride).toEqual(RULESET_OVERRIDE);
  });

  it('adds no override keys to a row that never had any', async () => {
    const database = new FakeDatabase();
    seedSources(database, [makeRecord('s1', '100')]);
    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);
    seedSources(database, [withPlacement(1)]);
    await projectTournamentRegistry(asDatabase(database), UID, LATER_MS);

    const row = storedRow(database, 'histimport:100');
    expect(row).not.toHaveProperty('tierOverride');
    expect(row).not.toHaveProperty('rulesetOverride');
  });

  it('carries the source isOnline to the resolver: false + entrants estimates, absent is settingUnknown', async () => {
    const database = new FakeDatabase();
    const offline = makeRecord('s1', '100');
    offline.event = { ...offline.event, isOnline: false, eventType: '1', numEntrants: 1581 };
    const unknownSetting = makeRecord('s2', '200');
    unknownSetting.event = { ...unknownSetting.event, numEntrants: 1581 };
    seedSources(database, [offline, unknownSetting]);

    await projectTournamentRegistry(asDatabase(database), UID, NOW_MS);

    const offlineRow = storedRow(database, 'histimport:100');
    expect(offlineRow.isOnline).toBe(false);
    expect(offlineRow.eventType).toBe('1');
    const resolved = resolveTournamentTier({
      entry: offlineRow as unknown as Parameters<typeof resolveTournamentTier>[0]['entry'],
    });
    expect(resolved.basis).toBe('estimated');
    expect(resolved.tier).toBe('supermajor');

    const unknownRow = storedRow(database, 'histimport:200');
    expect(unknownRow).not.toHaveProperty('isOnline');
    const unresolved = resolveTournamentTier({
      entry: unknownRow as unknown as Parameters<typeof resolveTournamentTier>[0]['entry'],
    });
    expect(unresolved.tier).toBe('unknown');
    expect(unresolved.reason).toBe('settingUnknown');
  });
});

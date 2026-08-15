import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import type { ResearchSourceSetRecord } from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import {
  applyTournamentRegistryPlan,
  planTournamentRegistry,
  projectTournamentRegistry,
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

import { describe, expect, it } from 'vitest';
import {
  clientMembershipSchema,
  clientTenantRecordSchema,
  clientVisibleVersionSchema,
  coachClientEntrySchema,
  matchRecordSchema,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../../src/test-support/fakeDatabase.js';
import { RtdbService } from '../../src/services/rtdb.js';
import { runSeedDemo } from './personalDataset.js';
import { runSeedCoaching } from './coachingDataset.js';
import { wipeDemo } from './manifest.js';

const UID = 'test-uid';
const NOW = Date.UTC(2026, 6, 23, 12, 0, 0);
const WEB_BASE_URL = 'https://grandfinals.gg';

interface Dump {
  users?: Record<string, { coachingModeEnabled?: boolean }>;
  coachClients?: Record<string, Record<string, unknown>>;
  clientTenants?: Record<string, unknown>;
  clientMembers?: Record<string, Record<string, unknown>>;
  matches?: Record<string, Record<string, Record<string, unknown>>>;
  primaryFighters?: Record<string, number[]>;
  reviewDrafts?: Record<string, Record<string, { coachPrivateNotes?: string | null }>>;
  reviewVersions?: Record<string, Record<string, Record<string, unknown>>>;
  reviewStatus?: Record<string, Record<string, { status: string; latestVersion: number | null }>>;
  reviewDeliveries?: Record<string, Record<string, Record<string, unknown>>>;
  shareTokens?: Record<string, unknown>;
  eventLedger?: unknown;
  outboxPending?: unknown;
  eventDedup?: unknown;
}

async function runFullSeed(
  database: FakeDatabase,
): Promise<{ deliveryUrl: string; token: string }> {
  await runSeedDemo(database as never, { uid: UID, now: NOW });
  return runSeedCoaching(database as never, {
    ownerUid: UID,
    now: NOW,
    webBaseUrl: WEB_BASE_URL,
  });
}

describe('runSeedCoaching', () => {
  it('writes zero canonical event-ledger entries across the FULL personal+coaching seed (SEED-06)', async () => {
    const database = new FakeDatabase();
    await runFullSeed(database);

    const dump = database.dump() as Dump;
    expect(dump.eventLedger).toBeUndefined();
    expect(dump.outboxPending).toBeUndefined();
    expect(dump.eventDedup).toBeUndefined();
  });

  it('enables coaching mode and provisions exactly one Pandemic client tenant (PAND-01)', async () => {
    const database = new FakeDatabase();
    await runFullSeed(database);

    const dump = database.dump() as Dump;
    expect(dump.users?.[UID]?.coachingModeEnabled).toBe(true);

    const coachClients = dump.coachClients?.[UID] ?? {};
    const tenantIds = Object.keys(coachClients);
    expect(tenantIds.length).toBe(1);
    const tenantId = tenantIds[0]!;

    expect(() => coachClientEntrySchema.parse(coachClients[tenantId])).not.toThrow();
    expect(() => clientTenantRecordSchema.parse(dump.clientTenants?.[tenantId])).not.toThrow();
    const membership = dump.clientMembers?.[tenantId]?.[UID];
    expect(() => clientMembershipSchema.parse(membership)).not.toThrow();
    expect((membership as { role?: string } | undefined)?.role).toBe('custodian');
  });

  it('seeds a Steve client library with >=15 matches and 5 annotated real-footage VODs (PAND-02/PAND-05)', async () => {
    const database = new FakeDatabase();
    await runFullSeed(database);

    const dump = database.dump() as Dump;
    const tenantId = Object.keys(dump.coachClients?.[UID] ?? {})[0]!;

    const matches = dump.matches?.[tenantId] ?? {};
    const matchList = Object.values(matches);
    expect(matchList.length).toBeGreaterThanOrEqual(15);

    for (const record of matchList) {
      expect(() => matchRecordSchema.parse(record)).not.toThrow();
    }

    const vodMatches = matchList.filter((m) => m.vodUrl !== undefined);
    expect(vodMatches.length).toBe(5);
    for (const match of vodMatches) {
      expect(match.tags).toBeDefined();
      const timestamps = match.vodTimestamps as Record<string, unknown> | undefined;
      expect(timestamps).toBeDefined();
      expect(Object.keys(timestamps ?? {}).length).toBeGreaterThanOrEqual(4);
    }

    expect(dump.primaryFighters?.[tenantId]).toEqual([82]);
  });

  it('authors and publishes a 6-section review with populated coachPrivateNotes as immutable v1 (PAND-03/PAND-04)', async () => {
    const database = new FakeDatabase();
    await runFullSeed(database);

    const dump = database.dump() as Dump;
    const tenantId = Object.keys(dump.coachClients?.[UID] ?? {})[0]!;

    const reviewIds = Object.keys(dump.reviewDrafts?.[tenantId] ?? {});
    expect(reviewIds.length).toBe(1);
    const reviewId = reviewIds[0]!;

    const draft = dump.reviewDrafts?.[tenantId]?.[reviewId];
    expect(draft?.coachPrivateNotes).toBeTruthy();
    expect(typeof draft?.coachPrivateNotes).toBe('string');
    expect((draft?.coachPrivateNotes as string).length).toBeGreaterThan(0);

    const sealed = dump.reviewVersions?.[tenantId]?.[reviewId]?.['1'];
    expect(() => clientVisibleVersionSchema.parse(sealed)).not.toThrow();
    const sections = (sealed as { sections: { hidden?: boolean; body: string }[] }).sections;
    expect(sections.length).toBe(6);
    for (const section of sections) {
      expect(section.hidden).toBeUndefined();
    }
    expect(JSON.stringify(sealed)).not.toMatch(/coachPrivateNotes/);

    const status = dump.reviewStatus?.[tenantId]?.[reviewId];
    expect(status).toEqual({ status: 'published', latestVersion: 1 });
  });

  it('mints a delivery whose anonymous read path resolves every distinct citation source (PAND-04 anonymous read)', async () => {
    const database = new FakeDatabase();
    const { token } = await runFullSeed(database);

    const dump = database.dump() as Dump;
    const shareTokenKeys = Object.keys(dump.shareTokens ?? {});
    expect(shareTokenKeys.length).toBe(1);
    expect(shareTokenKeys[0]).toBe(token);

    const rtdb = new RtdbService(database as never);
    const snapshot = await rtdb.getShareByToken(token);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.kind).toBe('coachReview');

    const citationSources = (snapshot as { citationSources?: { vodUrl: string }[] } | null)
      ?.citationSources;
    expect(citationSources).toBeDefined();
    expect((citationSources ?? []).length).toBeGreaterThanOrEqual(2);
    for (const source of citationSources ?? []) {
      expect(source.vodUrl).toBeTruthy();
    }
  });

  it('--wipe revokes the delivery token and restores coachingModeEnabled (revocation-equivalence)', async () => {
    const database = new FakeDatabase();
    const { token } = await runFullSeed(database);

    const dumpBefore = database.dump() as Dump;
    const tenantId = Object.keys(dumpBefore.coachClients?.[UID] ?? {})[0]!;

    await wipeDemo(database as never, UID);

    const dumpAfter = database.dump() as Dump;
    expect(dumpAfter.shareTokens?.[token]).toBeUndefined();

    const rtdb = new RtdbService(database as never);
    expect(await rtdb.getShareByToken(token)).toBeNull();

    expect(Object.keys(dumpAfter.coachClients?.[UID] ?? {})).toEqual([]);
    expect(dumpAfter.clientTenants?.[tenantId]).toBeUndefined();
    expect(dumpAfter.users?.[UID]?.coachingModeEnabled).toBeUndefined();
  });

  it('is idempotent: a second full run does not duplicate the tenant or client matches', async () => {
    const database = new FakeDatabase();
    await runFullSeed(database);
    const dumpAfterFirst = database.dump() as Dump;
    const tenantIdFirst = Object.keys(dumpAfterFirst.coachClients?.[UID] ?? {})[0]!;
    const matchCountFirst = Object.keys(dumpAfterFirst.matches?.[tenantIdFirst] ?? {}).length;

    await runFullSeed(database);
    const dumpAfterSecond = database.dump() as Dump;
    const tenantIdsSecond = Object.keys(dumpAfterSecond.coachClients?.[UID] ?? {});
    expect(tenantIdsSecond.length).toBe(1);
    const tenantIdSecond = tenantIdsSecond[0]!;
    const matchCountSecond = Object.keys(dumpAfterSecond.matches?.[tenantIdSecond] ?? {}).length;

    expect(matchCountSecond).toBe(matchCountFirst);
  });
});

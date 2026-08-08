import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import type { StartggResearchSet } from '../../startgg/client.js';
import * as identityModule from './identity.js';
import {
  confirmIdentityPlayers,
  confirmedPlayerIdSet,
  confirmedTagVariants,
  mineIdentityCandidates,
  readIdentityMapping,
  recordIdentityCandidates,
  resolveSeedIdentity,
  revokeConfirmedPlayer,
  selectPrimaryConfirmedPlayerId,
} from './identity.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

const TENANT_ID = 'tenant-1';
const ADMIN_UID = 'admin-1';

/**
 * Structural reminder (plan 30-04 Task 1): only `confirmIdentityPlayers` may
 * promote a candidate into `confirmedPlayerIds`. A future second writer must
 * be a deliberate, reviewed change to this list.
 */
const CONFIRMED_ID_WRITERS = ['confirmIdentityPlayers'];

describe('module structural contract', () => {
  it('has exactly one confirmed-id writer among its exports', () => {
    expect(CONFIRMED_ID_WRITERS).toHaveLength(1);
    expect(CONFIRMED_ID_WRITERS).toContain('confirmIdentityPlayers');
    // Every name in the list must actually be an exported function of this
    // module — guards against the list drifting from reality.
    for (const name of CONFIRMED_ID_WRITERS) {
      expect(typeof (identityModule as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

describe('readIdentityMapping', () => {
  it('returns an empty mapping for a tenant with no record, without throwing', async () => {
    const database = new FakeDatabase();
    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.confirmedPlayerIds).toBeUndefined();
    expect(mapping.candidates).toBeUndefined();
  });
});

describe('confirmedPlayerIdSet', () => {
  it('is empty on an empty mapping — the fail-closed default', () => {
    expect(confirmedPlayerIdSet({}).size).toBe(0);
  });
});

describe('confirmIdentityPlayers', () => {
  it('writes both players, each stamped with the confirming admin and timestamp', async () => {
    const database = new FakeDatabase();
    const result = await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p1' }, { playerId: 'p2' }],
      1000,
    );

    expect(result.confirmedPlayerIds.sort()).toEqual(['p1', 'p2']);
    expect(result.rejectedPlayerIds).toEqual([]);

    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.confirmedPlayerIds?.p1?.confirmedByUid).toBe(ADMIN_UID);
    expect(mapping.confirmedPlayerIds?.p1?.confirmedAtMs).toBe(1000);
    expect(mapping.confirmedPlayerIds?.p2?.confirmedAtMs).toBe(1000);
  });

  it('adds a third player on a second call and leaves the first two — including original timestamps — untouched', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p1' }, { playerId: 'p2' }],
      1000,
    );
    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p3' }],
      2000,
    );

    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(Object.keys(mapping.confirmedPlayerIds ?? {}).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(mapping.confirmedPlayerIds?.p1?.confirmedAtMs).toBe(1000);
    expect(mapping.confirmedPlayerIds?.p2?.confirmedAtMs).toBe(1000);
    expect(mapping.confirmedPlayerIds?.p3?.confirmedAtMs).toBe(2000);
  });

  it('promotes a candidate to confirmed, removing it from candidates in the same operation', async () => {
    const database = new FakeDatabase();
    await recordIdentityCandidates(asDatabase(database), TENANT_ID, [{ playerId: 'p9' }], 500);

    let mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.candidates?.p9).toBeDefined();

    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p9' }],
      1000,
    );

    mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.confirmedPlayerIds?.p9).toBeDefined();
    expect(mapping.candidates?.p9).toBeUndefined();
  });

  it('is a no-op for an already-confirmed id — original confirmedAt preserved, same response shape', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p1' }],
      1000,
    );
    const second = await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p1' }],
      2000,
    );

    expect(second.confirmedPlayerIds).toEqual(['p1']);
    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.confirmedPlayerIds?.p1?.confirmedAtMs).toBe(1000);
  });

  it('rejects an RTDB-illegal player id, confirms the remaining valid ones, never throws, never writes the bad key', async () => {
    const database = new FakeDatabase();
    const result = await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p1' }, { playerId: 'bad.id' }],
      1000,
    );

    expect(result.confirmedPlayerIds).toEqual(['p1']);
    expect(result.rejectedPlayerIds).toEqual(['bad.id']);

    const dump = database.dump() as Record<string, unknown>;
    const mapping = (dump.researchIdentity as Record<string, unknown>)?.[TENANT_ID] as
      { confirmedPlayerIds?: Record<string, unknown> } | undefined;
    expect(mapping?.confirmedPlayerIds?.['bad.id']).toBeUndefined();
  });

  it('leaves the record unchanged for an empty player list', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p1' }],
      1000,
    );
    const before = database.dump();

    await confirmIdentityPlayers(asDatabase(database), TENANT_ID, ADMIN_UID, [], 2000);

    expect(database.dump()).toEqual(before);
  });

  it('demotes the previously primary player when a second is marked primary — exactly one primary flag remains', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p1', primary: true }, { playerId: 'p2' }],
      1000,
    );
    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p2', primary: true }],
      2000,
    );

    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    const primaryCount = Object.values(mapping.confirmedPlayerIds ?? {}).filter(
      (entry) => entry.primary === true,
    ).length;
    expect(primaryCount).toBe(1);
    expect(mapping.confirmedPlayerIds?.p2?.primary).toBe(true);
    expect(mapping.confirmedPlayerIds?.p1?.primary).toBeUndefined();
  });

  it('keeps only the LAST of two primary:true inputs in one call, deterministically', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [
        { playerId: 'p1', primary: true },
        { playerId: 'p2', primary: true },
      ],
      1000,
    );

    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.confirmedPlayerIds?.p2?.primary).toBe(true);
    expect(mapping.confirmedPlayerIds?.p1?.primary).toBeUndefined();
  });
});

describe('selectPrimaryConfirmedPlayerId', () => {
  it('returns the flagged id when one exists', () => {
    const mapping = {
      confirmedPlayerIds: {
        p1: { playerId: 'p1', confirmedByUid: ADMIN_UID, confirmedAtMs: 1 },
        p2: { playerId: 'p2', confirmedByUid: ADMIN_UID, confirmedAtMs: 1, primary: true },
      },
    };
    expect(selectPrimaryConfirmedPlayerId(mapping)).toBe('p2');
  });

  it('falls back to the lexicographically smallest id with no flagged id and three confirmed players', () => {
    const mapping = {
      confirmedPlayerIds: {
        zeta: { playerId: 'zeta', confirmedByUid: ADMIN_UID, confirmedAtMs: 1 },
        alpha: { playerId: 'alpha', confirmedByUid: ADMIN_UID, confirmedAtMs: 1 },
        mid: { playerId: 'mid', confirmedByUid: ADMIN_UID, confirmedAtMs: 1 },
      },
    };
    expect(selectPrimaryConfirmedPlayerId(mapping)).toBe('alpha');
  });

  it('returns null for an empty mapping', () => {
    expect(selectPrimaryConfirmedPlayerId({})).toBeNull();
  });
});

describe('recordIdentityCandidates', () => {
  it('writes a new candidate with firstObservedAtMs equal to lastObservedAtMs and observationCount 1', async () => {
    const database = new FakeDatabase();
    await recordIdentityCandidates(asDatabase(database), TENANT_ID, [{ playerId: 'c1' }], 1000);

    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.candidates?.c1?.firstObservedAtMs).toBe(1000);
    expect(mapping.candidates?.c1?.lastObservedAtMs).toBe(1000);
    expect(mapping.candidates?.c1?.observationCount).toBe(1);
  });

  it('preserves firstObservedAtMs, advances lastObservedAtMs, and increments observationCount for a repeat candidate', async () => {
    const database = new FakeDatabase();
    await recordIdentityCandidates(asDatabase(database), TENANT_ID, [{ playerId: 'c1' }], 1000);
    await recordIdentityCandidates(asDatabase(database), TENANT_ID, [{ playerId: 'c1' }], 2000);

    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.candidates?.c1?.firstObservedAtMs).toBe(1000);
    expect(mapping.candidates?.c1?.lastObservedAtMs).toBe(2000);
    expect(mapping.candidates?.c1?.observationCount).toBe(2);
  });

  it('writes nothing for a player id that is already confirmed', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'c1' }],
      1000,
    );

    const result = await recordIdentityCandidates(
      asDatabase(database),
      TENANT_ID,
      [{ playerId: 'c1' }],
      2000,
    );

    expect(result.skippedConfirmed).toBe(1);
    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.candidates?.c1).toBeUndefined();
  });
});

describe('mineIdentityCandidates', () => {
  function makeSet(overrides: Partial<StartggResearchSet> = {}): StartggResearchSet {
    return {
      id: 1,
      slots: [
        {
          entrant: {
            id: 10,
            name: 'Sponsor | Rival',
            participants: [{ player: { id: 55, gamerTag: 'Sponsor | Rival' }, user: null }],
          },
        },
      ],
      ...overrides,
    } as StartggResearchSet;
  }

  it('returns an empty list when the mapping has no tag variants', () => {
    expect(mineIdentityCandidates([makeSet()], {})).toEqual([]);
  });

  it('returns candidates only for participants whose normalized gamertag matches a known variant and whose player id is not already confirmed', () => {
    const mapping = {
      confirmedPlayerIds: {
        p1: {
          playerId: 'p1',
          confirmedByUid: ADMIN_UID,
          confirmedAtMs: 1,
          knownTagVariants: ['rival'],
        },
      },
    };
    const candidates = mineIdentityCandidates([makeSet()], mapping);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ playerId: '55', gamerTag: 'Sponsor | Rival' });
  });

  it('excludes a participant whose player id is already confirmed', () => {
    const mapping = {
      confirmedPlayerIds: {
        '55': {
          playerId: '55',
          confirmedByUid: ADMIN_UID,
          confirmedAtMs: 1,
          knownTagVariants: ['rival'],
        },
      },
    };
    expect(mineIdentityCandidates([makeSet()], mapping)).toEqual([]);
  });
});

describe('revokeConfirmedPlayer', () => {
  it('removes one confirmed id and leaves the others and all candidates intact', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(
      asDatabase(database),
      TENANT_ID,
      ADMIN_UID,
      [{ playerId: 'p1' }, { playerId: 'p2' }],
      1000,
    );
    await recordIdentityCandidates(asDatabase(database), TENANT_ID, [{ playerId: 'c1' }], 1000);

    await revokeConfirmedPlayer(asDatabase(database), TENANT_ID, 'p1');

    const mapping = await readIdentityMapping(asDatabase(database), TENANT_ID);
    expect(mapping.confirmedPlayerIds?.p1).toBeUndefined();
    expect(mapping.confirmedPlayerIds?.p2).toBeDefined();
    expect(mapping.candidates?.c1).toBeDefined();
  });
});

describe('confirmedTagVariants', () => {
  it('normalizes stored gamerTag and knownTagVariants for mining comparison only', () => {
    const mapping = {
      confirmedPlayerIds: {
        p1: {
          playerId: 'p1',
          confirmedByUid: ADMIN_UID,
          confirmedAtMs: 1,
          gamerTag: 'Sponsor | Hero',
          knownTagVariants: ['OtherSponsor | Hero', 'HeroAlt'],
        },
      },
    };
    const variants = confirmedTagVariants(mapping);
    expect(variants.has('hero')).toBe(true);
    expect(variants.has('heroalt')).toBe(true);
  });
});

describe('resolveSeedIdentity', () => {
  it('resolves via slug and coerces the numeric player id to a string', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: { user: { id: 1, slug: 'user/abc', player: { id: 42, gamerTag: 'Hero' } } },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const resolved = await resolveSeedIdentity('token', { slug: 'user/abc' }, fetchImpl);
    expect(resolved).toEqual({ playerId: '42', gamerTag: 'Hero', userSlug: 'user/abc' });
  });

  it('returns null when neither slug nor playerId is given', async () => {
    const resolved = await resolveSeedIdentity('token', {});
    expect(resolved).toBeNull();
  });
});

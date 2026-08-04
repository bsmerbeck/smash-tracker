import { describe, expect, it } from 'vitest';
import type { Database } from 'firebase-admin/database';
import { PREP_LIKELY_OPPONENTS_MAX, type ScoutBinding } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { ConflictError, NotFoundError } from '../services/rtdb.js';
import {
  activatePrepBrief,
  clearPrepScoutBinding,
  prepBriefPath,
  readPrepBrief,
  reopenPrepBrief,
  setPrepChecklistItem,
  setPrepLikelyOpponent,
  setPrepScoutBinding,
} from './prep.js';

/**
 * Owner-required test coverage (26-CONTEXT.md "Persistence & checklist
 * shape", tests 1-4; test 5 is `importGraph.test.ts`). Exercises the
 * service functions DIRECTLY against a `FakeDatabase` — no HTTP layer;
 * route-level coverage belongs to Plan 05.
 */

const TEST_UID = 'test-uid-123';
const ENTRY_KEY = 'manual-locals-42-ab12cd34';
const SESSION_ID = 'session-1';
const EVENT_DATE = 1_700_000_000_000;

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

/** Walks every `eventLedger/{day}/{pushKey}` envelope currently in the fake tree. */
function allLedgerEnvelopes(database: FakeDatabase): Array<Record<string, unknown>> {
  const tree = database.dump() as Record<string, unknown>;
  const ledgerByDay = (tree.eventLedger ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(ledgerByDay).flatMap(
    (day) => Object.values(day) as Record<string, unknown>[],
  );
}

/** Counts ledger envelopes matching an exact `eventName` — the concurrency and dedup assertions need exact counts, not "at least one". */
function countEnvelopesByName(database: FakeDatabase, eventName: string): number {
  return allLedgerEnvelopes(database).filter(
    (envelope) => (envelope as { eventName?: string }).eventName === eventName,
  ).length;
}

/** Reads the raw stored `prepBriefs/{uid}/{entryKey}` node straight out of `FakeDatabase.dump()` (bypasses the normalize-on-read helper deliberately). */
function dumpBriefRecord(
  database: FakeDatabase,
  uid: string,
  entryKey: string,
): Record<string, unknown> | undefined {
  const tree = database.dump() as Record<string, unknown>;
  const byUid = (tree.prepBriefs ?? {}) as Record<string, Record<string, unknown>>;
  return byUid[uid]?.[entryKey] as Record<string, unknown> | undefined;
}

describe('activatePrepBrief — create-once under retry and concurrency (owner test 1)', () => {
  it('sequential replay: first call is justActivated true, second is false, and eventDate stays the FIRST snapshot', async () => {
    const database = new FakeDatabase();

    const first = await activatePrepBrief(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      EVENT_DATE,
      SESSION_ID,
    );
    expect(first.justActivated).toBe(true);
    expect(first.brief.eventDate).toBe(EVENT_DATE);

    // A replay with a DIFFERENT eventDate must never rewrite the immutable snapshot.
    const second = await activatePrepBrief(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      EVENT_DATE + 999_999,
      SESSION_ID,
    );
    expect(second.justActivated).toBe(false);
    expect(second.brief.eventDate).toBe(EVENT_DATE);

    expect(countEnvelopesByName(database, 'prep_brief_activated')).toBe(1);
  });

  it('a Promise.all of two concurrent activate calls yields exactly one committed true and exactly one ledger row', async () => {
    const database = new FakeDatabase();

    const [a, b] = await Promise.all([
      activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID),
      activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID),
    ]);

    const justActivatedCount = [a.justActivated, b.justActivated].filter(Boolean).length;
    expect(justActivatedCount).toBe(1);
    expect(countEnvelopesByName(database, 'prep_brief_activated')).toBe(1);
  });
});

describe('reopenPrepBrief — preserves state and deduplicates transport retries (owner test 2)', () => {
  it('two calls with the SAME openId produce exactly one prep_brief_reopened row; checklist state is byte-identical after', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);
    await setPrepChecklistItem(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      'confirmRegistration',
      true,
    );

    const openId = 'open-id-1';
    const first = await reopenPrepBrief(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      openId,
      SESSION_ID,
    );
    const second = await reopenPrepBrief(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      openId,
      SESSION_ID,
    );

    expect(countEnvelopesByName(database, 'prep_brief_reopened')).toBe(1);
    expect(first.checklist).toEqual({ confirmRegistration: true });
    expect(second.checklist).toEqual({ confirmRegistration: true });
  });

  it('a DIFFERENT openId after two same-openId calls produces a second prep_brief_reopened row', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);

    await reopenPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, 'open-id-1', SESSION_ID);
    await reopenPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, 'open-id-1', SESSION_ID);
    expect(countEnvelopesByName(database, 'prep_brief_reopened')).toBe(1);

    await reopenPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, 'open-id-2', SESSION_ID);
    expect(countEnvelopesByName(database, 'prep_brief_reopened')).toBe(2);
  });

  it('rejects with NotFoundError on a never-activated entryKey', async () => {
    const database = new FakeDatabase();

    await expect(
      reopenPrepBrief(
        asDatabase(database),
        TEST_UID,
        'never-activated-key',
        'open-id-1',
        SESSION_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('empty checklist and opponent selection round-trip cleanly (owner test 3)', () => {
  it('unchecking the last checklist item strips the stored node; readPrepBrief still resolves with checklist: {}', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);
    await setPrepChecklistItem(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      'confirmRegistration',
      true,
    );

    const beforeUncheck = dumpBriefRecord(database, TEST_UID, ENTRY_KEY);
    expect(beforeUncheck?.checklist).toEqual({ confirmRegistration: true });

    await setPrepChecklistItem(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      'confirmRegistration',
      false,
    );

    // FakeDatabase's leaf-only delete emulation may leave an empty `{}`
    // object behind rather than fully pruning the parent node the way real
    // RTDB does — either representation is a valid null-strip-tolerant
    // stored shape (`.nullish()` on `prepBriefRecordSchema` accepts absent,
    // explicit null, OR an empty record), so the meaningful assertion is
    // "holds no checked keys," not "the key is entirely absent."
    const afterUncheck = dumpBriefRecord(database, TEST_UID, ENTRY_KEY);
    expect(Object.keys((afterUncheck?.checklist ?? {}) as Record<string, unknown>)).toHaveLength(0);

    // The load-bearing assertion: the record stays READABLE (no throw) and
    // normalizes to checklist: {} regardless of which of those stored
    // shapes FakeDatabase actually produced.
    const brief = await readPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY);
    expect(brief?.checklist).toEqual({});
  });

  it('removing the last likely opponent strips the stored node; readPrepBrief still resolves with likelyOpponents: {}', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);
    await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', true);

    const beforeRemove = dumpBriefRecord(database, TEST_UID, ENTRY_KEY);
    expect(beforeRemove?.likelyOpponents).toEqual({ rival: true });

    await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', false);

    // Same FakeDatabase leaf-only-delete caveat as the checklist case above
    // — assert "holds no selections," not "the key is entirely absent."
    const afterRemove = dumpBriefRecord(database, TEST_UID, ENTRY_KEY);
    expect(
      Object.keys((afterRemove?.likelyOpponents ?? {}) as Record<string, unknown>),
    ).toHaveLength(0);

    const brief = await readPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY);
    expect(brief?.likelyOpponents).toEqual({});
  });

  it('seeding a STRIPPED shape directly (no map keys at all) resolves rather than throwing', async () => {
    const database = new FakeDatabase();
    database.seed(prepBriefPath(TEST_UID, ENTRY_KEY), {
      eventDate: EVENT_DATE,
      activatedAt: EVENT_DATE,
      lastOpenedAt: EVENT_DATE,
    });

    const brief = await readPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY);
    expect(brief).toEqual({
      eventDate: EVENT_DATE,
      activatedAt: EVENT_DATE,
      lastOpenedAt: EVENT_DATE,
      checklist: {},
      likelyOpponents: {},
      scoutBindings: {},
      reviewChecklist: {},
    });
  });
});

describe('brief operations move no money (owner test 4)', () => {
  it('read/activate/reopen/checklist-toggle create no reportJobs, credit, or billing-family ledger rows', async () => {
    const database = new FakeDatabase();

    await readPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY);
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);
    await reopenPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, 'open-id-1', SESSION_ID);
    await setPrepChecklistItem(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      'confirmRegistration',
      true,
    );
    await readPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY);

    const tree = database.dump() as Record<string, unknown>;
    const rootKeys = Object.keys(tree);
    // The only top-level nodes the prep flows may create — a stronger,
    // more durable assertion than greping individual billing paths,
    // because it also catches an unexpected new tree.
    const allowedRootKeys = new Set(['prepBriefs', 'eventLedger', 'outboxPending', 'eventDedup']);
    for (const key of rootKeys) {
      expect(allowedRootKeys.has(key)).toBe(true);
    }
    expect(rootKeys).not.toContain('reportJobs');

    const billingFamilyEnvelopes = allLedgerEnvelopes(database).filter((envelope) => {
      const name = (envelope as { eventName?: string }).eventName ?? '';
      return /credit|billing|refund|checkout|report/i.test(name);
    });
    expect(billingFamilyEnvelopes).toHaveLength(0);
  });
});

describe('setPrepLikelyOpponent — PREP_LIKELY_OPPONENTS_MAX enforcement', () => {
  it('rejects with ConflictError when the curated map is already at the cap and a NEW name is added', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);

    for (let i = 0; i < PREP_LIKELY_OPPONENTS_MAX; i += 1) {
      await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, `opponent-${i}`, true);
    }

    await expect(
      setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, 'one-too-many', true),
    ).rejects.toThrow(ConflictError);
  });

  it('re-adding a name ALREADY in the map at the cap succeeds (idempotent re-add)', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);

    for (let i = 0; i < PREP_LIKELY_OPPONENTS_MAX; i += 1) {
      await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, `opponent-${i}`, true);
    }

    const brief = await setPrepLikelyOpponent(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      'opponent-0',
      true,
    );
    expect(Object.keys(brief.likelyOpponents)).toHaveLength(PREP_LIKELY_OPPONENTS_MAX);
  });
});

/**
 * Phase 27 (RPT-01/RPT-02, 27-06): the scoutBinding storage contract.
 * Bindings are always constructed here as ALREADY-resolved ScoutBinding
 * values — this test file never performs a provider lookup, matching the
 * module's own contract that `setPrepScoutBinding` trusts its caller for
 * resolution.
 */
const STARTGG_BINDING: ScoutBinding = {
  provider: 'startgg',
  startggPlayerId: 1802316,
  startggUserSlug: 'user/07dc2239',
  displayTag: 'Pandem1c',
  method: 'matchHistory',
  confirmedAt: 1_700_000_500_000,
};

describe('setPrepScoutBinding / clearPrepScoutBinding — scoutBinding storage (27-06)', () => {
  it('writes a binding for a curated opponent, and a subsequent readPrepBrief returns it normalized', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);
    await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', true);

    await setPrepScoutBinding(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', STARTGG_BINDING);

    const brief = await readPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY);
    expect(brief?.scoutBindings.rival).toEqual(STARTGG_BINDING);
  });

  it('rejects with ConflictError and writes nothing when the name is NOT currently curated', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);

    await expect(
      setPrepScoutBinding(
        asDatabase(database),
        TEST_UID,
        ENTRY_KEY,
        'never-curated',
        STARTGG_BINDING,
      ),
    ).rejects.toThrow(ConflictError);

    const brief = await readPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY);
    expect(brief?.scoutBindings).toEqual({});
  });

  it('stores an object with absent identity keys — never an explicit undefined-valued key — when optional identity fields are undefined', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);
    await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', true);

    const parryBinding: ScoutBinding = {
      provider: 'parrygg',
      parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
      displayTag: 'Pandem1c',
      method: 'profileInput',
      confirmedAt: 1_700_000_600_000,
    };

    await setPrepScoutBinding(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', parryBinding);

    const stored = dumpBriefRecord(database, TEST_UID, ENTRY_KEY);
    const scoutBindings = (stored?.scoutBindings ?? {}) as Record<string, Record<string, unknown>>;
    const storedRival = scoutBindings.rival ?? {};
    expect(Object.keys(storedRival)).not.toContain('startggPlayerId');
    expect(Object.keys(storedRival)).not.toContain('startggUserSlug');
    expect('startggPlayerId' in storedRival).toBe(false);
  });

  it('clears a binding by removing the key; clearing the last binding leaves the map reading back empty', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);
    await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', true);
    await setPrepScoutBinding(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', STARTGG_BINDING);

    await clearPrepScoutBinding(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival');

    const brief = await readPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY);
    expect(brief?.scoutBindings).toEqual({});
  });

  it('un-curating a likely opponent removes BOTH its presence-map entry and its binding in a single write', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);
    await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', true);
    await setPrepScoutBinding(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', STARTGG_BINDING);

    const afterUncurate = await setPrepLikelyOpponent(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      'rival',
      false,
    );

    expect(afterUncurate.likelyOpponents).not.toHaveProperty('rival');
    expect(afterUncurate.scoutBindings).not.toHaveProperty('rival');
  });

  it('re-curating that same opponent afterwards yields NO binding (no stale identity inherited)', async () => {
    const database = new FakeDatabase();
    await activatePrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY, EVENT_DATE, SESSION_ID);
    await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', true);
    await setPrepScoutBinding(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', STARTGG_BINDING);
    await setPrepLikelyOpponent(asDatabase(database), TEST_UID, ENTRY_KEY, 'rival', false);

    const reCurated = await setPrepLikelyOpponent(
      asDatabase(database),
      TEST_UID,
      ENTRY_KEY,
      'rival',
      true,
    );

    expect(reCurated.likelyOpponents).toHaveProperty('rival');
    expect(reCurated.scoutBindings).not.toHaveProperty('rival');
  });

  it('a brief with no scoutBindings node at all (Phase 26 brief) reads back with an empty bindings map', async () => {
    const database = new FakeDatabase();
    database.seed(prepBriefPath(TEST_UID, ENTRY_KEY), {
      eventDate: EVENT_DATE,
      activatedAt: EVENT_DATE,
      lastOpenedAt: EVENT_DATE,
      likelyOpponents: { rival: true },
    });

    const brief = await readPrepBrief(asDatabase(database), TEST_UID, ENTRY_KEY);
    expect(brief?.scoutBindings).toEqual({});
  });
});

import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import type { ResearchCoverageSnapshot } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { composeCoverageResponse } from './coverageResponse.js';

/**
 * Phase 30.1 Plan 05 (WKSP-01A): composer-level self-scoping proof for
 * `composeCoverageResponse` — the function `GET /api/users/me/coverage`
 * calls with `request.uid` as its ONLY subject argument. The HTTP-layer
 * self-only boundary (401 unauthenticated, authenticated read resolves
 * request.uid, cross-uid coverage never returned — T-30.1-12/C3-L1) is
 * proven separately in `routes/users.test.ts`; this file proves the
 * composer itself reads only the passed subjectId's trees.
 */
function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function makeSnapshot(playerId: string, asOfMs = 1_000): ResearchCoverageSnapshot {
  return {
    asOfMs,
    players: {
      [playerId]: {
        playerId,
        runId: 'run-1',
        runCompletedAtMs: asOfMs,
        asOfMs,
        counters: {},
        namedGaps: {},
        dateCoverage: {},
        classificationCounts: {},
        uniqueCounters: {},
        uniqueNamedGaps: {},
        uniqueClassificationCounts: {},
      },
    },
    totals: {
      counters: {},
      namedGaps: {},
      dateCoverage: {},
      classificationCounts: {},
    },
  };
}

const SELF_UID = 'self-uid-1';
const OTHER_UID = 'other-uid-2';
const PLAYER_ID = 'player-self';

describe('composeCoverageResponse (self-scoped subject reads)', () => {
  it('returns the snapshot + confirmed player ids for a subject with migrated research data', async () => {
    const database = new FakeDatabase();
    database.seed(`researchCoverage/${SELF_UID}`, makeSnapshot(PLAYER_ID));
    database.seed(`researchIdentity/${SELF_UID}`, {
      confirmedPlayerIds: {
        [PLAYER_ID]: {
          playerId: PLAYER_ID,
          primary: true,
          confirmedByUid: SELF_UID,
          confirmedAtMs: 1_000,
        },
      },
    });

    const result = await composeCoverageResponse(asDatabase(database), SELF_UID);

    expect(result.coverage).not.toBeNull();
    expect(result.confirmedPlayerIds).toEqual([PLAYER_ID]);
    expect(result.confirmedPlayerIdCount).toBe(1);
  });

  it('returns the benign empty shape for a subject with no research trees at all', async () => {
    const database = new FakeDatabase();

    const result = await composeCoverageResponse(asDatabase(database), SELF_UID);

    expect(result).toEqual({
      coverage: null,
      confirmedPlayerIds: [],
      confirmedPlayerIdCount: 0,
      unresolvedCandidateCount: 0,
    });
  });

  it('reads ONLY the passed subjectId trees — a second subject id seeded with its own coverage is never included', async () => {
    const database = new FakeDatabase();
    database.seed(`researchCoverage/${SELF_UID}`, makeSnapshot(PLAYER_ID));
    database.seed(`researchIdentity/${SELF_UID}`, {
      confirmedPlayerIds: {
        [PLAYER_ID]: {
          playerId: PLAYER_ID,
          primary: true,
          confirmedByUid: SELF_UID,
          confirmedAtMs: 1_000,
        },
      },
    });
    database.seed(`researchCoverage/${OTHER_UID}`, makeSnapshot('player-other'));
    database.seed(`researchIdentity/${OTHER_UID}`, {
      confirmedPlayerIds: {
        'player-other': {
          playerId: 'player-other',
          primary: true,
          confirmedByUid: OTHER_UID,
          confirmedAtMs: 2_000,
        },
      },
    });

    const result = await composeCoverageResponse(asDatabase(database), SELF_UID);

    expect(result.confirmedPlayerIds).toEqual([PLAYER_ID]);
    expect(JSON.stringify(result)).not.toContain('player-other');
    expect(JSON.stringify(result)).not.toContain(OTHER_UID);
  });
});

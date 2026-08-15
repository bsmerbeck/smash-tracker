import { describe, expect, it } from 'vitest';
import type { ResearchSourceSetRecord } from '@smash-tracker/shared';
import { tournamentEntrySchema } from '@smash-tracker/shared';
import { deriveTournamentRegistryFromResearchSource } from './derive.js';

const IMPORTED_AT_MS = 1_755_000_000_000;

/** Minimal valid stored source record; overrides layer event/entrant detail on top. */
function makeRecord(overrides: Partial<ResearchSourceSetRecord> = {}): ResearchSourceSetRecord {
  return {
    providerSetId: 'set-1',
    classification: 'complete',
    ruleId: 'R-COMPLETE',
    apiIds: { setId: 'set-1' },
    ingestionRunId: 'run-1',
    fetchedAtMs: 1_754_000_000_000,
    lastObservedAtMs: 1_754_000_000_000,
    ...overrides,
  };
}

function makeEventRecord(
  providerSetId: string,
  eventId: string,
  overrides: Partial<ResearchSourceSetRecord> = {},
): ResearchSourceSetRecord {
  return makeRecord({
    providerSetId,
    apiIds: { setId: providerSetId, eventId },
    completedAt: 1_700_000_000,
    event: {
      eventId,
      name: 'Ultimate Singles',
      slug: `tournament/major-${eventId}/event/ultimate-singles`,
      numEntrants: 512,
      tournamentName: `Major ${eventId}`,
      tournamentSlug: `tournament/major-${eventId}`,
    },
    subjectEntrantId: 'e-subject',
    opponentEntrantId: 'e-opp',
    entrants: [
      { entrantId: 'e-subject', name: 'Subject', seedNum: 3, placement: 2 },
      { entrantId: 'e-opp', name: 'Opponent', seedNum: 10, placement: 5 },
    ],
    ...overrides,
  });
}

describe('deriveTournamentRegistryFromResearchSource', () => {
  it('groups sets by stable start.gg event id and derives one row per event', () => {
    const { rows } = deriveTournamentRegistryFromResearchSource(
      [
        makeEventRecord('s1', '100'),
        makeEventRecord('s2', '100', { completedAt: 1_700_100_000 }),
        makeEventRecord('s3', '200'),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );

    expect(rows.map((row) => row.entryId)).toEqual(['histimport:100', 'histimport:200']);
    const [first] = rows;
    expect(first).toMatchObject({
      origin: 'admin-imported',
      provider: 'startgg',
      startggEventId: '100',
      tournamentName: 'Major 100',
      eventName: 'Ultimate Singles',
      tournamentSlug: 'tournament/major-100',
      eventSlug: 'tournament/major-100/event/ultimate-singles',
      numEntrants: 512,
      seed: 3,
      placement: 2,
      playedSetCount: 2,
      registryWitness: 'research-import:v1:100',
      provenance: { source: 'research-import', importedAtMs: IMPORTED_AT_MS },
    });
    // Legacy compatibility members mirror the played-set facts exactly.
    expect(first).toMatchObject({
      firstSetAt: 1_700_000_000_000,
      lastSetAt: 1_700_100_000_000,
      setsPlayed: 2,
      slug: 'tournament/major-100',
      startAtMs: 1_700_000_000_000,
      endAtMs: 1_700_100_000_000,
    });
  });

  it('falls back to apiIds.eventId when the event object is absent, and skips sets with no event id at all', () => {
    const result = deriveTournamentRegistryFromResearchSource(
      [
        makeRecord({ providerSetId: 's1', apiIds: { setId: 's1', eventId: '300' } }),
        makeRecord({ providerSetId: 's2', apiIds: { setId: 's2' } }),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );

    expect(result.rows.map((row) => row.entryId)).toEqual(['histimport:300']);
    expect(result.rows[0]?.eventName).toBe('start.gg event 300');
    expect(result.skippedNoEventId).toBe(1);
  });

  it('derives eventName from the event slug before the numbered fallback', () => {
    const { rows } = deriveTournamentRegistryFromResearchSource(
      [
        makeRecord({
          providerSetId: 's1',
          apiIds: { setId: 's1', eventId: '400' },
          event: { eventId: '400', slug: 'tournament/weekly/event/singles' },
        }),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );
    expect(rows[0]?.eventName).toBe('tournament/weekly/event/singles');
  });

  it('excludes DQ/bye/walkover from playedSetCount and marks retained DQs explicitly via dqCount', () => {
    const { rows } = deriveTournamentRegistryFromResearchSource(
      [
        makeEventRecord('s1', '100'),
        makeEventRecord('s2', '100', { classification: 'dq', ruleId: 'R-DQ-FLAG' }),
        makeEventRecord('s3', '100', { classification: 'bye', ruleId: 'R-BYE' }),
        makeEventRecord('s4', '100', { classification: 'walkover', ruleId: 'R-WALKOVER-EXPLICIT' }),
        makeEventRecord('s5', '100', { classification: 'no-game', ruleId: 'R-NO-GAME' }),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ playedSetCount: 1, setsPlayed: 1, dqCount: 1 });
  });

  it('counts no-game-detail sets as played (provider-reported played set with no game rows)', () => {
    const { rows } = deriveTournamentRegistryFromResearchSource(
      [
        makeEventRecord('s1', '100'),
        makeEventRecord('s2', '100', {
          classification: 'no-game-detail',
          ruleId: 'R-NO-GAME-DETAIL',
          completedAt: 1_700_200_000,
        }),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );
    expect(rows[0]).toMatchObject({ playedSetCount: 2, endAtMs: 1_700_200_000_000 });
  });

  it('omits dqCount entirely when the event retained no DQ sets', () => {
    const { rows } = deriveTournamentRegistryFromResearchSource([makeEventRecord('s1', '100')], {
      importedAtMs: IMPORTED_AT_MS,
    });
    expect('dqCount' in rows[0]!).toBe(false);
  });

  it('excludes non-ssbu, non-singles, and unresolved sets outright', () => {
    const result = deriveTournamentRegistryFromResearchSource(
      [
        makeEventRecord('s1', '100', { classification: 'non-ssbu', ruleId: 'R-NON-SSBU' }),
        makeEventRecord('s2', '100', { classification: 'non-singles', ruleId: 'R-NON-SINGLES' }),
        makeEventRecord('s3', '100', {
          classification: 'unresolved',
          ruleId: 'R-SUBJECT-NOT-FOUND',
        }),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );
    expect(result.rows).toEqual([]);
    expect(result.skippedExcludedClassification).toBe(3);
  });

  it('never widens the played-set date range from a DQ set, and leaves it absent when no played set has a timestamp', () => {
    const withLateDq = deriveTournamentRegistryFromResearchSource(
      [
        makeEventRecord('s1', '100', { completedAt: 1_700_000_000 }),
        makeEventRecord('s2', '100', {
          classification: 'dq',
          ruleId: 'R-DQ-FLAG',
          completedAt: 1_700_999_999,
        }),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );
    expect(withLateDq.rows[0]).toMatchObject({
      startAtMs: 1_700_000_000_000,
      endAtMs: 1_700_000_000_000,
      lastSetAt: 1_700_000_000_000,
    });

    const noTimestamps = deriveTournamentRegistryFromResearchSource(
      [makeEventRecord('s1', '100', { completedAt: undefined })],
      { importedAtMs: IMPORTED_AT_MS },
    );
    const row = noTimestamps.rows[0]!;
    expect('startAtMs' in row).toBe(false);
    expect('endAtMs' in row).toBe(false);
    // Legacy-required members fall back to 0 rather than inventing a date.
    expect(row.firstSetAt).toBe(0);
    expect(row.lastSetAt).toBe(0);
  });

  it('resolves metadata from the freshest observation and seed from seedNum before initialSeedNum', () => {
    const { rows } = deriveTournamentRegistryFromResearchSource(
      [
        makeEventRecord('s1', '100', {
          lastObservedAtMs: 1_000,
          event: { eventId: '100', name: 'Old Name', numEntrants: 100 },
          entrants: [{ entrantId: 'e-subject', initialSeedNum: 9 }],
        }),
        makeEventRecord('s2', '100', {
          lastObservedAtMs: 2_000,
          event: { eventId: '100', name: 'Fresh Name' },
          entrants: [{ entrantId: 'e-subject', placement: 4 }],
        }),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );

    expect(rows[0]).toMatchObject({
      eventName: 'Fresh Name',
      numEntrants: 100,
      // No seedNum anywhere in the group — the initialSeedNum fallback wins.
      seed: 9,
      placement: 4,
    });
  });

  it('stamps provenance.asOfMs as the max lastObservedAtMs across the group', () => {
    const { rows } = deriveTournamentRegistryFromResearchSource(
      [
        makeEventRecord('s1', '100', { lastObservedAtMs: 1_000 }),
        makeEventRecord('s2', '100', { lastObservedAtMs: 5_000 }),
        makeEventRecord('s3', '100', {
          classification: 'dq',
          ruleId: 'R-DQ-FLAG',
          lastObservedAtMs: 9_000,
        }),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );
    expect(rows[0]?.provenance.asOfMs).toBe(9_000);
  });

  it('skips an event id that fails the RTDB key-safety predicate instead of sanitizing it', () => {
    const result = deriveTournamentRegistryFromResearchSource(
      [makeRecord({ providerSetId: 's1', apiIds: { setId: 's1', eventId: 'bad.id' } })],
      { importedAtMs: IMPORTED_AT_MS },
    );
    expect(result.rows).toEqual([]);
    expect(result.skippedUnsafeEventId).toBe(1);
  });

  it('is deterministic regardless of input order (identical rows, identical ordering)', () => {
    const records = [
      makeEventRecord('s1', '200'),
      makeEventRecord('s2', '100'),
      makeEventRecord('s3', '100', { completedAt: 1_700_100_000 }),
    ];
    const forward = deriveTournamentRegistryFromResearchSource(records, {
      importedAtMs: IMPORTED_AT_MS,
    });
    const reversed = deriveTournamentRegistryFromResearchSource([...records].reverse(), {
      importedAtMs: IMPORTED_AT_MS,
    });
    expect(forward).toEqual(reversed);
  });

  it('never emits topStandings, startggLinks-shaped members, or a legacy source member', () => {
    const { rows } = deriveTournamentRegistryFromResearchSource([makeEventRecord('s1', '100')], {
      importedAtMs: IMPORTED_AT_MS,
    });
    const row = rows[0]!;
    expect('topStandings' in row).toBe(false);
    expect('source' in row).toBe(false);
    expect('startggLinks' in row).toBe(false);
  });

  it('every derived row parses under the legacy tournamentEntrySchema (shipped readers never 500)', () => {
    const { rows } = deriveTournamentRegistryFromResearchSource(
      [
        makeEventRecord('s1', '100'),
        makeRecord({ providerSetId: 's2', apiIds: { setId: 's2', eventId: '300' } }),
      ],
      { importedAtMs: IMPORTED_AT_MS },
    );
    for (const row of rows) {
      expect(tournamentEntrySchema.safeParse(row).success).toBe(true);
    }
  });
});

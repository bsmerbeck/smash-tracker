import { describe, expect, it } from 'vitest';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { buildTournamentEntryRows } from './tournamentEntryRows';

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  const eventId = overrides.eventId ?? 1;
  return {
    eventId,
    eventName: 'Ultimate Singles',
    firstSetAt: Date.UTC(2021, 0, 1),
    lastSetAt: Date.UTC(2021, 0, 3),
    setsPlayed: 2,
    entryKey: String(eventId),
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

describe('buildTournamentEntryRows', () => {
  it('computes a per-entry record scoped by matchesForEntry', () => {
    const entry = makeEntry({ eventId: 1, eventName: 'Ultimate Singles' });
    const matches = [
      makeMatch({ id: 'm1', time: Date.UTC(2021, 0, 2), win: true, eventName: 'Ultimate Singles' }),
      makeMatch({
        id: 'm2',
        time: Date.UTC(2021, 0, 2),
        win: false,
        eventName: 'Ultimate Singles',
      }),
      makeMatch({ id: 'm3', time: Date.UTC(2021, 0, 2), win: true, eventName: 'Doubles' }),
    ];
    const rows = buildTournamentEntryRows([entry], matches);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.record).toMatchObject({ wins: 1, losses: 1, total: 2 });
  });

  it('sorts entries by lastSetAt descending', () => {
    const older = makeEntry({ eventId: 1, lastSetAt: Date.UTC(2020, 0, 1) });
    const newer = makeEntry({ eventId: 2, lastSetAt: Date.UTC(2022, 0, 1) });
    const rows = buildTournamentEntryRows([older, newer], []);
    expect(rows.map((r) => r.entry.eventId)).toEqual([2, 1]);
  });

  it('does not mutate the caller list', () => {
    const older = makeEntry({ eventId: 1, lastSetAt: Date.UTC(2020, 0, 1) });
    const newer = makeEntry({ eventId: 2, lastSetAt: Date.UTC(2022, 0, 1) });
    const input = [older, newer];
    buildTournamentEntryRows(input, []);
    expect(input.map((e) => e.eventId)).toEqual([1, 2]);
  });
});

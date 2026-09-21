import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { groupEncounters } from './encounterGrouping';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

describe('groupEncounters (39.1-18 Task 1, UIX-08/D-10)', () => {
  it('a two-event fixture produces exactly two groups, newest first', () => {
    const matches = [
      makeMatch({
        id: 'a1',
        time: 1000,
        win: true,
        externalId: 'sgg:100:g1',
        eventName: 'Event A',
      }),
      makeMatch({
        id: 'a2',
        time: 1001,
        win: true,
        externalId: 'sgg:100:g2',
        eventName: 'Event A',
      }),
      makeMatch({
        id: 'b1',
        time: 2000,
        win: false,
        externalId: 'sgg:200:g1',
        eventName: 'Event B',
      }),
    ];

    const groups = groupEncounters({ matches });

    expect(groups.map((g) => g.kind)).toEqual(['event', 'event']);
    expect(groups.map((g) => g.label)).toEqual(['Event B', 'Event A']);
  });

  it('two sets sharing an identical newest-game timestamp stay separate, ordered by set key', () => {
    const matches = [
      makeMatch({
        id: 'x1',
        time: 5000,
        win: true,
        externalId: 'sgg:11:g1',
        eventName: 'Same Event',
      }),
      makeMatch({
        id: 'x2',
        time: 5000,
        win: false,
        externalId: 'sgg:22:g1',
        eventName: 'Same Event',
      }),
    ];

    const groups = groupEncounters({ matches });

    expect(groups.length).toBe(1);
    expect(groups[0]!.sets.length).toBe(2);
    expect(groups[0]!.sets.map((s) => s.key)).toEqual(['11', '22']);
  });

  it('an event whose games are interleaved with another event’s produces correctly separated groups', () => {
    const matches = [
      makeMatch({ id: 'i1', time: 1000, win: true, externalId: 'sgg:1:g1', eventName: 'Event A' }),
      makeMatch({ id: 'i2', time: 1100, win: true, externalId: 'sgg:2:g1', eventName: 'Event B' }),
      makeMatch({ id: 'i3', time: 1200, win: false, externalId: 'sgg:1:g2', eventName: 'Event A' }),
      makeMatch({ id: 'i4', time: 1300, win: false, externalId: 'sgg:2:g2', eventName: 'Event B' }),
    ];

    const groups = groupEncounters({ matches });

    expect(groups.length).toBe(2);
    const eventA = groups.find((g) => g.label === 'Event A');
    const eventB = groups.find((g) => g.label === 'Event B');
    expect(eventA?.sets.length).toBe(1);
    expect(eventA?.sets[0]?.games.length).toBe(2);
    expect(eventB?.sets.length).toBe(1);
    expect(eventB?.sets[0]?.games.length).toBe(2);
  });

  it('a fixture of only manual games produces session groups with one game per pseudo-set', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 1000, win: true }),
      makeMatch({ id: 'm2', time: 1100, win: false }),
    ];

    const groups = groupEncounters({ matches, sessionGapMs: 60_000 });

    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.kind === 'session')).toBe(true);
    for (const group of groups) {
      for (const set of group.sets) {
        expect(set.games.length).toBe(1);
      }
    }
  });

  it('a mixed fixture produces both kinds in the right order', () => {
    const matches = [
      makeMatch({ id: 'e1', time: 3000, win: true, externalId: 'sgg:9:g1', eventName: 'Event C' }),
      makeMatch({ id: 'man1', time: 1000, win: true }),
    ];

    const groups = groupEncounters({ matches });

    expect(groups.map((g) => g.kind)).toEqual(['event', 'session']);
  });

  it('an empty match array returns an empty group list and does not throw', () => {
    expect(() => groupEncounters({ matches: [] })).not.toThrow();
    expect(groupEncounters({ matches: [] })).toEqual([]);
  });

  it('calling the function twice on the same input returns the identical order', () => {
    const matches = [
      makeMatch({
        id: 'a1',
        time: 1000,
        win: true,
        externalId: 'sgg:100:g1',
        eventName: 'Event A',
      }),
      makeMatch({ id: 'man1', time: 900, win: false }),
    ];

    const first = groupEncounters({ matches });
    const second = groupEncounters({ matches });

    expect(second).toEqual(first);
  });

  it('never merges two sets sharing a game timestamp — identity is the parsed set id, never the timestamp', () => {
    const matches = [
      makeMatch({
        id: 'y1',
        time: 8000,
        win: true,
        externalId: 'sgg:aa:g1',
        eventName: 'Merge Test',
      }),
      makeMatch({
        id: 'y2',
        time: 8000,
        win: true,
        externalId: 'sgg:bb:g1',
        eventName: 'Merge Test',
      }),
    ];

    const groups = groupEncounters({ matches });

    expect(groups[0]!.sets.length).toBe(2);
  });
});

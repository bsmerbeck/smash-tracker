import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { MANUAL_SET_WINDOW_MS, MAX_SET_GAMES, getDisplayedSetKey } from './vodSetGrouping';

function match(overrides: Partial<Match> & { id: string }): Match {
  return {
    fighter_id: 1,
    opponent_id: 8,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  } as Match;
}

describe('getDisplayedSetKey', () => {
  it('returns null for a single match', () => {
    expect(getDisplayedSetKey([match({ id: 'm1' })])).toBeNull();
  });

  it('returns null for matches spanning different opponents', () => {
    expect(
      getDisplayedSetKey([
        match({ id: 'm1', opponent: 'rival-one' }),
        match({ id: 'm2', opponent: 'rival-two' }),
      ]),
    ).toBeNull();
  });

  it('returns null for matches spanning different events', () => {
    expect(
      getDisplayedSetKey([
        match({ id: 'm1', eventName: 'Ultimate Singles' }),
        match({ id: 'm2', eventName: 'Ultimate Doubles' }),
      ]),
    ).toBeNull();
  });

  it('returns null for a manual group spread beyond the window', () => {
    expect(
      getDisplayedSetKey([
        match({ id: 'm1', time: 1_700_000_000_000 }),
        match({ id: 'm2', time: 1_700_000_000_000 + MANUAL_SET_WINDOW_MS + 1 }),
      ]),
    ).toBeNull();
  });

  it('returns null for more than five manual games', () => {
    const matches = Array.from({ length: MAX_SET_GAMES + 1 }, (_, i) =>
      match({ id: `m${i}`, time: 1_700_000_000_000 + i * 1000 }),
    );
    expect(getDisplayedSetKey(matches)).toBeNull();
  });

  it('returns null for two different synced setIds', () => {
    expect(
      getDisplayedSetKey([
        match({ id: 'm1', externalId: 'sgg:111:g1' }),
        match({ id: 'm2', externalId: 'sgg:222:g2' }),
      ]),
    ).toBeNull();
  });

  it('returns null for a mixed synced+manual list', () => {
    expect(
      getDisplayedSetKey([match({ id: 'm1', externalId: 'sgg:111:g1' }), match({ id: 'm2' })]),
    ).toBeNull();
  });

  it('returns a non-null key for 2-5 manual games sharing opponent/event/tournament within the window, even when fighter ids all differ', () => {
    const matches = [
      match({
        id: 'm1',
        opponent: 'rival',
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        time: 1_700_000_000_000,
        fighter_id: 1,
        opponent_id: 8,
      }),
      match({
        id: 'm2',
        opponent: 'rival',
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        time: 1_700_000_010_000,
        fighter_id: 2,
        opponent_id: 9,
      }),
      match({
        id: 'm3',
        opponent: 'rival',
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        time: 1_700_000_020_000,
        fighter_id: 3,
        opponent_id: 10,
      }),
    ];
    expect(getDisplayedSetKey(matches)).not.toBeNull();
  });

  it('groups untagged quickplay games (absent eventName/tournamentName treated as empty string)', () => {
    const matches = [
      match({ id: 'm1', time: 1_700_000_000_000 }),
      match({ id: 'm2', time: 1_700_000_010_000 }),
    ];
    expect(getDisplayedSetKey(matches)).not.toBeNull();
  });

  it('returns a non-null key for games sharing one parsed synced setId', () => {
    const matches = [
      match({ id: 'm1', externalId: 'sgg:111:g1' }),
      match({ id: 'm2', externalId: 'sgg:111:g2' }),
    ];
    expect(getDisplayedSetKey(matches)).not.toBeNull();
  });

  it('groups parry.gg-synced games sharing one matchId-derived setId', () => {
    const matches = [
      match({ id: 'm1', externalId: 'pgg-abc123-g1' }),
      match({ id: 'm2', externalId: 'pgg-abc123-g2' }),
    ];
    expect(getDisplayedSetKey(matches)).not.toBeNull();
  });
});

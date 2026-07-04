import { describe, expect, it } from 'vitest';
import type { EventStanding, Match } from '@smash-tracker/shared';
import {
  buildEventResultRows,
  opponentTagsPlayedAtEvent,
  standingMatchesPlayedOpponent,
} from './eventResults';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

function makeStanding(overrides: Partial<EventStanding> = {}): EventStanding {
  return {
    placement: 1,
    name: 'Sponsor | Rival',
    ...overrides,
  };
}

describe('opponentTagsPlayedAtEvent', () => {
  it('collects distinct lowercased opponent tags', () => {
    const matches = [
      makeMatch({ id: 'a', time: 100, win: true, opponent: 'Rival' }),
      makeMatch({ id: 'b', time: 200, win: false, opponent: 'RIVAL' }),
      makeMatch({ id: 'c', time: 300, win: true, opponent: 'someone-else' }),
    ];
    expect(opponentTagsPlayedAtEvent(matches)).toEqual(new Set(['rival', 'someone-else']));
  });

  it('skips matches with no opponent tag', () => {
    const matches = [makeMatch({ id: 'a', time: 100, win: true, opponent: undefined })];
    expect(opponentTagsPlayedAtEvent(matches)).toEqual(new Set());
  });
});

describe('standingMatchesPlayedOpponent', () => {
  it('matches on gamerTag case-insensitively', () => {
    const played = new Set(['rival']);
    expect(
      standingMatchesPlayedOpponent({ name: 'Sponsor | Rival', gamerTag: 'Rival' }, played),
    ).toBe(true);
  });

  it('matches on name case-insensitively when gamerTag is absent', () => {
    const played = new Set(['rival']);
    expect(standingMatchesPlayedOpponent({ name: 'RIVAL' }, played)).toBe(true);
  });

  it('returns false when neither name nor gamerTag match', () => {
    const played = new Set(['rival']);
    expect(standingMatchesPlayedOpponent({ name: 'Someone Else', gamerTag: 'Other' }, played)).toBe(
      false,
    );
  });
});

describe('buildEventResultRows', () => {
  it('returns an empty array when topStandings is absent', () => {
    expect(buildEventResultRows({ topStandings: undefined }, [])).toEqual([]);
  });

  it('uses gamerTag as displayName when it differs from name, with name as subLabel', () => {
    const rows = buildEventResultRows(
      {
        topStandings: [makeStanding({ placement: 1, name: 'Sponsor | Rival', gamerTag: 'Rival' })],
      },
      [],
    );
    expect(rows[0]?.displayName).toBe('Rival');
    expect(rows[0]?.subLabel).toBe('Sponsor | Rival');
  });

  it('uses name as displayName with no subLabel when gamerTag matches name or is absent', () => {
    const rows = buildEventResultRows(
      { topStandings: [makeStanding({ placement: 1, name: 'Rival', gamerTag: undefined })] },
      [],
    );
    expect(rows[0]?.displayName).toBe('Rival');
    expect(rows[0]?.subLabel).toBeNull();
  });

  it('flags playedAtEvent for standings matching an opponent tag played at this event', () => {
    const matches = [makeMatch({ id: 'a', time: 100, win: true, opponent: 'rival' })];
    const rows = buildEventResultRows(
      {
        topStandings: [makeStanding({ placement: 1, name: 'Sponsor | Rival', gamerTag: 'Rival' })],
      },
      matches,
    );
    expect(rows[0]?.playedAtEvent).toBe(true);
  });

  it('leaves playedAtEvent false for standings not matching any played opponent', () => {
    const matches = [makeMatch({ id: 'a', time: 100, win: true, opponent: 'someone-else' })];
    const rows = buildEventResultRows(
      {
        topStandings: [makeStanding({ placement: 1, name: 'Sponsor | Rival', gamerTag: 'Rival' })],
      },
      matches,
    );
    expect(rows[0]?.playedAtEvent).toBe(false);
  });

  it('builds a profile URL when userSlug is present', () => {
    const rows = buildEventResultRows(
      { topStandings: [makeStanding({ placement: 1, userSlug: 'user/9fb774ae' })] },
      [],
    );
    expect(rows[0]?.profileUrl).toBe('https://start.gg/user/9fb774ae');
  });

  it('leaves profileUrl null when userSlug is absent', () => {
    const rows = buildEventResultRows(
      { topStandings: [makeStanding({ placement: 1, userSlug: undefined })] },
      [],
    );
    expect(rows[0]?.profileUrl).toBeNull();
  });

  it('preserves standings order (placement ascending, as start.gg provides)', () => {
    const rows = buildEventResultRows(
      {
        topStandings: [
          makeStanding({ placement: 1, name: 'Winner' }),
          makeStanding({ placement: 2, name: 'Runner-up' }),
        ],
      },
      [],
    );
    expect(rows.map((r) => r.standing.placement)).toEqual([1, 2]);
  });
});

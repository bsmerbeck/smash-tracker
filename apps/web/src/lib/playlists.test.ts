import { describe, expect, it } from 'vitest';
import type { Match, Playlist } from '@smash-tracker/shared';
import { addMatchToPlaylistIds, movePlaylistItem, resolvePlaylistMatches } from './playlists';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 10,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function makePlaylist(overrides: Partial<Playlist> & Pick<Playlist, 'id' | 'matchIds'>): Playlist {
  return {
    name: 'My Playlist',
    createdAt: 0,
    ...overrides,
  };
}

describe('resolvePlaylistMatches', () => {
  it('resolves matchIds to Match objects in playlist order', () => {
    const m1 = makeMatch({ id: 'm1', time: 1, win: true });
    const m2 = makeMatch({ id: 'm2', time: 2, win: false });
    const m3 = makeMatch({ id: 'm3', time: 3, win: true });
    const playlist = makePlaylist({ id: 'p1', matchIds: ['m3', 'm1', 'm2'] });

    expect(resolvePlaylistMatches(playlist, [m1, m2, m3])).toEqual([m3, m1, m2]);
  });

  it('silently skips an id with no resolvable match (soft-orphan)', () => {
    const m1 = makeMatch({ id: 'm1', time: 1, win: true });
    const playlist = makePlaylist({ id: 'p1', matchIds: ['m1', 'unresolvable-orphan-id'] });

    expect(resolvePlaylistMatches(playlist, [m1])).toEqual([m1]);
  });

  it('returns an empty array for an empty playlist', () => {
    const playlist = makePlaylist({ id: 'p1', matchIds: [] });
    expect(resolvePlaylistMatches(playlist, [])).toEqual([]);
  });
});

describe('addMatchToPlaylistIds', () => {
  it('appends a new id', () => {
    expect(addMatchToPlaylistIds(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent — skips an id already present', () => {
    expect(addMatchToPlaylistIds(['a', 'b'], 'b')).toEqual(['a', 'b']);
  });

  it('never mutates the input array', () => {
    const input = ['a'];
    addMatchToPlaylistIds(input, 'b');
    expect(input).toEqual(['a']);
  });
});

describe('movePlaylistItem', () => {
  it('swaps an item up one slot', () => {
    expect(movePlaylistItem(['a', 'b', 'c'], 1, 'up')).toEqual(['b', 'a', 'c']);
  });

  it('swaps an item down one slot', () => {
    expect(movePlaylistItem(['a', 'b', 'c'], 1, 'down')).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op moving the first item up (top boundary)', () => {
    expect(movePlaylistItem(['a', 'b', 'c'], 0, 'up')).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op moving the last item down (bottom boundary)', () => {
    expect(movePlaylistItem(['a', 'b', 'c'], 2, 'down')).toEqual(['a', 'b', 'c']);
  });

  it('never mutates the input array', () => {
    const input = ['a', 'b', 'c'];
    movePlaylistItem(input, 1, 'up');
    expect(input).toEqual(['a', 'b', 'c']);
  });
});

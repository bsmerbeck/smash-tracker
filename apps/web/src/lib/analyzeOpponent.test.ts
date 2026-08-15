import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { buildAnalyzeOpponentPath, resolveAnalyzeOpponentPreselection } from './analyzeOpponent';

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 2,
    time: 1000,
    win: true,
    ...overrides,
  } as Match;
}

describe('buildAnalyzeOpponentPath', () => {
  it('prefers the start.gg provider id over the tag', () => {
    const path = buildAnalyzeOpponentPath({
      opponentUserSlug: 'user/9fb774ae',
      opponent: 'mkleo',
    });
    expect(path).toBe(
      `/opponents?player=${encodeURIComponent('sgg:user/9fb774ae')}&opponent=mkleo`,
    );
  });

  it('uses the parry.gg id when only that provider identity exists', () => {
    const path = buildAnalyzeOpponentPath({ opponentParryUserId: 'abc-123', opponent: 'rival' });
    expect(path).toBe(`/opponents?player=${encodeURIComponent('pgg:abc-123')}&opponent=rival`);
  });

  it('falls back to the tag alone when no provider id exists', () => {
    expect(buildAnalyzeOpponentPath({ opponent: 'rival' })).toBe('/opponents?opponent=rival');
  });

  it('returns null when nothing identifies the opponent', () => {
    expect(buildAnalyzeOpponentPath({})).toBeNull();
    expect(buildAnalyzeOpponentPath({ opponent: '' })).toBeNull();
  });
});

describe('resolveAnalyzeOpponentPreselection', () => {
  const matches = [
    makeMatch({ id: 'm1', opponent: 'canonical kleo', opponentUserSlug: 'user/9fb774ae' }),
    makeMatch({ id: 'm2', opponent: 'parry rival', opponentParryUserId: 'abc-123' }),
    makeMatch({ id: 'm3', opponent: 'someone else' }),
  ];

  it('resolves a start.gg player id to that match row’s canonical opponent name', () => {
    const params = new URLSearchParams({ player: 'sgg:user/9fb774ae', opponent: 'stale tag' });
    expect(resolveAnalyzeOpponentPreselection(params, matches, {})).toBe('canonical kleo');
  });

  it('resolves a parry.gg player id', () => {
    const params = new URLSearchParams({ player: 'pgg:abc-123' });
    expect(resolveAnalyzeOpponentPreselection(params, matches, {})).toBe('parry rival');
  });

  it('falls back to the alias-resolved tag when the id matches nothing', () => {
    const params = new URLSearchParams({ player: 'sgg:user/unknown', opponent: 'old tag' });
    expect(resolveAnalyzeOpponentPreselection(params, matches, { 'old tag': 'new tag' })).toBe(
      'new tag',
    );
  });

  it('applies one alias hop to a bare tag param', () => {
    const params = new URLSearchParams({ opponent: 'aka' });
    expect(resolveAnalyzeOpponentPreselection(params, matches, { aka: 'canonical kleo' })).toBe(
      'canonical kleo',
    );
    expect(resolveAnalyzeOpponentPreselection(params, matches, {})).toBe('aka');
  });

  it('returns null when no identifying param is present', () => {
    expect(resolveAnalyzeOpponentPreselection(new URLSearchParams(), matches, {})).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import {
  applyOpponentAliases,
  filterBySource,
  filterByRange,
  getOpponentSources,
} from './useFilteredMatches';

const manual = { id: 'm1', fighter_id: 1, opponent_id: 2, time: 1, win: true } as Match;
const imported = {
  id: 'sgg-1-g1',
  fighter_id: 1,
  opponent_id: 2,
  time: 2,
  win: false,
  source: 'startgg',
  externalId: 'sgg:1:g1',
} as Match;
const importedParrygg = {
  id: 'pgg-1-g1',
  fighter_id: 1,
  opponent_id: 2,
  time: 3,
  win: true,
  source: 'parrygg',
  externalId: 'pgg-1-g1',
} as Match;

describe('filterBySource', () => {
  it('passes everything through for all', () => {
    expect(filterBySource([manual, imported], 'all')).toHaveLength(2);
  });

  it('keeps only untagged records for manual', () => {
    expect(filterBySource([manual, imported], 'manual')).toEqual([manual]);
  });

  it('keeps only startgg-tagged records for startgg', () => {
    expect(filterBySource([manual, imported], 'startgg')).toEqual([imported]);
  });

  it('the "Competitive" (startgg) filter also matches parrygg-tagged records (V8-A)', () => {
    expect(filterBySource([manual, imported, importedParrygg], 'startgg')).toEqual([
      imported,
      importedParrygg,
    ]);
  });
});

describe('filterByRange', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = 1_700_000_000_000;

  function matchAt(id: string, time: number): Match {
    return { id, fighter_id: 1, opponent_id: 2, time, win: true } as Match;
  }

  it('passes everything through for all', () => {
    const matches = [matchAt('1', 0), matchAt('2', now)];
    expect(filterByRange(matches, 'all', now)).toEqual(matches);
  });

  it('keeps matches within the trailing window and excludes older ones', () => {
    const within = matchAt('within', now - 10 * DAY_MS);
    const outside = matchAt('outside', now - 200 * DAY_MS);
    expect(filterByRange([within, outside], '3m', now)).toEqual([within]);
  });

  it('includes a match exactly at the cutoff boundary (inclusive)', () => {
    const cutoff = now - 90 * DAY_MS; // 3m = 30*3 days
    const atBoundary = matchAt('boundary', cutoff);
    expect(filterByRange([atBoundary], '3m', now)).toEqual([atBoundary]);
  });

  it('excludes a match one millisecond before the cutoff', () => {
    const cutoff = now - 90 * DAY_MS;
    const justBefore = matchAt('just-before', cutoff - 1);
    expect(filterByRange([justBefore], '3m', now)).toEqual([]);
  });

  it('applies the correct window for 6m and 12m', () => {
    const at6m = matchAt('6m', now - 180 * DAY_MS);
    const at12m = matchAt('12m', now - 360 * DAY_MS);
    const tooOld = matchAt('too-old', now - 400 * DAY_MS);
    expect(filterByRange([at6m, at12m, tooOld], '6m', now)).toEqual([at6m]);
    expect(filterByRange([at6m, at12m, tooOld], '12m', now)).toEqual([at6m, at12m]);
  });
});

function withOpponent(
  id: string,
  opponent: string | undefined,
  source?: 'startgg' | 'parrygg',
): Match {
  return {
    id,
    fighter_id: 1,
    opponent_id: 2,
    time: 1,
    win: true,
    ...(opponent !== undefined ? { opponent } : {}),
    ...(source ? { source } : {}),
  } as Match;
}

describe('applyOpponentAliases', () => {
  it('returns the same array reference when the alias map is empty', () => {
    const matches = [withOpponent('m1', 'rival')];
    expect(applyOpponentAliases(matches, {})).toBe(matches);
  });

  it('rewrites match.opponent to the canonical name', () => {
    const matches = [withOpponent('m1', 'rivl')];
    const result = applyOpponentAliases(matches, { rivl: 'rival' });
    expect(result[0]!.opponent).toBe('rival');
  });

  it('leaves matches without an opponent untouched', () => {
    const matches = [withOpponent('m1', undefined)];
    const result = applyOpponentAliases(matches, { rivl: 'rival' });
    expect(result[0]).toBe(matches[0]);
  });

  it('leaves matches whose opponent is not an alias key untouched (same reference)', () => {
    const matches = [withOpponent('m1', 'someoneelse')];
    const result = applyOpponentAliases(matches, { rivl: 'rival' });
    expect(result[0]).toBe(matches[0]);
  });

  it('applies a chain of aliases pointing at different names independently', () => {
    const matches = [withOpponent('m1', 'rivl'), withOpponent('m2', 'riv')];
    const result = applyOpponentAliases(matches, { rivl: 'rival', riv: 'rival' });
    expect(result.map((m) => m.opponent)).toEqual(['rival', 'rival']);
  });
});

describe('getOpponentSources', () => {
  it('classifies an opponent with only imported matches as startgg', () => {
    const matches = [
      withOpponent('m1', 'rival', 'startgg'),
      withOpponent('m2', 'rival', 'startgg'),
    ];
    expect(getOpponentSources(matches).get('rival')).toBe('startgg');
  });

  it('classifies an opponent with only manual matches as manual', () => {
    const matches = [withOpponent('m1', 'rival'), withOpponent('m2', 'rival')];
    expect(getOpponentSources(matches).get('rival')).toBe('manual');
  });

  it('classifies an opponent with both as mixed', () => {
    const matches = [withOpponent('m1', 'rival', 'startgg'), withOpponent('m2', 'rival')];
    expect(getOpponentSources(matches).get('rival')).toBe('mixed');
  });

  it('ignores matches with no opponent name', () => {
    const matches = [withOpponent('m1', undefined)];
    expect(getOpponentSources(matches).size).toBe(0);
  });

  it('tracks multiple opponents independently', () => {
    const matches = [withOpponent('m1', 'rival', 'startgg'), withOpponent('m2', 'zeta')];
    const sources = getOpponentSources(matches);
    expect(sources.get('rival')).toBe('startgg');
    expect(sources.get('zeta')).toBe('manual');
  });

  it('classifies an opponent with only parrygg matches as parrygg (V8-A)', () => {
    const matches = [
      withOpponent('m1', 'rival', 'parrygg'),
      withOpponent('m2', 'rival', 'parrygg'),
    ];
    expect(getOpponentSources(matches).get('rival')).toBe('parrygg');
  });

  it('classifies an opponent with parrygg + manual matches as mixed', () => {
    const matches = [withOpponent('m1', 'rival', 'parrygg'), withOpponent('m2', 'rival')];
    expect(getOpponentSources(matches).get('rival')).toBe('mixed');
  });

  it('classifies an opponent seen on BOTH tournament sites (no manual) as mixed', () => {
    const matches = [
      withOpponent('m1', 'rival', 'startgg'),
      withOpponent('m2', 'rival', 'parrygg'),
    ];
    expect(getOpponentSources(matches).get('rival')).toBe('mixed');
  });
});

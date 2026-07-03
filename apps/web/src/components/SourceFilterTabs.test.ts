import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import { filterBySource } from './SourceFilterTabs';

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
});

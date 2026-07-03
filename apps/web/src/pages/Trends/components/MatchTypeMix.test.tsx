import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { MatchTypeMix, bucketMatchType, buildMonthlyMatchTypeMix } from './MatchTypeMix';

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

describe('bucketMatchType', () => {
  it('buckets tourney types (online/offline) together', () => {
    expect(bucketMatchType('online-tourney')).toBe('tourney');
    expect(bucketMatchType('offline-tourney')).toBe('tourney');
  });

  it('buckets friendly types (online/offline) together', () => {
    expect(bucketMatchType('online-friendly')).toBe('friendly');
    expect(bucketMatchType('offline-friendly')).toBe('friendly');
  });

  it('buckets quickplay on its own', () => {
    expect(bucketMatchType('quickplay')).toBe('quickplay');
  });

  it('buckets missing/none/empty as unspecified', () => {
    expect(bucketMatchType('none')).toBe('unspecified');
    expect(bucketMatchType('')).toBe('unspecified');
    expect(bucketMatchType(undefined)).toBe('unspecified');
  });
});

describe('buildMonthlyMatchTypeMix', () => {
  it('groups counts per month per bucket', () => {
    const matches = [
      makeMatch({ id: '1', time: Date.UTC(2021, 0, 1), win: true, matchType: 'quickplay' }),
      makeMatch({ id: '2', time: Date.UTC(2021, 0, 2), win: true, matchType: 'online-tourney' }),
      makeMatch({ id: '3', time: Date.UTC(2021, 1, 1), win: true, matchType: 'offline-friendly' }),
    ];
    const mix = buildMonthlyMatchTypeMix(matches);

    expect(mix).toEqual([
      { month: '2021-01', counts: { tourney: 1, friendly: 0, quickplay: 1, unspecified: 0 } },
      { month: '2021-02', counts: { tourney: 0, friendly: 1, quickplay: 0, unspecified: 0 } },
    ]);
  });

  it('returns an empty array for no matches', () => {
    expect(buildMonthlyMatchTypeMix([])).toEqual([]);
  });
});

describe('MatchTypeMix component', () => {
  it('shows an empty state with no match data', () => {
    render(<MatchTypeMix matches={[]} />);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('renders the card title when data exists', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true, matchType: 'quickplay' })];
    render(<MatchTypeMix matches={matches} />);
    expect(screen.getByText('Match-Type Mix Over Time')).toBeInTheDocument();
  });
});

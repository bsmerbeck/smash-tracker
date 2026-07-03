import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { SettingComparison, TAKEAWAY_MIN_SAMPLE, buildSettingTakeaway } from './SettingComparison';
import { getOnlineOfflineSplit } from '@/lib/stats';

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

function matchesOfType(count: number, type: Match['matchType'], winCount: number): Match[] {
  return Array.from({ length: count }, (_, i) =>
    makeMatch({ id: `${type}-${i}`, time: i, win: i < winCount, matchType: type }),
  );
}

describe('buildSettingTakeaway', () => {
  it('reports small-sample when either side is under the threshold', () => {
    const split = getOnlineOfflineSplit([
      ...matchesOfType(TAKEAWAY_MIN_SAMPLE - 1, 'quickplay', TAKEAWAY_MIN_SAMPLE - 1),
      ...matchesOfType(TAKEAWAY_MIN_SAMPLE, 'offline-friendly', 5),
    ]);
    expect(buildSettingTakeaway(split)).toEqual({ kind: 'small-sample' });
  });

  it('reports a takeaway favoring online when both sides meet the threshold and online is higher', () => {
    const split = getOnlineOfflineSplit([
      ...matchesOfType(10, 'quickplay', 8), // 80%
      ...matchesOfType(10, 'offline-friendly', 5), // 50%
    ]);
    const takeaway = buildSettingTakeaway(split);
    expect(takeaway.kind).toBe('takeaway');
    expect(takeaway.better).toBe('online');
    expect(takeaway.deltaPoints).toBe(30);
  });

  it('reports a takeaway favoring offline when offline is higher', () => {
    const split = getOnlineOfflineSplit([
      ...matchesOfType(10, 'quickplay', 3), // 30%
      ...matchesOfType(10, 'offline-friendly', 7), // 70%
    ]);
    const takeaway = buildSettingTakeaway(split);
    expect(takeaway.kind).toBe('takeaway');
    expect(takeaway.better).toBe('offline');
    expect(takeaway.deltaPoints).toBe(40);
  });

  it('reports a zero delta as even when rates match exactly', () => {
    const split = getOnlineOfflineSplit([
      ...matchesOfType(10, 'quickplay', 5),
      ...matchesOfType(10, 'offline-friendly', 5),
    ]);
    const takeaway = buildSettingTakeaway(split);
    expect(takeaway.kind).toBe('takeaway');
    expect(takeaway.deltaPoints).toBe(0);
  });
});

describe('SettingComparison component', () => {
  it('shows an empty state with no match data', () => {
    render(<SettingComparison matches={[]} />);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('renders the three stat blocks', () => {
    const matches = [
      ...matchesOfType(2, 'quickplay', 1),
      ...matchesOfType(2, 'offline-friendly', 1),
    ];
    render(<SettingComparison matches={matches} />);

    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Unspecified')).toBeInTheDocument();
  });

  it('shows the small-sample note instead of a takeaway when samples are thin', () => {
    const matches = [
      ...matchesOfType(2, 'quickplay', 1),
      ...matchesOfType(2, 'offline-friendly', 1),
    ];
    render(<SettingComparison matches={matches} />);

    expect(
      screen.getByText(
        `Need at least ${TAKEAWAY_MIN_SAMPLE} games both online and offline for a reliable comparison.`,
      ),
    ).toBeInTheDocument();
  });

  it('shows the one-line takeaway when both samples meet the threshold', () => {
    const matches = [
      ...matchesOfType(10, 'quickplay', 8),
      ...matchesOfType(10, 'offline-friendly', 5),
    ];
    render(<SettingComparison matches={matches} />);

    expect(screen.getByText(/more online than offline/)).toBeInTheDocument();
  });
});

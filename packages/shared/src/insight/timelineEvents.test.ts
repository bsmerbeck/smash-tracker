import { describe, expect, it } from 'vitest';
import { TIER_LEVEL, type KnownTierWord } from '../tournamentTier.js';
import {
  TIMELINE_EVENT_MARKER_MAX,
  selectTimelineEventMarkers,
  type TimelineEventCandidate,
} from './timelineEvents.js';

function candidate(
  key: string,
  atMs: number,
  tier: KnownTierWord,
  overrides: Partial<TimelineEventCandidate> = {},
): TimelineEventCandidate {
  return {
    key,
    label: key,
    atMs,
    wins: 3,
    losses: 2,
    tier,
    basis: 'recorded',
    level: TIER_LEVEL[tier],
    entrants: null,
    ratingAfter: null,
    ...overrides,
  };
}

describe('selectTimelineEventMarkers (plan 41-04, DD-41-09)', () => {
  it('drops candidates below minLevel and returns the rest ascending by atMs', () => {
    const selection = selectTimelineEventMarkers(
      [
        candidate('late-major', 300, 'major'),
        candidate('minor', 200, 'minor'),
        candidate('early-super', 100, 'supermajor'),
      ],
      { minLevel: TIER_LEVEL.major },
    );
    expect(selection.markers.map((m) => m.key)).toEqual(['early-super', 'late-major']);
    expect(selection.shown).toBe(2);
    expect(selection.total).toBe(2);
  });

  it('keeps every supermajor first, then the most recent majors, when over the cap', () => {
    const candidates: TimelineEventCandidate[] = [];
    // 5 old supermajors, then 50 majors of increasing recency: 55 qualifying.
    for (let i = 0; i < 5; i += 1) candidates.push(candidate(`super-${i}`, i + 1, 'supermajor'));
    for (let i = 0; i < 50; i += 1) candidates.push(candidate(`major-${i}`, 1000 + i, 'major'));
    const selection = selectTimelineEventMarkers(candidates, { minLevel: TIER_LEVEL.major });
    expect(selection.total).toBe(55);
    expect(selection.shown).toBe(TIMELINE_EVENT_MARKER_MAX);
    expect(selection.markers).toHaveLength(40);
    const keys = new Set(selection.markers.map((m) => m.key));
    for (let i = 0; i < 5; i += 1) expect(keys.has(`super-${i}`)).toBe(true);
    // 35 most recent majors: major-15 .. major-49.
    expect(keys.has('major-14')).toBe(false);
    expect(keys.has('major-15')).toBe(true);
    expect(keys.has('major-49')).toBe(true);
    const atMs = selection.markers.map((m) => m.atMs);
    expect(atMs).toEqual([...atMs].sort((a, b) => a - b));
  });

  it('keeps the most recent supermajors when supermajors alone exceed the cap', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      candidate(`super-${i}`, i + 1, 'supermajor'),
    );
    candidates.push(candidate('major', 999, 'major'));
    const selection = selectTimelineEventMarkers(candidates, { minLevel: 4, max: 4 });
    expect(selection.markers.map((m) => m.key)).toEqual([
      'super-6',
      'super-7',
      'super-8',
      'super-9',
    ]);
    expect(selection.total).toBe(11);
  });

  it('is empty for no qualifying candidate and never mutates its input', () => {
    const input = [candidate('b', 2, 'minor'), candidate('a', 1, 'local')];
    const snapshot = JSON.stringify(input);
    const selection = selectTimelineEventMarkers(input, { minLevel: TIER_LEVEL.major });
    expect(selection).toEqual({ markers: [], shown: 0, total: 0 });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

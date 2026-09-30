import { describe, expect, it } from 'vitest';
import type { Match } from './match.js';
import { eventBlocksOf } from './evidence/eventBlocks.js';
import {
  DIGEST_SEEN_EVENTS_CAP,
  hasEventSyncedSince,
  isEventNewSince,
  parseDigestSnapshot,
  seenEventsOf,
} from './digest.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** One weekly (2 games) per index, a week apart, all named "Ultimate Singles". */
function weeklies(count: number): Match[] {
  return Array.from({ length: count }, (_, i) =>
    [0, 1].map((g) => ({
      id: `w${i}-g${g}`,
      fighter_id: 1,
      opponent_id: 2,
      time: (i + 1) * WEEK_MS + g * 60_000,
      win: true,
      eventName: 'Ultimate Singles',
      tournamentName: `Weekly #${i}`,
    })),
  ).flat();
}

describe('seenEventsOf / isEventNewSince / hasEventSyncedSince (39.2-REVIEW WEB-WR-01)', () => {
  it('stores every event with its game count while under the cap', () => {
    const matches = weeklies(3);
    const events = seenEventsOf(matches);
    expect(Object.keys(events.seen)).toHaveLength(3);
    expect(Object.values(events.seen)).toEqual([2, 2, 2]);
    expect(events.truncatedAtMs).toBeUndefined();
  });

  it('keeps the newest events at the cap; an older unseen event is not new, a newer one is', () => {
    const matches = weeklies(DIGEST_SEEN_EVENTS_CAP + 5);
    const events = seenEventsOf(matches);
    expect(Object.keys(events.seen)).toHaveLength(DIGEST_SEEN_EVENTS_CAP);
    expect(events.truncatedAtMs).toBeDefined();
    const blocks = eventBlocksOf(matches);
    const visit = { lastSeenAt: Number.MAX_SAFE_INTEGER, events };
    // The oldest block was dropped from the set, but it is older than the cut-off.
    expect(isEventNewSince(blocks[0]!, visit)).toBe(false);
    // The newest block was seen.
    expect(isEventNewSince(blocks[blocks.length - 1]!, visit)).toBe(false);
    // A block synced after the visit, newer than the cut-off, is new.
    const [fresh] = eventBlocksOf(weeklies(DIGEST_SEEN_EVENTS_CAP + 6).slice(-2));
    expect(isEventNewSince(fresh!, visit)).toBe(true);
  });

  it('an event that gained games since the visit has games synced since, but is not a new event', () => {
    const matches = weeklies(1);
    const [block] = eventBlocksOf(matches);
    const visit = { lastSeenAt: Number.MAX_SAFE_INTEGER, events: { seen: { [block!.key]: 1 } } };
    expect(isEventNewSince(block!, visit)).toBe(false);
    expect(hasEventSyncedSince(block!, visit)).toBe(true);
    expect(hasEventSyncedSince(block!, { ...visit, events: { seen: { [block!.key]: 2 } } })).toBe(
      false,
    );
  });

  it('a snapshot with and without a seen set both parse; a malformed seen set reads as a first visit', () => {
    const base = { lastSeenAt: 1, lastSeenMatchCount: 2, tracked: {} };
    expect(parseDigestSnapshot(JSON.stringify(base))).toEqual(base);
    const withEvents = { ...base, events: { seen: { 'event:x@1': 2 }, truncatedAtMs: 5 } };
    expect(parseDigestSnapshot(JSON.stringify(withEvents))).toEqual(withEvents);
    expect(
      parseDigestSnapshot(JSON.stringify({ ...base, events: { seen: { 'event:x@1': -1 } } })),
    ).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { resolveWindow, toRateValue, matchDateRange } from './horizon.js';
import { SCOPED_RECENCY_MONTHS } from './policy.js';
import type { Match } from '../match.js';

const NOW_MS = 1_700_100_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: overrides.id ?? 'm',
    fighter_id: 8,
    opponent_id: 23,
    time: NOW_MS,
    win: true,
    matchType: 'offline-tourney',
    ...overrides,
  };
}

describe('resolveWindow', () => {
  it('lastEvent picks only the newer of two named events', () => {
    const olderEvent: Match[] = [
      makeMatch({ id: 'a1', time: NOW_MS - 10 * DAY_MS, eventName: 'Older Cup' }),
      makeMatch({ id: 'a2', time: NOW_MS - 9 * DAY_MS, eventName: 'Older Cup' }),
    ];
    const newerEvent: Match[] = [
      makeMatch({ id: 'b1', time: NOW_MS - 2 * DAY_MS, eventName: 'Newer Cup' }),
      makeMatch({ id: 'b2', time: NOW_MS - 1 * DAY_MS, eventName: 'Newer Cup' }),
    ];
    const { window, matches } = resolveWindow({
      matches: [...olderEvent, ...newerEvent],
      horizon: 'lastEvent',
      scoped: false,
      nowMs: NOW_MS,
    });
    expect(matches.map((m) => m.id).sort()).toEqual(['b1', 'b2']);
    expect(window.games).toBe(2);
  });

  // 39.2 code review R2-WR-02: the horizon uses the ONE event-identity rule
  // (`evidence/eventBlocks.ts`), never a bare event name — start.gg names
  // nearly every bracket "Ultimate Singles", so a name alone pools every
  // weekly the user ever played.
  it('lastEvent over 10 same-named weeklies reads only the newest weekly', () => {
    const weeklies: Match[] = [];
    for (let week = 0; week < 10; week += 1) {
      for (let game = 0; game < 6; game += 1) {
        weeklies.push(
          makeMatch({
            id: `w${week}-g${game}`,
            time: NOW_MS - (9 - week) * 7 * DAY_MS - (5 - game) * 60_000,
            eventName: 'Ultimate Singles',
            tournamentName: `Weekly #${week + 1}`,
          }),
        );
      }
    }
    const { window, matches } = resolveWindow({
      matches: weeklies,
      horizon: 'lastEvent',
      scoped: false,
      nowMs: NOW_MS,
    });
    expect(window.games).toBe(6);
    expect(matches.map((m) => m.id)).toEqual([
      'w9-g0',
      'w9-g1',
      'w9-g2',
      'w9-g3',
      'w9-g4',
      'w9-g5',
    ]);
  });

  it('lastEvent splits one event and tournament name into proximity blocks', () => {
    const lastMonth = [1, 2].map((n) =>
      makeMatch({
        id: `old-${n}`,
        time: NOW_MS - 30 * DAY_MS + n * 60_000,
        eventName: 'Ultimate Singles',
        tournamentName: 'Monthly',
      }),
    );
    const thisMonth = [1, 2, 3].map((n) =>
      makeMatch({
        id: `new-${n}`,
        time: NOW_MS - DAY_MS + n * 60_000,
        eventName: 'Ultimate Singles',
        tournamentName: 'Monthly',
      }),
    );
    const { window, matches } = resolveWindow({
      matches: [...thisMonth, ...lastMonth],
      horizon: 'lastEvent',
      scoped: false,
      nowMs: NOW_MS,
    });
    expect(window.games).toBe(3);
    expect(matches.map((m) => m.id)).toEqual(['new-1', 'new-2', 'new-3']);
  });

  // Plan 39.1-44 (M4 follow-up, mirrors 39.2-review SH-CR-01): start.gg names nearly
  // every bracket "Ultimate Singles", so an event is its name group (event name +
  // tournament name) split into proximity blocks — never a bare event name.
  it('lastEvent never pools same-named brackets of different tournaments', () => {
    const older: Match[] = [
      makeMatch({
        id: 'a1',
        time: NOW_MS - 20 * DAY_MS,
        eventName: 'Ultimate Singles',
        tournamentName: 'Collision 2026',
      }),
      makeMatch({
        id: 'a2',
        time: NOW_MS - 20 * DAY_MS + 3600_000,
        eventName: 'Ultimate Singles',
        tournamentName: 'Collision 2026',
      }),
    ];
    const newer: Match[] = [
      makeMatch({
        id: 'b1',
        time: NOW_MS - 1 * DAY_MS,
        eventName: 'Ultimate Singles',
        tournamentName: 'Battle of BC 8',
      }),
      makeMatch({
        id: 'b2',
        time: NOW_MS - 1 * DAY_MS + 3600_000,
        eventName: 'Ultimate Singles',
        tournamentName: 'Battle of BC 8',
      }),
    ];
    const { window, matches } = resolveWindow({
      matches: [...older, ...newer],
      horizon: 'lastEvent',
      scoped: false,
      nowMs: NOW_MS,
    });
    expect(matches.map((m) => m.id).sort()).toEqual(['b1', 'b2']);
    expect(window.games).toBe(2);
  });

  it('lastEvent never pools the same tournament name months apart (proximity blocks)', () => {
    const weeklyA: Match[] = [
      makeMatch({
        id: 'w1',
        time: NOW_MS - 60 * DAY_MS,
        eventName: 'Ultimate Singles',
        tournamentName: 'Weekly',
      }),
      makeMatch({
        id: 'w2',
        time: NOW_MS - 60 * DAY_MS + 1800_000,
        eventName: 'Ultimate Singles',
        tournamentName: 'Weekly',
      }),
    ];
    const weeklyB: Match[] = [
      makeMatch({
        id: 'w3',
        time: NOW_MS - 2 * DAY_MS,
        eventName: 'Ultimate Singles',
        tournamentName: 'Weekly',
      }),
    ];
    const { matches } = resolveWindow({
      matches: [...weeklyA, ...weeklyB],
      horizon: 'lastEvent',
      scoped: false,
      nowMs: NOW_MS,
    });
    expect(matches.map((m) => m.id)).toEqual(['w3']);
  });

  it('lastEvent keeps one event whole: same names inside the proximity window stay together', () => {
    const day1 = makeMatch({
      id: 'd1',
      time: NOW_MS - 3 * DAY_MS,
      eventName: 'Ultimate Singles',
      tournamentName: 'Major',
    });
    const day2 = makeMatch({
      id: 'd2',
      time: NOW_MS - 2 * DAY_MS,
      eventName: 'Ultimate Singles',
      tournamentName: 'Major',
    });
    const { matches } = resolveWindow({
      matches: [day1, day2],
      horizon: 'lastEvent',
      scoped: false,
      nowMs: NOW_MS,
    });
    expect(matches.map((m) => m.id).sort()).toEqual(['d1', 'd2']);
  });

  it('lastEvent returns [] over a history with no named event anywhere', () => {
    const { matches } = resolveWindow({
      matches: [makeMatch({ id: 'manual-1' }), makeMatch({ id: 'manual-2' })],
      horizon: 'lastEvent',
      scoped: false,
      nowMs: NOW_MS,
    });
    expect(matches).toEqual([]);
  });

  it('last90 excludes a game exactly 91 days old and includes one exactly 90 days old', () => {
    const matches: Match[] = [
      makeMatch({ id: 'too-old', time: NOW_MS - 91 * DAY_MS }),
      makeMatch({ id: 'boundary', time: NOW_MS - 90 * DAY_MS }),
    ];
    const { matches: windowed } = resolveWindow({
      matches,
      horizon: 'last90',
      scoped: false,
      nowMs: NOW_MS,
    });
    expect(windowed.map((m) => m.id)).toEqual(['boundary']);
  });

  it('a scoped window over games older than SCOPED_RECENCY_MONTHS excludes them before any horizon slicing', () => {
    const monthMs = 30 * DAY_MS;
    const matches: Match[] = [
      makeMatch({ id: 'ancient', time: NOW_MS - (SCOPED_RECENCY_MONTHS + 1) * monthMs }),
    ];
    const { window, matches: windowed } = resolveWindow({
      matches,
      horizon: 'last30',
      scoped: true,
      nowMs: NOW_MS,
    });
    expect(windowed).toEqual([]);
    expect(window.games).toBe(0);
    expect(window.scoped).toBe(true);
  });

  it("the window's fromMs/toMs match the real first and last game in the window", () => {
    const matches: Match[] = [
      makeMatch({ id: 'first', time: NOW_MS - 5 * DAY_MS }),
      makeMatch({ id: 'middle', time: NOW_MS - 3 * DAY_MS }),
      makeMatch({ id: 'last', time: NOW_MS - 1 * DAY_MS }),
    ];
    const { window } = resolveWindow({ matches, horizon: 'last30', scoped: false, nowMs: NOW_MS });
    expect(window.fromMs).toBe(NOW_MS - 5 * DAY_MS);
    expect(window.toMs).toBe(NOW_MS - 1 * DAY_MS);
  });

  it('WR-A04: last30 selects the same games regardless of input array order for tied timestamps straddling the window boundary', () => {
    const tieTime = NOW_MS - 1000 * DAY_MS;
    const tieA = makeMatch({ id: 'aaa', time: tieTime });
    const tieB = makeMatch({ id: 'zzz', time: tieTime });
    // 29 later, distinct-time matches -> total 31 games; last30 drops exactly
    // one of the two oldest (tied) games. Which one gets dropped must not
    // depend on which order the tied pair appears in the INPUT array (only a
    // non-total comparator relying on Array.sort's input-order-preserving
    // stability would leak that dependency).
    const rest: Match[] = Array.from({ length: 29 }, (_, i) =>
      makeMatch({ id: `r${i}`, time: tieTime + (i + 1) * 60_000 }),
    );

    const orderA = resolveWindow({
      matches: [tieA, tieB, ...rest],
      horizon: 'last30',
      scoped: false,
      nowMs: NOW_MS,
    });
    const orderB = resolveWindow({
      matches: [tieB, tieA, ...rest],
      horizon: 'last30',
      scoped: false,
      nowMs: NOW_MS,
    });

    expect(orderA.matches.map((m) => m.id).sort()).toEqual(orderB.matches.map((m) => m.id).sort());
  });

  it('returns { fromMs: null, toMs: null } for an empty window', () => {
    const { window } = resolveWindow({
      matches: [],
      horizon: 'last30',
      scoped: false,
      nowMs: NOW_MS,
    });
    expect(window.fromMs).toBeNull();
    expect(window.toMs).toBeNull();
    expect(window.games).toBe(0);
  });
});

describe('toRateValue', () => {
  it('returns rate 0 for an empty match list, never NaN', () => {
    expect(toRateValue([])).toEqual({ wins: 0, losses: 0, total: 0, rate: 0 });
  });

  it('computes wins/losses/total/rate over a mixed record', () => {
    const matches: Match[] = [
      makeMatch({ id: '1', win: true }),
      makeMatch({ id: '2', win: false }),
      makeMatch({ id: '3', win: true }),
    ];
    expect(toRateValue(matches)).toEqual({ wins: 2, losses: 1, total: 3, rate: 2 / 3 });
  });
});

describe('matchDateRange', () => {
  it('returns nulls for an empty match list', () => {
    expect(matchDateRange([])).toEqual({ fromMs: null, toMs: null });
  });
});

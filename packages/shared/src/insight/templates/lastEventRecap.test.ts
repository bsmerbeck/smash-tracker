import { describe, expect, it } from 'vitest';
import {
  lastEventRecapTemplate,
  buildLastEventRecapInsight,
  buildEventHorizonRead,
} from './lastEventRecap.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { TournamentEntry } from '../../startgg.js';
import { assembleRail } from '../rail.js';
import type { InsightScope } from '../types.js';
import type { Match } from '../../match.js';
import type { TournamentRegistryRow } from '../../tournamentRegistry.js';

const SUBJECT_FIGHTER_ID = 8;
const NOW_MS = 1_700_100_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function subjectScope(): InsightScope {
  return {
    kind: 'character',
    key: `character:${SUBJECT_FIGHTER_ID}`,
    axes: { fighter: SUBJECT_FIGHTER_ID },
    filter: (matches) => matches.filter((m) => m.fighter_id === SUBJECT_FIGHTER_ID),
  };
}

function buildRegistryRow(overrides: Partial<TournamentRegistryRow>): TournamentRegistryRow {
  return {
    entryId: 'histimport:1',
    origin: 'admin-imported',
    provider: 'startgg',
    startggEventId: '1',
    eventName: 'Ultimate Singles',
    playedSetCount: 2,
    provenance: { source: 'research-import', importedAtMs: NOW_MS },
    registryWitness: 'research-import:v1:1',
    firstSetAt: NOW_MS - 10 * ONE_HOUR_MS,
    lastSetAt: NOW_MS,
    setsPlayed: 2,
    ...overrides,
  } as TournamentRegistryRow;
}

function buildEventGames(params: {
  eventName: string;
  setCount: number;
  gamesPerSet: number;
  startAt: number;
  win: (setIndex: number, gameIndex: number) => boolean;
  parsableSets?: boolean;
}): Match[] {
  const { eventName, setCount, gamesPerSet, startAt, win, parsableSets = true } = params;
  const matches: Match[] = [];
  let time = startAt;
  for (let s = 0; s < setCount; s += 1) {
    for (let g = 0; g < gamesPerSet; g += 1) {
      time += ONE_HOUR_MS;
      matches.push({
        id: `event-${eventName}-${s}-${g}`,
        fighter_id: SUBJECT_FIGHTER_ID,
        opponent_id: 2,
        time,
        win: win(s, g),
        matchType: 'offline-tourney',
        eventName,
        ...(parsableSets ? { externalId: `sgg:${eventName}-set${s}:g${g + 1}` } : {}),
      });
    }
  }
  return matches;
}

describe('lastEventRecapTemplate (Task 2: the link-less factual recap)', () => {
  it('declares windowExpressible: true and assertsDirection: false', () => {
    expect(lastEventRecapTemplate.windowExpressible).toBe(true);
    expect(lastEventRecapTemplate.assertsDirection).toBe(false);
  });

  it('reports the games and set record for the most recent event', () => {
    const matches = buildEventGames({
      eventName: 'Supernova 2026',
      setCount: 3,
      gamesPerSet: 2,
      startAt: NOW_MS - 20 * ONE_HOUR_MS,
      win: (s, g) => (s === 0 ? g === 0 : s === 1 ? true : false),
    });
    const insights = lastEventRecapTemplate.build({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.state).toBe('fact');
    expect(insights[0]!.copy.values.event).toBe('Supernova 2026');
  });

  it('over a registry entry carrying a placement AND entrant count, returns the placement copy key with both values; the same fixture with the placement field absent returns the W–L-only key', () => {
    const matches = buildEventGames({
      eventName: 'Supernova 2026',
      setCount: 2,
      gamesPerSet: 2,
      startAt: NOW_MS - 10 * ONE_HOUR_MS,
      win: () => true,
    });
    const withPlacement = buildLastEventRecapInsight({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
      registryEntry: buildRegistryRow({ placement: 3, numEntrants: 2048 }),
    });
    expect(withPlacement.copy.key).toBe('insights.lastEventRecap.factPlacement');
    expect(withPlacement.copy.values.placement).toBe(3);
    expect(withPlacement.copy.values.entrants).toBe(2048);

    const withoutPlacement = buildLastEventRecapInsight({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
      registryEntry: buildRegistryRow({}),
    });
    expect(withoutPlacement.copy.key).toBe('insights.lastEventRecap.fact');
  });

  it('over a subject with no tournament event returns state === "hidden", and assembleRail given only that result still returns at least one card', () => {
    const matches: Match[] = [
      {
        id: 'no-event',
        fighter_id: SUBJECT_FIGHTER_ID,
        opponent_id: 2,
        time: NOW_MS,
        win: true,
        matchType: 'quickplay',
      },
    ];
    const insights = lastEventRecapTemplate.build({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.state).toBe('hidden');
    const rail = assembleRail({ insights });
    expect(rail.cards.length).toBeGreaterThanOrEqual(1);
  });

  it('over an event whose games have no parsable set id, uses the games-only key and carries no 0–0 set record', () => {
    const matches = buildEventGames({
      eventName: 'Smash @ The Arcade #14',
      setCount: 1,
      gamesPerSet: 5,
      startAt: NOW_MS - 5 * ONE_HOUR_MS,
      win: (_s, g) => g < 3,
      parsableSets: false,
    });
    const insight = buildLastEventRecapInsight({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight.copy.key).toBe('insights.lastEventRecap.factGamesOnly');
    expect(insight.copy.values.setRecord).toBeUndefined();
    expect(insight.copy.values.setRecord).not.toBe('0–0');
  });

  it('SUBJECT_TEMPLATES includes lastEventRecap, and no returned Insight carries a debrief or watchlist door', async () => {
    // Not an exact-length assertion (review disposition C2-L4): Task 3 in this same plan grows
    // this segment further (to 6); the final, exact length is asserted once, in
    // `matchupOrPlayer.test.ts`, from the LAST task to fill this segment.
    const { SUBJECT_TEMPLATES } = await import('./subject.js');
    expect(SUBJECT_TEMPLATES.map((t) => t.id)).toContain('lastEventRecap');
    const matches = buildEventGames({
      eventName: 'Door Check',
      setCount: 1,
      gamesPerSet: 2,
      startAt: NOW_MS - 3 * ONE_HOUR_MS,
      win: () => true,
    });
    const insights = lastEventRecapTemplate.build({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    for (const insight of insights) {
      for (const door of insight.doors) {
        expect(['event', 'games']).toContain(door.kind);
      }
    }
  });
});

/**
 * Plan 39.1-40 (sketch 002-C, UI-SPEC §7.10): the recap card's SetStrip mark
 * and its set-loss sub line. A set whose opponent has no name contributes its
 * record alone — never an English fallback word.
 */
describe('lastEventRecap set strip mark (39.1-40)', () => {
  function recapFor(matches: Match[]) {
    return buildLastEventRecapInsight({
      matches,
      scope: subjectScope(),
      horizon: 'last30',
      nowMs: NOW_MS,
    });
  }

  it('with sets, carries a setStrip mark with one entry per set in set order', () => {
    const games = buildEventGames({
      eventName: 'Strip Check',
      setCount: 3,
      gamesPerSet: 3,
      startAt: NOW_MS - 20 * ONE_HOUR_MS,
      // set 0: W W L (won 2-1), set 1: L L L (lost 0-3), set 2: W L W (won 2-1)
      win: (s, g) => (s === 0 ? g < 2 : s === 1 ? false : g !== 1),
    }).map((match) => (match.id.includes('-2-') ? { ...match, opponent: 'rival' } : match));
    const insight = recapFor(games);
    expect(insight.mark?.kind).toBe('setStrip');
    const data = insight.mark!.data as { sets: unknown[] };
    expect(data.sets).toEqual([
      { setId: expect.any(String), won: true, opponentName: null, gamesWon: 2, gamesLost: 1 },
      { setId: expect.any(String), won: false, opponentName: null, gamesWon: 0, gamesLost: 3 },
      { setId: expect.any(String), won: true, opponentName: 'rival', gamesWon: 2, gamesLost: 1 },
    ]);
  });

  it('without parsable sets, carries no mark', () => {
    const insight = recapFor(
      buildEventGames({
        eventName: 'No Sets',
        setCount: 1,
        gamesPerSet: 4,
        startAt: NOW_MS - 5 * ONE_HOUR_MS,
        win: (_s, g) => g % 2 === 0,
        parsableSets: false,
      }),
    );
    expect(insight.mark).toBeUndefined();
  });

  it('a lost set whose opponent has no name names its record only in the sub value (no fallback word)', () => {
    const games = buildEventGames({
      eventName: 'Unnamed Loss',
      setCount: 2,
      gamesPerSet: 4,
      startAt: NOW_MS - 10 * ONE_HOUR_MS,
      // set 0: W W W L (won 3-1), set 1: W L L L (lost 1-3)
      win: (s, g) => (s === 0 ? g < 3 : g === 0),
    });
    const insight = recapFor(games);
    expect(insight.copy.values.subLineKey).toBe('insights.lastEventRecap.setLosses');
    expect(insight.copy.values.named).toBe('1–3');
    expect(String(insight.copy.values.named)).not.toMatch(/unknown/i);
  });

  it('a lost set whose opponent has a name keeps the name before the record', () => {
    const games = buildEventGames({
      eventName: 'Named Loss',
      setCount: 1,
      gamesPerSet: 3,
      startAt: NOW_MS - 10 * ONE_HOUR_MS,
      win: () => false,
    }).map((match) => ({ ...match, opponent: 'rival' }));
    expect(recapFor(games).copy.values.named).toBe('rival 0–3');
  });
});

describe('lastEventRecap Phase 39.2 extension (plan 39.2-13: structural entry, tier, two-horizon read)', () => {
  const eventGames = buildEventGames({
    eventName: 'Supernova 2026',
    setCount: 3,
    gamesPerSet: 3,
    startAt: NOW_MS - 20 * ONE_HOUR_MS,
    win: (s) => s !== 2,
  });

  /** A live `GET /api/tournaments` row: the shape the Dashboard holds, NOT a `TournamentRegistryRow`. */
  const liveEntry: TournamentEntry = {
    eventName: 'Supernova 2026',
    tournamentName: 'Supernova 2026',
    firstSetAt: NOW_MS - 20 * ONE_HOUR_MS,
    lastSetAt: NOW_MS - 10 * ONE_HOUR_MS,
    setsPlayed: 3,
    placement: 3,
    numEntrants: 2048,
  };

  function build(extra: Partial<Parameters<typeof buildLastEventRecapInsight>[0]> = {}) {
    return buildLastEventRecapInsight({
      matches: eventGames,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
      ...extra,
    });
  }

  it('a TournamentEntry-shaped registry entry enables the placement variant', () => {
    const insight = build({ registryEntry: liveEntry });
    expect(insight.copy.key).toBe('insights.lastEventRecap.factPlacement');
    expect(insight.copy.values.placement).toBe(3);
    expect(insight.copy.values.entrants).toBe(2048);
  });

  it('an entry without an entrant count degrades to the W-L-only key', () => {
    const { numEntrants: _omitted, ...withoutEntrants } = liveEntry;
    void _omitted;
    expect(build({ registryEntry: withoutEntrants }).copy.key).toBe('insights.lastEventRecap.fact');
  });

  it('values are unchanged when no tier is passed, and carry only the two short strings when one is', () => {
    const plain = build({ registryEntry: liveEntry });
    expect(plain.copy.values).not.toHaveProperty('tier');
    expect(plain.copy.values).not.toHaveProperty('tierBasis');
    const tiered = build({
      registryEntry: liveEntry,
      tier: { tier: 'supermajor', basis: 'estimated' },
    });
    expect(tiered.copy.values.tier).toBe('supermajor');
    expect(tiered.copy.values.tierBasis).toBe('estimated');
    expect({ ...tiered.copy.values, tier: undefined, tierBasis: undefined }).toEqual({
      ...plain.copy.values,
      tier: undefined,
      tierBasis: undefined,
    });
    expect(tiered.state).toBe('fact');
    for (const key of ['tier', 'tierBasis']) {
      expect(String(tiered.copy.values[key]).length).toBeLessThanOrEqual(40);
    }
  });

  it('the registered template still builds with no entry and no tier', () => {
    const scope = subjectScope();
    const [insight] = lastEventRecapTemplate.build({
      matches: eventGames,
      scope,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight?.copy.values).not.toHaveProperty('tier');
    expect(insight?.copy.key).toBe('insights.lastEventRecap.fact');
  });

  describe('buildEventHorizonRead', () => {
    function record(total: number, wins: number, offset: number): Match[] {
      return Array.from({ length: total }, (_, i) => ({
        id: `r-${offset}-${i}`,
        fighter_id: SUBJECT_FIGHTER_ID,
        opponent_id: 2,
        time: NOW_MS - (offset + i) * ONE_HOUR_MS,
        win: i < wins,
      })) as Match[];
    }

    it('a 5-game event reads thin: no direction, whatever the rates', () => {
      const event = record(5, 5, 0);
      const history = [...event, ...record(400, 100, 100)];
      const read = buildEventHorizonRead({ eventMatches: event, baselineMatches: history });
      expect(read.state).toBe('thin');
      expect(read.deltaPoints).toBeNull();
      expect(read.recent.total).toBe(5);
      expect(read.baseline.total).toBe(405);
    });

    it('a 2-game event reads locked (below the abstention floor)', () => {
      const event = record(2, 2, 0);
      expect(
        buildEventHorizonRead({
          eventMatches: event,
          baselineMatches: [...event, ...record(200, 100, 50)],
        }).state,
      ).toBe('locked');
    });

    it('a 33-game event well above the norm asserts a direction through classify', () => {
      const event = record(33, 29, 0);
      const history = [...event, ...record(400, 160, 100)];
      const read = buildEventHorizonRead({ eventMatches: event, baselineMatches: history });
      expect(read.state).toBe('trend');
      expect(read.deltaPoints).toBeGreaterThan(0);
    });

    it('an event that is most of the history collapses', () => {
      const event = record(20, 10, 0);
      expect(
        buildEventHorizonRead({
          eventMatches: event,
          baselineMatches: [...event, ...record(5, 2, 50)],
        }).state,
      ).toBe('collapsed');
    });
  });
});

describe('lastEventRecap event identity (39.2-REVIEW SH-CR-01): an event is never a bare name', () => {
  const ONE_DAY_MS = 24 * ONE_HOUR_MS;

  /** Six games of one weekly named "Ultimate Singles" at a distinct tournament, `daysAgo` before NOW. */
  function weekly(index: number, daysAgo: number, win: boolean): Match[] {
    return Array.from({ length: 6 }, (_, g) => ({
      id: `weekly-${index}-g${g}`,
      fighter_id: SUBJECT_FIGHTER_ID,
      opponent_id: 2,
      time: NOW_MS - daysAgo * ONE_DAY_MS + g * ONE_HOUR_MS,
      win,
      matchType: 'offline-tourney' as const,
      eventName: 'Ultimate Singles',
      tournamentName: `Weekly #${index}`,
      externalId: `sgg:weekly-${index}-set${Math.floor(g / 3)}:g${(g % 3) + 1}`,
    }));
  }

  it('ten same-named weeklies: the recap reads the newest weekly only (0–6), never the 60-game pool', () => {
    // Nine won weeklies, a week apart, then a 0–6 at the newest one.
    const matches: Match[] = [];
    for (let i = 0; i < 9; i += 1) {
      matches.push(...weekly(i, 7 * (10 - i), true));
    }
    matches.push(...weekly(9, 1, false));
    const insight = buildLastEventRecapInsight({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
      registryEntry: { placement: 3, numEntrants: 32 },
    });
    expect(insight.copy.values.gameRecord).toBe('0–6');
    expect(insight.copy.values.gameCount).toBe(6);
    expect(insight.countedMatchIds).toHaveLength(6);
    expect(insight.countedMatchIds.every((id) => id.startsWith('weekly-9-'))).toBe(true);
    expect(insight.window.games).toBe(6);
  });

  it('two same-named events at different tournaments on one weekend stay two events', () => {
    const saturday = weekly(1, 2, true);
    const sunday = weekly(2, 1, false);
    const insight = buildLastEventRecapInsight({
      matches: [...saturday, ...sunday],
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insight.copy.values.gameRecord).toBe('0–6');
    expect(insight.countedMatchIds).toHaveLength(6);
  });

  it('the event door names the block window, so it can never widen to another same-named event', () => {
    const matches = [...weekly(0, 14, true), ...weekly(1, 1, false)];
    const insight = buildLastEventRecapInsight({
      matches,
      scope: ACCOUNT_SCOPE,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    const eventDoor = insight.doors.find((door) => door.kind === 'event');
    expect(eventDoor?.count).toBe(6);
    expect(eventDoor?.axes.from).toBe(insight.window.fromMs);
    expect(eventDoor?.axes.to).toBe(insight.window.toMs);
  });
});

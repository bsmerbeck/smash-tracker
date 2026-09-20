import { describe, expect, it } from 'vitest';
import { lastEventRecapTemplate, buildLastEventRecapInsight } from './lastEventRecap.js';
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

import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import {
  DRILL_DOWN_CLAIM_PARAM,
  DRILL_DOWN_EVENT_PARAM,
  DRILL_DOWN_FIGHTER_PARAM,
  DRILL_DOWN_FROM_PARAM,
  DRILL_DOWN_STAGE_PARAM,
  DRILL_DOWN_TO_PARAM,
  DRILL_DOWN_VS_PARAM,
  buildDrillDownSearch,
  matchesDrillDown,
  readDrillDownParams,
  sortMatchesNewestFirst,
  type DrillDownAxes,
} from './drillDownParams';

// Mario (1) / Luigi (10) — real SpriteList ids so `getFighterById` membership
// checks inside `readDrillDownParams` actually resolve during these tests.
const MARIO = 1;
const LUIGI = 10;
// A real stage id used across the app's own fixtures (Battlefield).
const BATTLEFIELD = 1;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: MARIO,
    opponent_id: LUIGI,
    time: 1000,
    win: true,
    ...overrides,
  } as Match;
}

describe('parseIntegerAxis (via readDrillDownParams)', () => {
  const stageIds = new Set([BATTLEFIELD]);

  it('ignores a non-numeric stage value and leaves the axis unset', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_STAGE_PARAM]: 'not-a-number' });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.stageId).toBeUndefined();
  });

  it('ignores a fractional stage value and leaves the axis unset', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_STAGE_PARAM]: '1.5' });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.stageId).toBeUndefined();
  });

  it('ignores a stage value naming no known stage and leaves the axis unset', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_STAGE_PARAM]: '999999' });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.stageId).toBeUndefined();
  });

  it('accepts a stage value naming a real stage', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_STAGE_PARAM]: String(BATTLEFIELD) });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.stageId).toBe(BATTLEFIELD);
  });

  it('WR-01 (38-REVIEW-FIX): accepts stage=0, the unknown-stage sentinel, even though stageIds never contains it', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_STAGE_PARAM]: '0' });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.stageId).toBe(0);
  });

  it('ignores a fighter value naming no known fighter', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_FIGHTER_PARAM]: '999999' });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.fighterId).toBeUndefined();
  });

  it('accepts fighter and opposing-character params naming real fighters', () => {
    const params = new URLSearchParams({
      [DRILL_DOWN_FIGHTER_PARAM]: String(MARIO),
      [DRILL_DOWN_VS_PARAM]: String(LUIGI),
    });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.fighterId).toBe(MARIO);
    expect(axes.vsFighterId).toBe(LUIGI);
  });

  it('accepts an event anchor key verbatim', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_EVENT_PARAM]: 'genesis-12' });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.eventKey).toBe('genesis-12');
  });

  it('accepts from/to window bounds', () => {
    const params = new URLSearchParams({
      [DRILL_DOWN_FROM_PARAM]: '1000',
      [DRILL_DOWN_TO_PARAM]: '2000',
    });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.from).toBe(1000);
    expect(axes.to).toBe(2000);
  });
});

describe('claim axis (plan 39.1-19, DD-09 accepted)', () => {
  const stageIds = new Set([BATTLEFIELD]);

  it('accepts a well-formed Insight.id verbatim', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_CLAIM_PARAM]: 'formNow:account:last30' });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.claimId).toBe('formNow:account:last30');
  });

  it('accepts a scopeKey carrying an arbitrary player tag (unicode, space, apostrophe, hash)', () => {
    const tag = "player:O'Brien 42#1234 ゲーム";
    const params = new URLSearchParams({ [DRILL_DOWN_CLAIM_PARAM]: `formNow:${tag}:last30` });
    const axes = readDrillDownParams(params, { stageIds });
    expect(axes.claimId).toBe(`formNow:${tag}:last30`);
  });

  it('resolves an empty claim value to the axis being absent, never a throw', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_CLAIM_PARAM]: '' });
    expect(() => readDrillDownParams(params, { stageIds })).not.toThrow();
    expect(readDrillDownParams(params, { stageIds }).claimId).toBeUndefined();
  });

  it('resolves a malformed claim value (disallowed characters) to the axis being absent, never a throw', () => {
    const params = new URLSearchParams({
      [DRILL_DOWN_CLAIM_PARAM]: '<script>alert(1)</script>',
    });
    expect(() => readDrillDownParams(params, { stageIds })).not.toThrow();
    expect(readDrillDownParams(params, { stageIds }).claimId).toBeUndefined();
  });

  it('resolves an over-length claim value to the axis being absent, never a throw', () => {
    const params = new URLSearchParams({ [DRILL_DOWN_CLAIM_PARAM]: 'a'.repeat(301) });
    expect(() => readDrillDownParams(params, { stageIds })).not.toThrow();
    expect(readDrillDownParams(params, { stageIds }).claimId).toBeUndefined();
  });

  it('round-trips through buildDrillDownSearch', () => {
    const axes: DrillDownAxes = { claimId: 'formNow:account:last30' };
    const search = buildDrillDownSearch(axes);
    expect(search.get(DRILL_DOWN_CLAIM_PARAM)).toBe('formNow:account:last30');
    expect(readDrillDownParams(search, { stageIds }).claimId).toBe('formNow:account:last30');
  });

  it('matchesDrillDown never examines the claim axis — resolution happens at the consumer, not here', () => {
    const match = makeMatch();
    // A claim axis with no bearing on any Match field: matchesDrillDown must
    // still resolve purely on the OTHER (absent) axes and match everything.
    expect(matchesDrillDown(match, { claimId: 'formNow:account:last30' })).toBe(true);
  });
});

describe('matchesDrillDown', () => {
  it('matches every game when axes is empty', () => {
    const match = makeMatch();
    expect(matchesDrillDown(match, {})).toBe(true);
  });

  it('narrows by the character axes', () => {
    const match = makeMatch({ fighter_id: MARIO, opponent_id: LUIGI });
    expect(matchesDrillDown(match, { fighterId: MARIO })).toBe(true);
    expect(matchesDrillDown(match, { fighterId: LUIGI })).toBe(false);
    expect(matchesDrillDown(match, { vsFighterId: LUIGI })).toBe(true);
    expect(matchesDrillDown(match, { vsFighterId: MARIO })).toBe(false);
  });

  it('narrows by the stage axis', () => {
    const match = makeMatch({ map: { id: BATTLEFIELD, name: 'Battlefield' } });
    expect(matchesDrillDown(match, { stageId: BATTLEFIELD })).toBe(true);
    expect(matchesDrillDown(match, { stageId: 999 })).toBe(false);
  });

  it('narrows by the event axis via the supplied resolver', () => {
    const match = makeMatch({ id: 'm1' });
    const resolver = (m: Match) => (m.id === 'm1' ? 'genesis-12' : undefined);
    expect(matchesDrillDown(match, { eventKey: 'genesis-12' }, resolver)).toBe(true);
    expect(matchesDrillDown(match, { eventKey: 'other' }, resolver)).toBe(false);
    // No resolver supplied at all — an event axis can never match.
    expect(matchesDrillDown(match, { eventKey: 'genesis-12' })).toBe(false);
  });

  it('an inclusive window whose start equals its end returns EVERY game at that instant', () => {
    const axes: DrillDownAxes = { from: 5000, to: 5000 };
    const exact1 = makeMatch({ id: 'a', time: 5000 });
    const exact2 = makeMatch({ id: 'b', time: 5000 });
    const before = makeMatch({ id: 'c', time: 4999 });
    const after = makeMatch({ id: 'd', time: 5001 });
    expect(matchesDrillDown(exact1, axes)).toBe(true);
    expect(matchesDrillDown(exact2, axes)).toBe(true);
    expect(matchesDrillDown(before, axes)).toBe(false);
    expect(matchesDrillDown(after, axes)).toBe(false);
  });

  it('includes a game exactly at the window start and one exactly at the window end', () => {
    const axes: DrillDownAxes = { from: 1000, to: 2000 };
    expect(matchesDrillDown(makeMatch({ time: 1000 }), axes)).toBe(true);
    expect(matchesDrillDown(makeMatch({ time: 2000 }), axes)).toBe(true);
    expect(matchesDrillDown(makeMatch({ time: 999 }), axes)).toBe(false);
    expect(matchesDrillDown(makeMatch({ time: 2001 }), axes)).toBe(false);
  });
});

describe('buildDrillDownSearch', () => {
  it('omits undefined axes', () => {
    const search = buildDrillDownSearch({ fighterId: MARIO });
    expect(search.get(DRILL_DOWN_FIGHTER_PARAM)).toBe(String(MARIO));
    expect(search.has(DRILL_DOWN_VS_PARAM)).toBe(false);
    expect(search.has(DRILL_DOWN_STAGE_PARAM)).toBe(false);
  });

  it('round-trips every axis', () => {
    const axes: DrillDownAxes = {
      fighterId: MARIO,
      vsFighterId: LUIGI,
      stageId: BATTLEFIELD,
      eventKey: 'genesis-12',
      from: 1000,
      to: 2000,
    };
    const search = buildDrillDownSearch(axes);
    const roundTripped = readDrillDownParams(search, { stageIds: new Set([BATTLEFIELD]) });
    expect(roundTripped).toEqual(axes);
  });
});

describe('sortMatchesNewestFirst', () => {
  it('sorts descending by time', () => {
    const a = makeMatch({ id: 'a', time: 100 });
    const b = makeMatch({ id: 'b', time: 300 });
    const c = makeMatch({ id: 'c', time: 200 });
    expect(sortMatchesNewestFirst([a, b, c]).map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks an identical-time tie with an ASCENDING id order, regardless of input order', () => {
    const m2 = makeMatch({ id: 'm2', time: 500 });
    const m1 = makeMatch({ id: 'm1', time: 500 });
    // Input order is m2 then m1 — a plain stable sort on `time` alone would
    // preserve that order. The tiebreak must override it.
    expect(sortMatchesNewestFirst([m2, m1]).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('never mutates the input array', () => {
    const a = makeMatch({ id: 'a', time: 100 });
    const b = makeMatch({ id: 'b', time: 200 });
    const input = [a, b];
    sortMatchesNewestFirst(input);
    expect(input).toEqual([a, b]);
  });
});

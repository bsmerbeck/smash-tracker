import { describe, expect, it } from 'vitest';
import { INSIGHT_TEMPLATES } from './registry.js';
import type { InsightTemplate } from './registry.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type { Insight, InsightScope, InsightTemplateId } from '../types.js';
import type { Match } from '../../match.js';
import {
  emptyWorkspace,
  oneGameWorkspace,
  twoGameWorkspace,
  unknownStageOnlyWorkspace,
  unknownCharacterOnlyWorkspace,
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
} from '../../testUtils/index.js';

/**
 * Phase 39.1 plan 39.1-22 (gap closure, orchestrator Finding 8, INS-03/
 * INS-06): proves, for ALL 17 registered templates, that `Insight.
 * countedMatchIds` — the new single source of truth for "which games did
 * this card count" — is a real, exact, deterministic set. Iterates
 * `INSIGHT_TEMPLATES` itself (never a hand-written list), mirroring
 * `conformance.test.ts`'s and `insightDoorSameN.test.tsx`'s own registry-
 * driven style.
 */

const NOW_MS = 1_700_100_000_000;
const SUBJECT_FIGHTER_ID = 8; // Fox — a default main in EIGHT_K_FIXTURE_OPTIONS.
const OPPONENT_FIGHTER_ID = 2;
const HOUR = 60 * 60 * 1000;

function accountScope(): InsightScope {
  return ACCOUNT_SCOPE;
}

function characterScope(fighterId: number = SUBJECT_FIGHTER_ID): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}`,
    axes: { fighter: fighterId },
    filter: (matches) => matches.filter((m) => m.fighter_id === fighterId),
  };
}

/** Matches `conformance.test.ts`'s own `scopeFor` — every registered template is either account- or character-scoped today. */
function scopeFor(template: InsightTemplate): InsightScope {
  return template.scopeKind === 'character' ? characterScope() : accountScope();
}

const eightK = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);

/** Ported from `insightDoorSameN.test.tsx` (apps/web) — a shared-package test cannot import an apps/web test file, so the SAME fixture-construction recipe is duplicated here for `lastEventRecap`, whose games are one named event, not reachable via the plain 8k fixture. */
function buildLastEventRecapFixture(): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < 5; i += 1) {
    matches.push({
      id: `ler-${i}`,
      fighter_id: SUBJECT_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (5 - i) * HOUR,
      win: i % 2 === 0,
      eventName: 'Genesis 12',
    } as Match);
  }
  return matches;
}

/** Ported from `insightDoorSameN.test.tsx` — engineers a genuine >=15-pt match-type share shift so `mixShift` asserts a real `fact` result. */
function buildMixShiftFixture(): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < 70; i += 1) {
    matches.push({
      id: `mix-old-${i}`,
      fighter_id: SUBJECT_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (1000 - i) * HOUR,
      win: i % 2 === 0,
      matchType: 'offline-tourney',
    } as Match);
  }
  for (let i = 0; i < 30; i += 1) {
    matches.push({
      id: `mix-recent-${i}`,
      fighter_id: SUBJECT_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (30 - i) * HOUR,
      win: i % 2 === 0,
      matchType: 'quickplay',
    } as Match);
  }
  return matches;
}

const ROSTER_SHIFT_BASELINE_FIGHTER_ID = 9;
const ROSTER_SHIFT_RECENT_FIGHTER_ID = 20;

/** Ported from `insightDoorSameN.test.tsx` — engineers a genuine roster-share shift so `rosterShift` asserts a real `trend` result. */
function buildRosterShiftFixture(): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < 200; i += 1) {
    matches.push({
      id: `rs-base-${i}`,
      fighter_id: ROSTER_SHIFT_BASELINE_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (1000 - i) * HOUR,
      win: i % 2 === 0,
      matchType: 'offline-tourney',
    } as Match);
  }
  for (let i = 0; i < 30; i += 1) {
    matches.push({
      id: `rs-recent-${i}`,
      fighter_id: ROSTER_SHIFT_RECENT_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (30 - i) * HOUR,
      win: i % 2 === 0,
      matchType: 'quickplay',
    } as Match);
  }
  return matches;
}

/** One real (non-thin) fixture per registered template — the SET this suite iterates is `INSIGHT_TEMPLATES` itself (asserted below), never a hand-written array. Mirrors `insightDoorSameN.test.tsx`'s own `FIXTURES` map. */
const FIXTURES: Record<InsightTemplateId, Match[]> = {
  formNow: eightK,
  characterMovers: eightK,
  rivalMovers: eightK,
  lastEventRecap: buildLastEventRecapFixture(),
  bestMatchup: eightK,
  worstMatchup: eightK,
  matchupOrPlayer: eightK,
  tiltCost: eightK,
  sessionFatigue: eightK,
  settingGap: eightK,
  ratingMove: eightK,
  volumeForm: eightK,
  mixShift: buildMixShiftFixture(),
  rosterCore: eightK,
  rosterShift: buildRosterShiftFixture(),
  secondaryPayoff: eightK,
  pocketCost: eightK,
};

const THIN_FIXTURES: ReadonlyArray<readonly [string, () => Match[]]> = [
  ['emptyWorkspace', emptyWorkspace],
  ['oneGameWorkspace', oneGameWorkspace],
  ['twoGameWorkspace', twoGameWorkspace],
  ['unknownStageOnlyWorkspace', unknownStageOnlyWorkspace],
  ['unknownCharacterOnlyWorkspace', unknownCharacterOnlyWorkspace],
];

interface ExactnessResult {
  valid: boolean;
  reason: string;
}

/**
 * The one exactness predicate this whole suite is built around (never
 * duplicated inline in a test body): (a) no duplicate ids, (b) every id is
 * present in `scopedMatches` (the template's own scope-filtered input — a
 * template must never invent or leak an id from outside its own scope), (c)
 * `countedMatchIds.length === insight.window.games` — the SAME invariant for
 * every template and every state, since every zero-games state (hidden, or a
 * locked branch that reports `window.games: 0`) trivially satisfies `0 ===
 * 0` when `countedMatchIds` is correctly `[]`.
 */
function checkCountedMatchIdsExact(insight: Insight, scopedMatches: Match[]): ExactnessResult {
  const { countedMatchIds } = insight;
  if (!Array.isArray(countedMatchIds)) {
    return { valid: false, reason: 'countedMatchIds is not an array' };
  }
  const idSet = new Set(countedMatchIds);
  if (idSet.size !== countedMatchIds.length) {
    return { valid: false, reason: 'countedMatchIds contains a duplicate id' };
  }
  const scopedIds = new Set(scopedMatches.map((m) => m.id));
  for (const id of countedMatchIds) {
    if (!scopedIds.has(id)) {
      return { valid: false, reason: `countedMatchIds contains id "${id}" not in scoped matches` };
    }
  }
  if (countedMatchIds.length !== insight.window.games) {
    return {
      valid: false,
      reason: `countedMatchIds.length (${countedMatchIds.length}) !== window.games (${insight.window.games})`,
    };
  }
  return { valid: true, reason: 'ok' };
}

describe('registry coverage', () => {
  it('FIXTURES covers exactly the registered templates', () => {
    expect(new Set(Object.keys(FIXTURES))).toEqual(new Set(INSIGHT_TEMPLATES.map((t) => t.id)));
  });
});

describe.each(INSIGHT_TEMPLATES.map((t) => t.id))('template %s', (templateId) => {
  const template = INSIGHT_TEMPLATES.find((t) => t.id === templateId)!;

  it('records an exact, honest countedMatchIds on its real fixture', () => {
    const matches = FIXTURES[templateId];
    const scope = scopeFor(template);
    const scopedMatches = scope.filter(matches);
    const insights = template.build({ matches, scope, horizon: 'last30', nowMs: NOW_MS });
    expect(
      insights.length,
      `${templateId} must produce at least one Insight on its fixture`,
    ).toBeGreaterThan(0);
    for (const insight of insights) {
      const result = checkCountedMatchIdsExact(insight, scopedMatches);
      expect(result.valid, `${templateId}: ${result.reason}`).toBe(true);
    }
  });

  it('is deterministic — building twice yields identical id arrays in identical order', () => {
    const matches = FIXTURES[templateId];
    const scope = scopeFor(template);
    const first = template.build({ matches, scope, horizon: 'last30', nowMs: NOW_MS });
    const second = template.build({ matches, scope, horizon: 'last30', nowMs: NOW_MS });
    expect(second.map((i) => i.countedMatchIds)).toEqual(first.map((i) => i.countedMatchIds));
  });

  it.each(THIN_FIXTURES)('holds over the %s FIXT-02 sparse fixture', (_name, buildFixture) => {
    const matches = buildFixture();
    const scope = scopeFor(template);
    const scopedMatches = scope.filter(matches);
    const insights = template.build({ matches, scope, horizon: 'last30', nowMs: NOW_MS });
    for (const insight of insights) {
      const result = checkCountedMatchIdsExact(insight, scopedMatches);
      expect(result.valid, `${templateId}: ${result.reason}`).toBe(true);
    }
  });
});

describe('non-vacuity: a corrupted template fails assertion (c)', () => {
  it('a countedMatchIds array missing one id is caught by checkCountedMatchIdsExact', () => {
    const matches = FIXTURES.formNow;
    const scope = accountScope();
    const scopedMatches = scope.filter(matches);
    const insights = formNowTemplateForCorruption().build({
      matches,
      scope,
      horizon: 'last30',
      nowMs: NOW_MS,
    });
    expect(insights.length).toBeGreaterThan(0);
    const corrupted: Insight = {
      ...insights[0]!,
      countedMatchIds: insights[0]!.countedMatchIds.slice(1), // drop one id
    };
    const result = checkCountedMatchIdsExact(corrupted, scopedMatches);
    expect(result.valid, 'the corrupted insight must be reported invalid').toBe(false);
    expect(result.reason).toMatch(/window\.games/);
  });
});

/** A test-local reference to the real formNow template — isolated into its own function so the corruption above is visibly confined to a COPY of the result, never a change to the shipped template. */
function formNowTemplateForCorruption(): InsightTemplate {
  return INSIGHT_TEMPLATES.find((t) => t.id === 'formNow')!;
}

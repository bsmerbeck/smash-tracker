import { describe, expect, it } from 'vitest';
import { TOURNAMENT_LEGAL_STAGE_IDS } from './stageData.js';
import {
  DEFAULT_RULESET,
  DEFAULT_SET_STATE,
  RULESET_CONTRACT_VERSION,
  legalStagesFor,
  resolveRuleset,
  stageIdKey,
  stageIdsFromPresenceMap,
  type Ruleset,
  type RulesetOverrideStored,
  type SetState,
} from './ruleset.js';

/**
 * The tracer's own gate (R1-MEDIUM-4): this task LANDS the file with a real
 * green run, rather than deferring every assertion to plan 37-04's Task 2 —
 * the four `resolveRuleset` cases from Task 1's own `<behavior>` list, plus
 * a round trip through `stageIdKey`/`stageIdsFromPresenceMap`. Task 2 of
 * this plan APPENDS the pinned-preset assertions and the full
 * `legalStagesFor` matrix to this same file.
 */
describe('stageIdKey / stageIdsFromPresenceMap', () => {
  it('round-trips an arbitrary id set back to the same ids, ascending', () => {
    const ids = [118, 1, 59];
    const map: Record<string, true> = {};
    for (const id of ids) {
      map[stageIdKey(id)] = true;
    }
    expect(stageIdsFromPresenceMap(map)).toEqual([1, 59, 118]);
  });

  it("stageIdKey's first character is never a digit", () => {
    expect(/^\d/.test(stageIdKey(113))).toBe(false);
  });

  it('tolerates a missing/undefined map', () => {
    expect(stageIdsFromPresenceMap(undefined)).toEqual([]);
    expect(stageIdsFromPresenceMap(null)).toEqual([]);
  });
});

describe('resolveRuleset', () => {
  it('a missing override resolves to the default preset', () => {
    const resolved = resolveRuleset(undefined);
    expect(resolved.source).toBe('default-preset');
    expect(resolved.ignoredOverrideReason).toBeNull();
    expect(resolved.ruleset).toEqual(DEFAULT_RULESET);
  });

  it('an override that declares only a DSR variant replaces that variant and inherits everything else', () => {
    const override: RulesetOverrideStored = {
      contractVersion: RULESET_CONTRACT_VERSION,
      dsr: 'none',
    };
    const resolved = resolveRuleset(override);
    expect(resolved.source).toBe('event-override');
    expect(resolved.ignoredOverrideReason).toBeNull();
    expect(resolved.ruleset.dsr).toBe('none');
    expect(resolved.ruleset.starterStageIds).toEqual(DEFAULT_RULESET.starterStageIds);
    expect(resolved.ruleset.counterpickStageIds).toEqual(DEFAULT_RULESET.counterpickStageIds);
    expect(resolved.ruleset.banCounts).toEqual(DEFAULT_RULESET.banCounts);
    expect(resolved.ruleset.strikeOrder).toBe(DEFAULT_RULESET.strikeOrder);
    expect(resolved.ruleset.setFormat).toEqual(DEFAULT_RULESET.setFormat);
  });

  it('an override whose contractVersion exceeds the running contract version is ignored whole', () => {
    const override: RulesetOverrideStored = {
      contractVersion: RULESET_CONTRACT_VERSION + 1,
      dsr: 'none',
    };
    const resolved = resolveRuleset(override);
    expect(resolved.source).toBe('default-preset');
    expect(resolved.ignoredOverrideReason).toBe('unsupported-contract-version');
    expect(resolved.ruleset.dsr).toBe(DEFAULT_RULESET.dsr);
  });

  it('an override declaring no members at all resolves to the preset and reports it as the source', () => {
    const override: RulesetOverrideStored = { contractVersion: RULESET_CONTRACT_VERSION };
    const resolved = resolveRuleset(override);
    expect(resolved.source).toBe('default-preset');
    expect(resolved.ignoredOverrideReason).toBeNull();
    expect(resolved.ruleset).toEqual(DEFAULT_RULESET);
  });

  it('a stage id declared in both stage maps resolves as a starter only', () => {
    const collisionId = DEFAULT_RULESET.counterpickStageIds[0]!;
    const override: RulesetOverrideStored = {
      contractVersion: RULESET_CONTRACT_VERSION,
      starterStageIds: { [stageIdKey(collisionId)]: true },
      counterpickStageIds: { [stageIdKey(collisionId)]: true },
    };
    const resolved = resolveRuleset(override);
    expect(resolved.ruleset.starterStageIds).toContain(collisionId);
    expect(resolved.ruleset.counterpickStageIds).not.toContain(collisionId);
  });
});

/**
 * The pinned oracle (Task 2, mirrors `evidence/budgets.guard.test.ts`'s
 * committed-oracle convention). Before this test, the preset's contents were
 * enforced by nothing but a doc comment — an edit to a stage list would be
 * an invisible change to what every recommendation was computed under. This
 * pins `DEFAULT_RULESET` by exact id arrays (not lengths), so a future edit
 * is a deliberate, reviewed diff.
 */
describe('DEFAULT_RULESET — pinned oracle', () => {
  it('pins the exact starter and counterpick stage id lists', () => {
    expect(DEFAULT_RULESET.starterStageIds).toEqual([1, 3, 59, 83, 85, 113, 118]);
    expect(DEFAULT_RULESET.counterpickStageIds).toEqual([34, 56, 63, 115]);
  });

  it('pins the ban counts, DSR variant, and set format', () => {
    expect(DEFAULT_RULESET.banCounts).toEqual({ bo3: 1, bo5: 2 });
    expect(DEFAULT_RULESET.dsr).toBe('modified');
    expect(DEFAULT_RULESET.setFormat).toEqual({ default: 'bo3', topCut: 'bo5' });
  });

  it('the two lists are disjoint, both ascending, and their union equals the tournament-legal id set', () => {
    const starters = DEFAULT_RULESET.starterStageIds;
    const counterpicks = DEFAULT_RULESET.counterpickStageIds;
    expect([...starters].sort((a, b) => a - b)).toEqual(starters);
    expect([...counterpicks].sort((a, b) => a - b)).toEqual(counterpicks);
    expect(starters.filter((id) => counterpicks.includes(id))).toEqual([]);
    const union = new Set([...starters, ...counterpicks]);
    expect(union).toEqual(new Set(TOURNAMENT_LEGAL_STAGE_IDS));
  });

  it('carries the house marker in its id, and a source URL + retrieval date', () => {
    expect(DEFAULT_RULESET.id).toContain('house');
    expect(DEFAULT_RULESET.source.url.length).toBeGreaterThan(0);
    expect(DEFAULT_RULESET.source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * The assumption-delta invariant (37-04-PLAN.md's `invariant_test`):
 * `resolveRuleset` round-trips for BOTH variants — no override, an override
 * — and in every case the resolved starter/counterpick lists are disjoint
 * and ascending.
 */
describe('resolveRuleset — assumption-delta invariant', () => {
  function assertDisjointAscending(ruleset: Ruleset) {
    const { starterStageIds, counterpickStageIds } = ruleset;
    expect([...starterStageIds].sort((a, b) => a - b)).toEqual(starterStageIds);
    expect([...counterpickStageIds].sort((a, b) => a - b)).toEqual(counterpickStageIds);
    expect(starterStageIds.filter((id) => counterpickStageIds.includes(id))).toEqual([]);
  }

  it('no-override case', () => {
    assertDisjointAscending(resolveRuleset(undefined).ruleset);
  });

  it('override case (both-lists collision included)', () => {
    const collisionId = DEFAULT_RULESET.starterStageIds[0]!;
    const override: RulesetOverrideStored = {
      contractVersion: RULESET_CONTRACT_VERSION,
      starterStageIds: { [stageIdKey(collisionId)]: true },
      counterpickStageIds: { [stageIdKey(collisionId)]: true },
    };
    assertDisjointAscending(resolveRuleset(override).ruleset);
  });
});

describe('legalStagesFor', () => {
  it('at game one, the legal set is exactly the starters', () => {
    expect(legalStagesFor(DEFAULT_RULESET, DEFAULT_SET_STATE)).toEqual(
      DEFAULT_RULESET.starterStageIds,
    );
  });

  it('from game two onward with no bans, the legal set is the ascending union of both stage lists', () => {
    const setState: SetState = { ...DEFAULT_SET_STATE, phase: 'game2plus' };
    const expected = [...DEFAULT_RULESET.starterStageIds, ...DEFAULT_RULESET.counterpickStageIds]
      .slice()
      .sort((a, b) => a - b);
    expect(legalStagesFor(DEFAULT_RULESET, setState)).toEqual(expected);
  });

  it('every banned id is removed at game one', () => {
    const bannedId = DEFAULT_RULESET.starterStageIds[0]!;
    const setState: SetState = { ...DEFAULT_SET_STATE, bannedStageIds: [bannedId] };
    expect(legalStagesFor(DEFAULT_RULESET, setState)).not.toContain(bannedId);
  });

  it('under the modified DSR variant, phase game-two, role picking: only the LATER of two prior wins is removed', () => {
    const [earlyWin, laterWin] = DEFAULT_RULESET.starterStageIds;
    const setState: SetState = {
      ...DEFAULT_SET_STATE,
      phase: 'game2plus',
      role: 'picking',
      priorStages: [
        { stageId: earlyWin!, won: true },
        { stageId: laterWin!, won: true },
      ],
    };
    const legal = legalStagesFor(DEFAULT_RULESET, setState);
    expect(legal).not.toContain(laterWin);
    expect(legal).toContain(earlyWin);
  });

  it('under the standard DSR variant, every prior win is removed', () => {
    const ruleset: Ruleset = { ...DEFAULT_RULESET, dsr: 'standard' };
    const [earlyWin, laterWin] = DEFAULT_RULESET.starterStageIds;
    const setState: SetState = {
      ...DEFAULT_SET_STATE,
      phase: 'game2plus',
      role: 'picking',
      priorStages: [
        { stageId: earlyWin!, won: true },
        { stageId: laterWin!, won: true },
      ],
    };
    const legal = legalStagesFor(ruleset, setState);
    expect(legal).not.toContain(earlyWin);
    expect(legal).not.toContain(laterWin);
  });

  it('under the no-DSR variant, neither prior win is removed', () => {
    const ruleset: Ruleset = { ...DEFAULT_RULESET, dsr: 'none' };
    const [earlyWin, laterWin] = DEFAULT_RULESET.starterStageIds;
    const setState: SetState = {
      ...DEFAULT_SET_STATE,
      phase: 'game2plus',
      role: 'picking',
      priorStages: [
        { stageId: earlyWin!, won: true },
        { stageId: laterWin!, won: true },
      ],
    };
    const legal = legalStagesFor(ruleset, setState);
    expect(legal).toContain(earlyWin);
    expect(legal).toContain(laterWin);
  });

  it('no DSR removal happens at game one, even with prior wins recorded', () => {
    const winStage = DEFAULT_RULESET.starterStageIds[0]!;
    const setState: SetState = {
      ...DEFAULT_SET_STATE,
      role: 'picking',
      priorStages: [{ stageId: winStage, won: true }],
    };
    expect(legalStagesFor(DEFAULT_RULESET, setState)).toContain(winStage);
  });

  it('no DSR removal happens when the role is striking', () => {
    const winStage = DEFAULT_RULESET.starterStageIds[0]!;
    const setState: SetState = {
      ...DEFAULT_SET_STATE,
      phase: 'game2plus',
      role: 'striking',
      priorStages: [{ stageId: winStage, won: true }],
    };
    expect(legalStagesFor(DEFAULT_RULESET, setState)).toContain(winStage);
  });

  it('a banned id that is also a prior-won stage under the modified variant appears zero times, and no other id is removed as a side effect', () => {
    const [bannedAndWon, otherStarter] = DEFAULT_RULESET.starterStageIds;
    const setState: SetState = {
      ...DEFAULT_SET_STATE,
      phase: 'game2plus',
      role: 'picking',
      bannedStageIds: [bannedAndWon!],
      priorStages: [{ stageId: bannedAndWon!, won: true }],
    };
    const legal = legalStagesFor(DEFAULT_RULESET, setState);
    expect(legal.filter((id) => id === bannedAndWon)).toEqual([]);
    expect(legal).toContain(otherStarter);
  });

  it('the result is strictly ascending with no duplicate', () => {
    const setState: SetState = { ...DEFAULT_SET_STATE, phase: 'game2plus' };
    const legal = legalStagesFor(DEFAULT_RULESET, setState);
    expect([...new Set(legal)]).toEqual(legal);
    expect([...legal].sort((a, b) => a - b)).toEqual(legal);
  });

  it('an override declaring an empty starter presence map yields an empty legal set at game one', () => {
    const override: RulesetOverrideStored = {
      contractVersion: RULESET_CONTRACT_VERSION,
      starterStageIds: {},
    };
    const resolved = resolveRuleset(override);
    expect(resolved.ruleset.starterStageIds).toEqual([]);
    expect(legalStagesFor(resolved.ruleset, DEFAULT_SET_STATE)).toEqual([]);
  });
});

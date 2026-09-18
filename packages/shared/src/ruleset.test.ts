import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULESET,
  RULESET_CONTRACT_VERSION,
  resolveRuleset,
  stageIdKey,
  stageIdsFromPresenceMap,
  type RulesetOverrideStored,
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

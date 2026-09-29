import { describe, expect, it } from 'vitest';
import { assembleRail, isRailFallbackInsight } from './rail.js';
import type { Insight, InsightState, InsightTemplateId } from './types.js';

const NOW_MS = 1_700_100_000_000;

function makeInsight(overrides: Partial<Insight> = {}): Insight {
  const total = 10;
  return {
    id:
      overrides.id ??
      `${overrides.templateId ?? 'formNow'}:${overrides.scopeKey ?? 'account'}:last30`,
    templateId: (overrides.templateId ?? 'formNow') as InsightTemplateId,
    scopeKey: overrides.scopeKey ?? 'account',
    horizon: 'last30',
    kind: 'fact',
    state: (overrides.state ?? 'fact') as InsightState,
    recent: {
      kind: 'evidenced',
      claimType: 'fact',
      value: { wins: 5, losses: 5, total, rate: 0.5 },
      sample: {
        rawSampleSize: total,
        eligibleDenominator: total,
        knownFieldCoverage: 1,
        dateRange: { firstMs: NOW_MS - 1000, lastMs: NOW_MS },
        refreshedAt: NOW_MS,
        evidencePolicyVersion: 1,
        recencyTreatment: 'unweighted',
        confidenceTier: 'low',
      },
    },
    baseline: {
      kind: 'evidenced',
      claimType: 'fact',
      value: { wins: 5, losses: 5, total, rate: 0.5 },
      sample: {
        rawSampleSize: total,
        eligibleDenominator: total,
        knownFieldCoverage: 1,
        dateRange: { firstMs: NOW_MS - 1000, lastMs: NOW_MS },
        refreshedAt: NOW_MS,
        evidencePolicyVersion: 1,
        recencyTreatment: 'unweighted',
        confidenceTier: 'low',
      },
    },
    deltaPoints: null,
    window: { horizon: 'last30', fromMs: NOW_MS - 1000, toMs: NOW_MS, games: total, scoped: false },
    salience: 0,
    copy: { key: 'insights.formNow.fact', values: {} },
    doors: [],
    countedMatchIds: [],
    ...overrides,
  };
}

function assertiveInsight(id: string, salience: number, deltaPoints = 10): Insight {
  return makeInsight({
    id,
    templateId: 'formNow',
    scopeKey: id,
    state: 'trend',
    kind: 'inference',
    deltaPoints,
    salience,
  });
}

function factInsight(id: string, salience: number): Insight {
  return makeInsight({ id, templateId: 'bestMatchup', scopeKey: id, state: 'fact', salience });
}

function lockedInsight(id: string, salience: number, gamesNeeded = 1): Insight {
  return makeInsight({
    id,
    templateId: 'formNow',
    scopeKey: id,
    state: 'locked',
    deltaPoints: null,
    gamesNeeded,
    salience,
    recent: {
      kind: 'abstained',
      claimType: 'fact',
      reason: 'insufficient-sample',
      sample: {
        rawSampleSize: 3 - gamesNeeded,
        eligibleDenominator: 3 - gamesNeeded,
        knownFieldCoverage: 1,
        dateRange: null,
        refreshedAt: NOW_MS,
        evidencePolicyVersion: 1,
        recencyTreatment: 'unweighted',
        confidenceTier: null,
      },
      gamesNeeded,
    },
  });
}

function lineInsight(id: string, state: 'steady' | 'thinRecent', salience: number): Insight {
  return makeInsight({ id, templateId: 'formNow', scopeKey: id, state, salience });
}

describe('assembleRail', () => {
  it('returns exactly 3 cards and a promotionQueue of length 1 over 4 assertive candidates', () => {
    const insights = [
      assertiveInsight('a', 40),
      assertiveInsight('b', 30),
      assertiveInsight('c', 20),
      assertiveInsight('d', 10),
    ];
    const result = assembleRail({ insights });
    expect(result.cards).toHaveLength(3);
    expect(result.promotionQueue).toHaveLength(1);
    expect(result.promotionQueue[0]!.id).toBe('d');
  });

  it('returns exactly 1 card — the merged UnlocksNext with 3 meters — over 0 assertive and 3 locked candidates', () => {
    const insights = [lockedInsight('l1', 30), lockedInsight('l2', 20), lockedInsight('l3', 10)];
    const result = assembleRail({ insights });
    expect(result.cards).toHaveLength(1);
    expect(result.unlocksNext).not.toBeNull();
    expect(result.unlocksNext!.meters).toHaveLength(3);
  });

  it("CR-A01: a merged UnlocksNext meter uses EACH locked insight's own requirement, never a hardcoded floor", () => {
    // `lockedInsight`'s `eligibleDenominator` is `3 - gamesNeeded` (this
    // fixture's own baked-in "floor is always 3" assumption) — to exercise a
    // DIFFERENT floor (e.g. COHORT_MIN_SIDE_GAMES = 8), override
    // `recent.sample.eligibleDenominator` directly on top of `lockedInsight`.
    const threeFloor = lockedInsight('l1', 30, 1); // eligibleDenominator: 2, gamesNeeded: 1 -> need 3
    const eightFloor = makeInsight({
      id: 'l2',
      templateId: 'tiltCost',
      scopeKey: 'l2',
      state: 'locked',
      deltaPoints: null,
      gamesNeeded: 3,
      salience: 20,
      recent: {
        kind: 'abstained',
        claimType: 'fact',
        reason: 'insufficient-sample',
        sample: {
          rawSampleSize: 5,
          eligibleDenominator: 5,
          knownFieldCoverage: 1,
          dateRange: null,
          refreshedAt: NOW_MS,
          evidencePolicyVersion: 1,
          recencyTreatment: 'unweighted',
          confidenceTier: null,
        },
        gamesNeeded: 3,
      },
    }); // eligibleDenominator: 5, gamesNeeded: 3 -> need 8

    const result = assembleRail({ insights: [threeFloor, eightFloor] });
    expect(result.unlocksNext).not.toBeNull();
    const byKey = new Map(result.unlocksNext!.meters.map((m) => [m.key, m]));
    expect(byKey.get('l1')).toMatchObject({ have: 2, need: 3 });
    expect(byKey.get('l2')).toMatchObject({ have: 5, need: 8 });
  });

  it('never returns an empty cards array — 0 candidates of any kind yields exactly 1 card', () => {
    const result = assembleRail({ insights: [] });
    expect(result.cards).toHaveLength(1);
  });

  it('WR-A03: the synthetic fallback card makes no "N more games" claim — a distinct, honest copy key with no game-count values', () => {
    const result = assembleRail({ insights: [] });
    expect(result.cards).toHaveLength(1);
    const fallback = result.cards[0]!;
    expect(fallback.copy.key).toBe('insights.rail.unavailable');
    expect(fallback.copy.key).not.toBe('insights.formNow.locked');
    expect(fallback.copy.values).toEqual({});
  });

  it('returns 3 cards over 2 assertive and 4 direction-free FACT candidates, with only the 2 assertive carrying non-null deltaPoints', () => {
    const insights = [
      assertiveInsight('a', 50),
      assertiveInsight('b', 45),
      factInsight('f1', 40),
      factInsight('f2', 30),
      factInsight('f3', 20),
      factInsight('f4', 10),
    ];
    const result = assembleRail({ insights });
    expect(result.cards).toHaveLength(3);
    const nonNullDeltaCount = result.cards.filter((card) => card.deltaPoints !== null).length;
    expect(nonNullDeltaCount).toBe(2);
  });

  it('routes steady and thinRecent inputs only to lines, never to cards', () => {
    const insights = [
      lineInsight('s1', 'steady', 50),
      lineInsight('t1', 'thinRecent', 40),
      factInsight('f1', 10),
    ];
    const result = assembleRail({ insights });
    expect(result.lines.map((l) => l.id).sort()).toEqual(['s1', 't1']);
    expect(result.cards.some((card) => card.id === 's1' || card.id === 't1')).toBe(false);
  });

  it('breaks an identical-salience tie by ascending templateId', () => {
    const a = makeInsight({
      id: 'a',
      templateId: 'bestMatchup',
      scopeKey: 'a',
      state: 'fact',
      salience: 10,
    });
    const b = makeInsight({
      id: 'b',
      templateId: 'formNow',
      scopeKey: 'b',
      state: 'fact',
      salience: 10,
    });
    const result = assembleRail({ insights: [b, a] });
    expect(result.cards.map((c) => c.templateId)).toEqual(['bestMatchup', 'formNow']);
  });
});

/**
 * Plan 39.1-40 (D-14, D-07, UI-SPEC §7.8 rules 1-4): the optional `backfill`
 * input. A host's OWN reads are classified and filled exactly as before;
 * direction-free FACT back-fill fills the slots they leave, but only when the
 * own set holds no locked candidate (a thin account keeps its unlock lead).
 */
describe('assembleRail backfill (39.1-40)', () => {
  function backfillFact(id: string, salience: number, templateId = 'bestMatchup'): Insight {
    return makeInsight({
      id,
      templateId: templateId as InsightTemplateId,
      scopeKey: id,
      state: 'fact',
      salience,
    });
  }

  const EXISTING_FIXTURES: Insight[][] = [
    [
      assertiveInsight('a', 40),
      assertiveInsight('b', 30),
      assertiveInsight('c', 20),
      assertiveInsight('d', 10),
    ],
    [lockedInsight('l1', 30), lockedInsight('l2', 20), lockedInsight('l3', 10)],
    [lockedInsight('l1', 30, 1)],
    [],
    [
      assertiveInsight('a', 50),
      assertiveInsight('b', 45),
      factInsight('f1', 40),
      factInsight('f2', 30),
      factInsight('f3', 20),
      factInsight('f4', 10),
    ],
    [lineInsight('s1', 'steady', 50), lineInsight('t1', 'thinRecent', 40), factInsight('f1', 10)],
  ];

  it('an explicit empty backfill is deep-equal to omitting it for every existing fixture', () => {
    for (const insights of EXISTING_FIXTURES) {
      expect(assembleRail({ insights, backfill: [] })).toEqual(assembleRail({ insights }));
    }
  });

  it('one assertive own card + two fact back-fills -> [assertive, fact, fact], facts in salience-then-templateId order', () => {
    const result = assembleRail({
      insights: [assertiveInsight('own', 10)],
      backfill: [
        backfillFact('worstMatchup:account:last30', 5, 'worstMatchup'),
        backfillFact('bestMatchup:account:last30', 5, 'bestMatchup'),
      ],
    });
    expect(result.cards.map((c) => c.id)).toEqual([
      'own',
      'bestMatchup:account:last30',
      'worstMatchup:account:last30',
    ]);
  });

  it('an own set holding a locked candidate ignores the back-fill (thin account keeps its unlock lead)', () => {
    const result = assembleRail({
      insights: [lockedInsight('l1', 30)],
      backfill: [backfillFact('bf1', 50), backfillFact('bf2', 40)],
    });
    expect(result.cards.map((c) => c.id)).toEqual(['l1']);
    expect(result.promotionQueue.some((c) => c.id === 'bf1' || c.id === 'bf2')).toBe(false);
  });

  it('an own set that would reach the fallback + two fact back-fills -> exactly those two cards and no fallback', () => {
    const result = assembleRail({
      insights: [lineInsight('s1', 'steady', 50)],
      backfill: [backfillFact('bf1', 10), backfillFact('bf2', 20)],
    });
    expect(result.cards.map((c) => c.id)).toEqual(['bf2', 'bf1']);
    expect(result.cards.some((c) => isRailFallbackInsight(c))).toBe(false);
    expect(result.lines.map((l) => l.id)).toEqual(['s1']);
  });

  it.each(['locked', 'hidden', 'steady', 'trend', 'suggestion'] as const)(
    'a back-fill entry in state %s is ignored',
    (state) => {
      const result = assembleRail({
        insights: [assertiveInsight('own', 10)],
        backfill: [
          makeInsight({
            id: `bf-${state}`,
            templateId: 'bestMatchup',
            scopeKey: `bf-${state}`,
            state,
            salience: 99,
          }),
        ],
      });
      expect(result.cards.map((c) => c.id)).toEqual(['own']);
      expect(result.lines.some((l) => l.id === `bf-${state}`)).toBe(false);
      expect(result.promotionQueue.some((c) => c.id === `bf-${state}`)).toBe(false);
      expect(result.unlocksNext).toBeNull();
    },
  );

  it('with the cap already full, the back-fill goes to the END of promotionQueue', () => {
    const result = assembleRail({
      insights: [
        assertiveInsight('a', 40),
        assertiveInsight('b', 30),
        assertiveInsight('c', 20),
        assertiveInsight('d', 10),
      ],
      backfill: [backfillFact('bf1', 99)],
    });
    expect(result.cards.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(result.promotionQueue.map((c) => c.id)).toEqual(['d', 'bf1']);
  });

  it('a back-fill id equal to an own id is ignored', () => {
    const own = factInsight('dup', 10);
    const result = assembleRail({
      insights: [own],
      backfill: [backfillFact('dup', 90), backfillFact('bf1', 5)],
    });
    expect(result.cards.map((c) => c.id)).toEqual(['dup', 'bf1']);
    expect(result.cards[0]).toBe(own);
  });

  it('isRailFallbackInsight is true only for the synthetic fallback', () => {
    const fallback = assembleRail({ insights: [] }).cards[0]!;
    expect(isRailFallbackInsight(fallback)).toBe(true);
    expect(isRailFallbackInsight(factInsight('f1', 10))).toBe(false);
    // A real formNow read that happens to share the fallback's id is not the fallback.
    expect(isRailFallbackInsight(assertiveInsight('formNow:account:last30', 10))).toBe(false);
  });
});

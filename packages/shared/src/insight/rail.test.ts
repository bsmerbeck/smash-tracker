import { describe, expect, it } from 'vitest';
import { assembleRail } from './rail.js';
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

  it('never returns an empty cards array — 0 candidates of any kind yields exactly 1 card', () => {
    const result = assembleRail({ insights: [] });
    expect(result.cards).toHaveLength(1);
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

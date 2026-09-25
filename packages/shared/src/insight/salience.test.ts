import { describe, expect, it } from 'vitest';
import { scoreInsight } from './salience.js';
import type { Insight } from './types.js';

const NOW_MS = 1_700_100_000_000;

function makeInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: 'formNow:account:last30',
    templateId: 'formNow',
    scopeKey: 'account',
    horizon: 'last30',
    kind: 'inference',
    state: 'trend',
    recent: {
      kind: 'evidenced',
      claimType: 'fact',
      value: { wins: 20, losses: 10, total: 30, rate: 20 / 30 },
      sample: {
        rawSampleSize: 30,
        eligibleDenominator: 30,
        knownFieldCoverage: 1,
        dateRange: { firstMs: NOW_MS - 1000, lastMs: NOW_MS },
        refreshedAt: NOW_MS,
        evidencePolicyVersion: 1,
        recencyTreatment: 'unweighted',
        confidenceTier: 'high',
      },
    },
    baseline: {
      kind: 'evidenced',
      claimType: 'fact',
      value: { wins: 4000, losses: 4000, total: 8000, rate: 0.5 },
      sample: {
        rawSampleSize: 8000,
        eligibleDenominator: 8000,
        knownFieldCoverage: 1,
        dateRange: { firstMs: NOW_MS - 10_000, lastMs: NOW_MS },
        refreshedAt: NOW_MS,
        evidencePolicyVersion: 1,
        recencyTreatment: 'unweighted',
        confidenceTier: 'high',
      },
    },
    deltaPoints: 17,
    window: { horizon: 'last30', fromMs: NOW_MS - 1000, toMs: NOW_MS, games: 30, scoped: false },
    salience: 0,
    copy: { key: 'insights.formNow.up.last30', values: {} },
    doors: [],
    countedMatchIds: [],
    ...overrides,
  };
}

describe('scoreInsight', () => {
  it('called twice on the same Insight and nowMs returns the identical number', () => {
    const insight = makeInsight();
    expect(scoreInsight(insight, NOW_MS)).toBe(scoreInsight(insight, NOW_MS));
  });

  it('returns 0 absolute-delta contribution when deltaPoints is null', () => {
    const withDelta = scoreInsight(makeInsight({ deltaPoints: 17 }), NOW_MS);
    const withoutDelta = scoreInsight(makeInsight({ deltaPoints: null }), NOW_MS);
    expect(withDelta).toBeGreaterThan(withoutDelta);
  });

  it('scores a higher-confidence-tier Insight above an otherwise-identical low-tier one', () => {
    const high = scoreInsight(
      makeInsight({
        recent: {
          kind: 'evidenced',
          claimType: 'fact',
          value: { wins: 20, losses: 10, total: 30, rate: 20 / 30 },
          sample: {
            rawSampleSize: 30,
            eligibleDenominator: 30,
            knownFieldCoverage: 1,
            dateRange: { firstMs: NOW_MS - 1000, lastMs: NOW_MS },
            refreshedAt: NOW_MS,
            evidencePolicyVersion: 1,
            recencyTreatment: 'unweighted',
            confidenceTier: 'high',
          },
        },
      }),
      NOW_MS,
    );
    const low = scoreInsight(
      makeInsight({
        recent: {
          kind: 'evidenced',
          claimType: 'fact',
          value: { wins: 2, losses: 1, total: 3, rate: 2 / 3 },
          sample: {
            rawSampleSize: 3,
            eligibleDenominator: 3,
            knownFieldCoverage: 1,
            dateRange: { firstMs: NOW_MS - 1000, lastMs: NOW_MS },
            refreshedAt: NOW_MS,
            evidencePolicyVersion: 1,
            recencyTreatment: 'unweighted',
            confidenceTier: 'low',
          },
        },
      }),
      NOW_MS,
    );
    expect(high).toBeGreaterThan(low);
  });
});

import type { Match } from '../../match.js';
import type { TournamentRegistryRow } from '../../tournamentRegistry.js';
import type { HorizonKey, Insight, InsightScope } from '../types.js';
import type { InsightTemplate } from './registry.js';

// RED stub (Task 2, tdd="true"): intentionally wrong (always "hidden", ignores registryEntry) so
// the RED test run fails on real assertions, not on an import/syntax error.
export function buildLastEventRecapInsight(input: {
  matches: Match[];
  scope: InsightScope;
  horizon: HorizonKey;
  nowMs: number;
  registryEntry?: TournamentRegistryRow;
}): Insight {
  const { scope, horizon, nowMs } = input;
  return {
    id: `lastEventRecap:${scope.key}:${horizon}`,
    templateId: 'lastEventRecap',
    scopeKey: scope.key,
    horizon,
    kind: 'fact',
    state: 'hidden',
    recent: {
      kind: 'abstained',
      claimType: 'fact',
      reason: 'insufficient-sample',
      sample: {
        rawSampleSize: 0,
        eligibleDenominator: 0,
        knownFieldCoverage: 0,
        dateRange: null,
        refreshedAt: nowMs,
        evidencePolicyVersion: 1,
        recencyTreatment: 'unweighted',
        confidenceTier: null,
      },
      gamesNeeded: 3,
    },
    baseline: {
      kind: 'abstained',
      claimType: 'fact',
      reason: 'insufficient-sample',
      sample: {
        rawSampleSize: 0,
        eligibleDenominator: 0,
        knownFieldCoverage: 0,
        dateRange: null,
        refreshedAt: nowMs,
        evidencePolicyVersion: 1,
        recencyTreatment: 'unweighted',
        confidenceTier: null,
      },
      gamesNeeded: 3,
    },
    deltaPoints: null,
    window: { horizon, fromMs: null, toMs: null, games: 0, scoped: false },
    salience: 0,
    copy: { key: 'insights.lastEventRecap.hidden', values: {} },
    doors: [],
  };
}

export const lastEventRecapTemplate: InsightTemplate = {
  id: 'lastEventRecap',
  scopeKind: 'character',
  assertsDirection: false,
  windowExpressible: true,
  build(input): Insight[] {
    return [buildLastEventRecapInsight({ ...input, registryEntry: undefined })];
  },
};

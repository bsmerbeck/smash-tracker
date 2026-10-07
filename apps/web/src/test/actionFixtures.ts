import type {
  ClaimAtomRecord,
  ScoutReportRecord,
  StoredPracticePlan,
  StoredScoutReport,
} from '@smash-tracker/shared';
import { CLAIM_MAP, CLAIMS_ERA_PLAN, CLAIMS_ERA_RECORD } from './claimReportFixtures';

/**
 * Phase 39 (plan 39-11, RPT-09): stored-record fixtures carrying the model's
 * three action slots, shared by the paid recommended-actions card and its two
 * host cards' tests. Each claim is shaped to license exactly the action kind
 * its name says through the shared engine (`buildActionCandidates`).
 */

const SAMPLE: ClaimAtomRecord['sample'] = {
  rawSampleSize: 9,
  eligibleDenominator: 9,
  knownFieldCoverage: 1,
  refreshedAt: 1_700_000_000_000,
  evidencePolicyVersion: 1,
  recencyTreatment: 'unweighted',
  confidenceTier: 'medium',
};

/** Mario (1) vs Donkey Kong (2), 2–7 — a losing matchup: licenses `matchup_practice`. */
export const PRACTICE_CLAIM: ClaimAtomRecord = {
  id: 'c02',
  predicate: 'character_matchup_record',
  subject: { myFighterId: 1, opponentFighterId: 2 },
  value: { kind: 'record', wins: 2, losses: 7, games: 9 },
  claimKind: 'fact',
  evidenceIds: ['cmr-f1-g2'],
  tier: 'medium',
  policyVersion: 1,
  sample: SAMPLE,
};

/** Donkey Kong (2) on Big Battlefield (2), 1–5 — a losing stage: licenses the `stage_habit` drill. */
export const STAGE_HABIT_CLAIM: ClaimAtomRecord = {
  id: 'c04',
  predicate: 'stage_record',
  subject: { opponentFighterId: 2, stageId: 2 },
  value: { kind: 'record', wins: 1, losses: 5, games: 6 },
  claimKind: 'fact',
  evidenceIds: ['sr-g2-s2'],
  tier: 'low',
  policyVersion: 1,
  sample: { ...SAMPLE, rawSampleSize: 6, eligibleDenominator: 6, confidenceTier: 'low' },
};

/** "rival" plays Link (3) in 8 of 10 games — licenses the `character_familiarity` drill. */
export const FAMILIARITY_CLAIM: ClaimAtomRecord = {
  id: 'c05',
  predicate: 'opponent_character_usage',
  subject: { opponentFighterId: 3, opponentTag: 'rival' },
  value: { kind: 'rate', numerator: 8, denominator: 10 },
  claimKind: 'fact',
  evidenceIds: ['ocu-g3-o0'],
  tier: 'medium',
  policyVersion: 1,
  sample: { ...SAMPLE, rawSampleSize: 10, eligibleDenominator: 10 },
};

/** Head-to-head 2–8 — with no persisted VOD references it licenses no action on its own. */
export const VOD_ONLY_CLAIM: ClaimAtomRecord = {
  id: 'c01',
  predicate: 'head_to_head_record',
  subject: { opponentTag: 'rival' },
  value: { kind: 'record', wins: 2, losses: 8, games: 10 },
  claimKind: 'fact',
  evidenceIds: ['h2h-o0'],
  tier: 'medium',
  policyVersion: 1,
  sample: { ...SAMPLE, rawSampleSize: 10, eligibleDenominator: 10 },
};

export const ACTION_CLAIM_MAP: Record<string, ClaimAtomRecord> = {
  [PRACTICE_CLAIM.id]: PRACTICE_CLAIM,
  [STAGE_HABIT_CLAIM.id]: STAGE_HABIT_CLAIM,
  [FAMILIARITY_CLAIM.id]: FAMILIARITY_CLAIM,
  [VOD_ONLY_CLAIM.id]: VOD_ONLY_CLAIM,
};

/** The model's three chosen slots, in its order. */
export const ACTION_SLOTS: NonNullable<StoredScoutReport['actions']> = {
  action1: { actionId: 'a01', claimId: PRACTICE_CLAIM.id },
  action2: { actionId: 'a03', claimId: STAGE_HABIT_CLAIM.id },
  action3: { actionId: 'a02', claimId: FAMILIARITY_CLAIM.id },
};

export const CLAIMS_ERA_RECORD_WITH_ACTIONS: ScoutReportRecord = {
  ...CLAIMS_ERA_RECORD,
  report: {
    ...CLAIMS_ERA_RECORD.report,
    claims: { ...CLAIM_MAP, ...ACTION_CLAIM_MAP },
    actions: ACTION_SLOTS,
  },
};

export const CLAIMS_ERA_PLAN_WITH_ACTIONS: StoredPracticePlan = {
  ...CLAIMS_ERA_PLAN,
  claims: { ...CLAIM_MAP, ...ACTION_CLAIM_MAP },
  actions: ACTION_SLOTS,
};

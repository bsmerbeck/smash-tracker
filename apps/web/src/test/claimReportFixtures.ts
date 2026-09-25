import type { ClaimAtomRecord, ScoutReportRecord, StoredPracticePlan } from '@smash-tracker/shared';

/**
 * Phase 39 (plan 39-09): claims-era stored-record fixtures shared by the
 * scout card, the Markdown export and the practice-plan view tests. Shaped
 * exactly as plan 39-06's projection writes them: keyed `claims` /
 * `sections` maps, the legacy prose fields projected from the connectives,
 * `confidenceNotes: ''` (D-03), the stage reasoning = the game-plan
 * connective, and no `characterStrategy` / `headToHead`.
 */

const BASE_SAMPLE: ClaimAtomRecord['sample'] = {
  rawSampleSize: 55,
  eligibleDenominator: 55,
  knownFieldCoverage: 1,
  refreshedAt: 1_700_000_000_000,
  evidencePolicyVersion: 1,
  recencyTreatment: 'unweighted',
  confidenceTier: 'medium',
};

/** `stage_record` on Battlefield (stage id 1), 34–21 over 55 games, medium tier. */
export const STAGE_CLAIM: ClaimAtomRecord = {
  id: 'stage_record:battlefield',
  predicate: 'stage_record',
  subject: { stageId: 1 },
  value: { kind: 'record', wins: 34, losses: 21, games: 55 },
  claimKind: 'fact',
  evidenceIds: ['row-stage-1'],
  tier: 'medium',
  policyVersion: 1,
  sample: BASE_SAMPLE,
};

/** `opponent_character_usage` for Donkey Kong (fighter id 2), 12 of 20 known games, low tier. */
export const USAGE_CLAIM: ClaimAtomRecord = {
  id: 'opponent_character_usage:dk',
  predicate: 'opponent_character_usage',
  subject: { opponentFighterId: 2 },
  value: { kind: 'rate', numerator: 12, denominator: 20 },
  claimKind: 'inference',
  evidenceIds: ['row-usage-2'],
  tier: 'low',
  policyVersion: 1,
  sample: { ...BASE_SAMPLE, rawSampleSize: 20, eligibleDenominator: 20, confidenceTier: 'low' },
};

/** `head_to_head_record` against the scouted tag, 7–3, medium tier. */
export const H2H_CLAIM: ClaimAtomRecord = {
  id: 'head_to_head_record:pandem1c',
  predicate: 'head_to_head_record',
  subject: { opponentTag: 'Pandem1c' },
  value: { kind: 'record', wins: 7, losses: 3, games: 10 },
  claimKind: 'fact',
  evidenceIds: ['row-h2h'],
  tier: 'medium',
  policyVersion: 1,
  sample: { ...BASE_SAMPLE, rawSampleSize: 10, eligibleDenominator: 10 },
};

/** An abstained `character_matchup_record` — 2 more games needed, no tier. */
export const ABSTAINED_CLAIM: ClaimAtomRecord = {
  id: 'character_matchup_record:mario-dk',
  predicate: 'character_matchup_record',
  subject: { myFighterId: 1, opponentFighterId: 2 },
  value: { kind: 'abstained', gamesNeeded: 2 },
  claimKind: 'fact',
  evidenceIds: ['row-mu'],
  tier: null,
  policyVersion: 1,
  sample: { ...BASE_SAMPLE, rawSampleSize: 1, eligibleDenominator: 1, confidenceTier: null },
};

export const CLAIM_MAP: Record<string, ClaimAtomRecord> = {
  [STAGE_CLAIM.id]: STAGE_CLAIM,
  [USAGE_CLAIM.id]: USAGE_CLAIM,
  [H2H_CLAIM.id]: H2H_CLAIM,
  [ABSTAINED_CLAIM.id]: ABSTAINED_CLAIM,
};

export const OVERVIEW_CONNECTIVE = 'Keep the opening games steady and patient.';
/** Deliberately states numbers that are NOT the claims' values (D-01 proof). */
export const GAMEPLAN_CONNECTIVE =
  'Steer the set toward the stage where your wins come — you are 9-1 there, a 90% rate.';

/**
 * overview: one claim (h2h) · gameplan: a partially-abstained section
 * (stage + usage survive, the matchup record abstained) · watchFor: an
 * all-abstained section whose connective the validator stripped (`''`).
 */
export const CLAIMS_ERA_RECORD: ScoutReportRecord = {
  id: 'report-claims',
  createdAt: Date.UTC(2026, 8, 20),
  model: 'claude-opus-4-8',
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  report: {
    overview: OVERVIEW_CONNECTIVE,
    gameplan: [GAMEPLAN_CONNECTIVE],
    watchFor: [],
    stageStrategy: { bans: [], picks: ['Battlefield'], reasoning: GAMEPLAN_CONNECTIVE },
    confidenceNotes: '',
    claimSchemaVersion: 1,
    validation: { status: 'passed', policyVersion: 1, snapshotId: 'snap-1', claimSchemaVersion: 1 },
    claims: CLAIM_MAP,
    sections: {
      overview: { claimIds: [H2H_CLAIM.id], connective: OVERVIEW_CONNECTIVE },
      gameplan: {
        claimIds: [STAGE_CLAIM.id, ABSTAINED_CLAIM.id, USAGE_CLAIM.id],
        connective: GAMEPLAN_CONNECTIVE,
      },
      watchFor: { claimIds: [ABSTAINED_CLAIM.id], connective: '' },
    },
    strippedSectionCount: 1,
  },
};

/** A claims-era practice plan (plan 39-08's projection: `summary` = overview connective, no `focusAreas`). */
export const CLAIMS_ERA_PLAN: StoredPracticePlan = {
  entryKey: 'entry-1',
  createdAt: Date.UTC(2026, 8, 20),
  summary: OVERVIEW_CONNECTIVE,
  focusAreas: [],
  claimSchemaVersion: 1,
  validation: { status: 'passed', policyVersion: 1, snapshotId: 'snap-1', claimSchemaVersion: 1 },
  claims: CLAIM_MAP,
  sections: {
    overview: { claimIds: [H2H_CLAIM.id], connective: OVERVIEW_CONNECTIVE },
    gameplan: { claimIds: [STAGE_CLAIM.id, USAGE_CLAIM.id], connective: GAMEPLAN_CONNECTIVE },
    watchFor: { claimIds: [ABSTAINED_CLAIM.id], connective: '' },
  },
};

/**
 * The Phase 36 evidence engine barrel. Flat `export *` per the root
 * `packages/shared/src/index.ts` convention.
 *
 * This module deliberately does NOT re-export `../matchupAdvisor.js`: the
 * root barrel already has `export * from './matchupAdvisor.js'`, and a
 * second star path to the same names would make the re-export ambiguous.
 * Do not "fix" this by adding it.
 */
export * from './types.js';
export * from './budgets.js';
export * from './policy.js';
export * from './records.js';
export * from './gate.js';
export * from './rank.js';
export * from './pickBan.js';
export * from './stageEvidence.js';
export * from './identity.js';
export * from './predicate.js';
export * from './cohort.js';
export * from './matchupEvidence.js';
export * from './opponentEvidence.js';
export * from './opponentCrossTab.js';

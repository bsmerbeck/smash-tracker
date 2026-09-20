/**
 * The Phase 39.1 deterministic insight engine's barrel (INS-01, INS-02,
 * INS-04). `Insight` composes `EvidenceClaim<T>` from
 * `packages/shared/src/evidence/types.ts` as a read-only import — never
 * redefined. This barrel is deliberately NOT re-exported through
 * `packages/shared/src/evidence/index.ts` in Phase 39.1 (that file is owned
 * by Phase 38 plan 01), per `39.1-CONTEXT.md` Claude's Discretion and
 * `39.1-PARALLELISM.md` Rule B1. Reached only through the package root
 * barrel (`packages/shared/src/index.ts`'s `export * from
 * './insight/index.js';`), the sole door `apps/web` has into this module.
 */
export * from './types.js';
export * from './policy.js';
export * from './wilsonInterval.js';
export * from './twoProportion.js';
export * from './horizon.js';
export * from './ladder.js';
export * from './salience.js';
export * from './rail.js';
export * from './engine.js';
export * from './markBounds.js';
export * from './periodSeries.js';
export * from './templates/registry.js';

/**
 * Barrel for the shared package's test-fixture utilities (FIXT-02, D-18).
 * Reached ONLY through the `@smash-tracker/shared/testUtils` package
 * subpath (see `package.json`'s `exports` map) — deliberately NOT
 * re-exported from `packages/shared/src/index.ts`, so these generators can
 * never enter the production web bundle's import graph.
 */
export * from './prng.js';
export * from './syntheticMatches.js';
export * from './sparseWorkspaces.js';

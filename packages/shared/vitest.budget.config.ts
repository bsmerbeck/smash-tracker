import { defineConfig } from 'vitest/config';

/**
 * SCL-01 budget runner (D-19, D-26). Deliberately separate from
 * `vitest.config.ts` and never wired into CI or the default `test` script —
 * run explicitly via `pnpm --filter @smash-tracker/shared budget`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.budget.test.ts'],
    // `verbose` guarantees the SCL-01 machine-readable console.log lines are
    // always printed to stdout — the default reporter suppresses per-test
    // stdout in non-TTY invocations (e.g. through `pnpm`), which would
    // otherwise hide the readout this command exists to produce.
    reporters: ['verbose'],
  },
});

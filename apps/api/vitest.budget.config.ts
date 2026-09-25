import { defineConfig } from 'vitest/config';

/**
 * SCL-01 budget runner (D-19, D-26). Deliberately separate from
 * `vitest.config.ts` and never wired into CI or the default `test` script —
 * run explicitly via `pnpm --filter @smash-tracker/api budget`. Keeps the
 * fail-closed fetch stub `setupFiles` every other API test inherits.
 */
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.budget.test.ts'],
    // See packages/shared/vitest.budget.config.ts for why `verbose` is
    // required here: the default reporter suppresses per-test stdout in
    // non-TTY invocations, hiding the SCL-01 readout lines.
    reporters: ['verbose'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Phase 30.2 Plan 02 (ENR-11, cycle-1 review HIGH 4): installs the global
    // fail-closed fetch stub for every API test file. See
    // src/test-support/failClosedFetch.ts for the full rationale.
    setupFiles: ['./vitest.setup.ts'],
  },
});

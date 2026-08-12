import { installFailClosedFetch } from './src/test-support/failClosedFetch.js';

/**
 * Phase 30.2 Plan 02 (ENR-11, cycle-1 review HIGH 4): installs the global
 * fail-closed `fetch` stub before any test runs, via `vitest.config.ts`'s
 * `setupFiles`. See `src/test-support/failClosedFetch.ts` for the full
 * rationale — this file's only job is to call the installer.
 */
installFailClosedFetch();

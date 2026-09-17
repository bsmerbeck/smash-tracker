import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // SCL-01 (D-26): budget commands are timing assertions, a known flake
    // class in this repo's CI — they run only via `pnpm budget`
    // (vitest.budget.config.ts), never as part of the default `vitest run`.
    exclude: [...configDefaults.exclude, '**/*.budget.test.ts'],
  },
});

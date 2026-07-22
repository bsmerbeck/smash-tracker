import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    // GitHub Actions runners are ~3x slower than dev hardware; the heaviest
    // userEvent interaction tests (e.g. GspPage Quick Logger double-entry)
    // legitimately exceed vitest's 5s default there. 15s still catches hangs.
    testTimeout: 15_000,
    alias: {
      // jsdom has no canvas; the real chart components only produce
      // "Not implemented: getContext" / "Failed to create chart" noise in
      // test output. Chart math is covered by each chart's exported pure
      // builder functions, so components render a stable placeholder.
      'react-chartjs-2': fileURLToPath(
        new URL('./src/test/stubs/react-chartjs-2.tsx', import.meta.url),
      ),
    },
  },
});

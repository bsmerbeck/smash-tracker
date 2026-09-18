import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Modules that land in the `charts-vendor` chunk (SCL-02, D-01, D-19): recharts
 * 3.10.1's declared runtime dependency set MINUS `clsx` and
 * `use-sync-external-store`, which are deliberately excluded because this app
 * reaches them from eagerly-loaded code already (`clsx` is a direct
 * dependency used by `cn()` across the whole app) — capturing a shared module
 * in this chunk is the exact SCL-02 hazard this list exists to avoid. The
 * chunk is reached only through the already-lazy Matchups route, so Recharts
 * and its subgraph never touch the entry chunk. If a future recharts upgrade
 * pulls in a package this app also uses eagerly, NARROW this list (remove the
 * colliding name) rather than widening any allowlist — see plan 37-01.
 */
const CHARTS_VENDOR_MODULE_PREFIXES = [
  'node_modules/recharts',
  'node_modules/d3-',
  'node_modules/es-toolkit',
  'node_modules/victory-vendor',
  'node_modules/@reduxjs/toolkit',
  'node_modules/react-redux',
  'node_modules/immer',
  'node_modules/reselect',
  'node_modules/decimal.js-light',
  'node_modules/eventemitter3',
  'node_modules/tiny-invariant',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (CHARTS_VENDOR_MODULE_PREFIXES.some((prefix) => id.includes(prefix))) {
            return 'charts-vendor';
          }
          return undefined;
        },
      },
    },
  },
});

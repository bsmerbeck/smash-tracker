import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // CHRT-04/D-08: forbid importing a chart library outside the kit. This is
    // the FIRST of two independent oracles for the same boundary — the
    // second, CI-independent one is
    // `apps/web/src/components/charts/chartKitBoundary.test.ts`. The
    // `ignores` array below MUST stay identical to that file's
    // `LEGACY_CANVAS_ALLOWLIST`, path for path: two oracles disagreeing about
    // the boundary is worse than having only one. Both arrays are
    // repo-root-relative — ESLint's flat-config `ignores`/`files` patterns
    // resolve from the config file's own directory, which is the repo root,
    // exactly like the boundary test's `KIT_DIR`/allowlist base (R1-HIGH-1).
    // `no-restricted-imports` never sees a `vi.mock(...)` call or a doc
    // comment, which is the same reason the boundary test's allowlist
    // excludes the jsdom stub and the mocking test — neither needs an
    // exemption from a rule about imports.
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: [
      'apps/web/src/components/charts/**',
      'apps/web/src/lib/chartTheme.ts',
      'apps/web/src/pages/Dashboard/components/LastMatchesChart.tsx',
      'apps/web/src/pages/Gsp/components/GainsAnalysis.tsx',
      'apps/web/src/pages/Gsp/components/GspCurve.tsx',
      'apps/web/src/pages/Gsp/components/GspVsGlicko.tsx',
      'apps/web/src/pages/Trends/components/MatchTypeMix.tsx',
      'apps/web/src/pages/Trends/components/MonthlyPerformance.tsx',
      'apps/web/src/pages/Trends/components/RatingCurve.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'recharts',
              message:
                'Import Recharts only from apps/web/src/components/charts/** (the chart kit). See the kit README for the closed vocabulary.',
            },
            {
              name: 'chart.js',
              message:
                'chart.js is being retired in Phase 41 (CHRT-04) — do not add new usage. Use the chart kit (apps/web/src/components/charts/**) for any new chart.',
            },
            {
              name: 'react-chartjs-2',
              message:
                'react-chartjs-2 is being retired in Phase 41 (CHRT-04) — do not add new usage. Use the chart kit (apps/web/src/components/charts/**) for any new chart.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/**/*.ts', 'packages/shared/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
  {
    files: ['**/*.config.{js,ts}', '**/vitest.config.ts', '**/vite.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Build-time puppeteer scripts (prerender, OG card): node for the script
    // itself plus browser for code evaluated inside the page context.
    files: ['apps/web/scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  eslintConfigPrettier,
);

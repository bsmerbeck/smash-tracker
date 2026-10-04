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
    // CHRT-04/D-08 + CHRT-03: forbid importing a chart library outside the kit, and
    // forbid the canvas libraries everywhere. This is the FIRST of two independent
    // oracles for the same boundary — the second, CI-independent one is
    // `apps/web/src/components/charts/chartKitBoundary.test.ts`, which asserts that
    // the `ignores` array below minus the kit directory is empty (there is no
    // allowlist any more: Phase 41 removed chart.js and react-chartjs-2 from the
    // repository, so the kit directory is the only exemption, and it exists for
    // Recharts). The array is repo-root-relative — ESLint's flat-config
    // `ignores`/`files` patterns resolve from the config file's own directory.
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/components/charts/**'],
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
                'chart.js was removed in Phase 41 (CHRT-03) and must not return. Use the chart kit (apps/web/src/components/charts/**) for any new chart.',
            },
            {
              name: 'react-chartjs-2',
              message:
                'react-chartjs-2 was removed in Phase 41 (CHRT-03) and must not return. Use the chart kit (apps/web/src/components/charts/**) for any new chart.',
            },
          ],
          // `paths` matches the exact specifier only; a sub-path (`chart.js/auto`) needs a pattern.
          patterns: [
            {
              group: ['chart.js/*', 'react-chartjs-2/*'],
              message:
                'chart.js and react-chartjs-2 were removed in Phase 41 (CHRT-03) and must not return, sub-paths included. Use the chart kit (apps/web/src/components/charts/**) for any new chart.',
            },
          ],
        },
      ],
    },
  },
  {
    // UI-SPEC §13.2 / UIX-01 (plan 39.1-20): the stretch lint rule. A
    // `Card`/`ChartCard`/`InsightCard` whose `className` carries a stretch
    // (`h-full`), minimum-stretch (`min-h-full`) or viewport-height
    // (`h-screen`) utility is exactly the "card force-stretched to a
    // sibling's height" defect `PageGrid`'s `items-start` exists to
    // prevent — the browser layout oracle (§13.1) catches it too, but this
    // is the fast, CI-only half of the two-oracle pair. The `ignores` array
    // below is the SAME "one named entry, shrink-only" discipline as the
    // `no-restricted-imports` block above: `OpponentList.tsx`'s sticky
    // master rail is the one card this phase's own layout intentionally
    // stretches, and a future removal shrinks this array, never widens it.
    files: ['apps/web/src/pages/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/pages/Opponents/components/OpponentList.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXOpeningElement[name.name=/^(Card|ChartCard|InsightCard)$/] JSXAttribute[name.name='className'] Literal[value=/\\bh-full\\b|\\bmin-h-full\\b|\\bh-screen\\b/]",
          message:
            "A Card/ChartCard/InsightCard may not carry a stretch (h-full), minimum-stretch (min-h-full) or viewport-height (h-screen) utility (UI-SPEC §13.2, UIX-01) — PageGrid's items-start already prevents row-height stretching; size the card to its own content instead. The only named exemption is OpponentList.tsx's sticky master rail.",
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

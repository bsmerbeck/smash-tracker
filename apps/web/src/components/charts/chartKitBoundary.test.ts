import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHART_TOKENS } from './tokens';

/**
 * Phase 37 Plan 02 (CHRT-04, D-08): the SOURCE-TREE half of the chart-kit
 * import boundary. `bundleIsolation.guard.test.ts` (excluded from the
 * default suite, real-build-only) proves the boundary holds in a PRODUCTION
 * BUILD; this file is the cheap, CI-independent second oracle for the same
 * contract — a committed test in the DEFAULT `pnpm test` suite (deliberately
 * NOT named `*.guard.test.ts`) that greps the source tree directly, so the
 * boundary holds even somewhere the build guard or the lint rule
 * (`eslint.config.js`) is not run. Before this file, "recharts/chart.js only
 * from the kit" was a convention stated in a doc comment; a convention with
 * no falsifiable oracle is not a guardrail.
 *
 * PROVEN FAILING (all three, executed by hand during plan 37-02, reverted
 * before commit — see the plan's SUMMARY for the exact observed messages):
 *   1. Temporarily adding `import { LineChart } from 'recharts';` to a page
 *      component outside the kit turned "no SVG chart import outside the
 *      kit" red, naming that file.
 *   2. Temporarily deleting the `chart.js` import from one allowlisted file
 *      turned "the allowlist cannot rot" red, naming that stale entry.
 *   3. Temporarily adding a `#ff0000` literal to a non-test kit file turned
 *      "dark-only" red, naming that file.
 *
 * PROVEN FAILING, plan 39.1-10 (T-39.1-10-02/T-39.1-10-06, executed by hand,
 * reverted before commit — recorded verbatim in the plan's SUMMARY):
 *   4. Temporarily replacing every `CHART_TOKENS.border` reference in
 *      `TrendLine.tsx` with a literal `'var(--border)'` turned "every key of
 *      the frozen CHART_TOKENS map is referenced" red, naming `border` as
 *      the unreferenced key.
 *   5. Temporarily adding `var(--chart-1)` to a non-test kit file turned "no
 *      kit file reads a raw chart custom property" red, naming that file.
 *   6. Temporarily adding `var(--primary)` to a non-test kit file turned "no
 *      kit file uses --primary" red, naming that file.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * One stated path base for the whole gate (R1-HIGH-1): every path here is
 * REPO-RELATIVE with forward slashes, resolved from `import.meta.url` and
 * normalised back to this form before any comparison. ESLint's `ignores`
 * patterns in the root `eslint.config.js` also resolve from the repo root
 * (the config file's own directory) — which is what makes that array
 * literally comparable to `LEGACY_CANVAS_ALLOWLIST` below, path for path,
 * with no base-translation step (Task 3).
 */
const KIT_DIR = 'apps/web/src/components/charts/';

/**
 * Re-grepped at plan-execution time with the SAME regex the assertions below
 * use (an import specifier for `chart.js` or `react-chartjs-2`, quoted
 * single or double) across `apps/web/src`. A looser grep (matching any
 * occurrence of the package name, not just an import specifier) also
 * matches `apps/web/src/test/stubs/react-chartjs-2.tsx` (the vitest alias
 * TARGET for `react-chartjs-2` — the package name appears only in its doc
 * comment, never in an import) and
 * `apps/web/src/pages/Scout/components/FullAnalysisSection.test.tsx` (which
 * previously used `vi.mock('react-chartjs-2', ...)`, not an import — that
 * mock block was removed by plan 38-05 alongside the Scout replacement
 * below) — neither file is listed here, because neither needs an exemption
 * from a rule about imports (R1-BLOCKER-3). Nine entries as of plan 38-05
 * (D-12/B-01): the chart.js scouting-trend component this list used to name
 * is DELETED — its two live importers (`OpponentsPage.tsx`,
 * `Scout/components/FullAnalysisSection.tsx`) moved onto the kit's
 * `TrendLine` — so its allowlist entry is removed in the SAME commit as the
 * deletion (the anti-rot assertion below fails the instant a listed path
 * stops existing). Ten entries matched D-20/37-RESEARCH.md on the post-37-01
 * tree (37-01 migrated the eleventh, `MatchupChart.tsx`, onto the kit).
 */
const LEGACY_CANVAS_ALLOWLIST = [
  'apps/web/src/lib/chartTheme.ts',
  'apps/web/src/pages/Dashboard/components/LastMatchesChart.tsx',
  'apps/web/src/pages/Gsp/components/GainsAnalysis.tsx',
  'apps/web/src/pages/Gsp/components/GspCurve.tsx',
  'apps/web/src/pages/Gsp/components/GspVsGlicko.tsx',
  'apps/web/src/pages/Trends/components/MatchTypeMix.tsx',
  'apps/web/src/pages/Trends/components/MonthlyPerformance.tsx',
  'apps/web/src/pages/Trends/components/RatingCurve.tsx',
];

const SVG_CHART_IMPORT = /from\s+['"]recharts['"]/;
const CANVAS_CHART_IMPORT = /from\s+['"](chart\.js|react-chartjs-2)['"]/;

/**
 * The structural frame rule (R1-BLOCKER-2, R2-HIGH-1, R2-MEDIUM-2): every kit
 * file that renders a Recharts element must be listed here, AND every listed
 * member must have a colocated `.test.tsx` proving it renders inside a
 * `ChartCard` — assertion 6 below checks BOTH directions. This is NOT a rule
 * about which FILE imports `ChartCard`: `MatchupChart.tsx` (plan 37-01)
 * legitimately imports `TrendLine` without importing `ChartCard` itself,
 * because its host, `MatchupsPage.tsx`, supplies the frame. `ChartCard.tsx`
 * itself is deliberately NOT a member and has NO exemption clause here: it
 * composes only `@/components/ui/card` and never imports `recharts`, so an
 * exemption for it would be dead code that reads as a licensed bypass.
 */
const KIT_CHART_PRIMITIVES = ['apps/web/src/components/charts/TrendLine.tsx'];

function toRepoRelative(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function listSourceFiles(): string[] {
  const webSrcRoot = path.join(REPO_ROOT, 'apps/web/src');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(toRepoRelative(full));
      }
    }
  };
  walk(webSrcRoot);
  return out;
}

const SOURCE_FILES = listSourceFiles();

/**
 * Load-bearing exclusion, not tidiness (R1-BLOCKER-1): this file itself lives
 * under `KIT_DIR` and contains the literal patterns the dark-only assertions
 * search for (`SVG_CHART_IMPORT`'s own source text, the hex-literal regex's
 * own source text). A kit enumeration that included test files would match
 * its OWN source and turn the default suite red on a healthy tree. Excluding
 * `.test.ts`/`.test.tsx` is what keeps this gate from scanning itself —
 * verified directly below by asserting this file is not a member.
 */
const KIT_FILES = SOURCE_FILES.filter(
  (file) => file.startsWith(KIT_DIR) && !/\.test\.tsx?$/.test(file),
);

/**
 * Phase 39.1 plan 10 (T-39.1-10-06): the every-`CHART_TOKENS`-key-is-consumed
 * assertion below scans this directory ALONGSIDE `KIT_DIR` — `DeltaChip` and
 * `UnlocksNext` (both mark-role/token consumers) live under
 * `components/analytics/`, not `components/charts/`. `tokens.ts` itself is
 * excluded (it DECLARES every key; declaration is not consumption, and
 * including it would let a key "reference itself" and pass vacuously).
 */
const ANALYTICS_DIR = 'apps/web/src/components/analytics/';
const TOKEN_CONSUMPTION_FILES = SOURCE_FILES.filter(
  (file) =>
    (file.startsWith(KIT_DIR) || file.startsWith(ANALYTICS_DIR)) &&
    !/\.test\.tsx?$/.test(file) &&
    file !== 'apps/web/src/components/charts/tokens.ts',
);

function readRepoFile(repoRelativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, repoRelativePath), 'utf8');
}

describe('chart kit import boundary — source-tree guard (CHRT-04, D-08)', () => {
  it('the kit-file subset is non-empty and excludes its own boundary test (base-mismatch canary)', () => {
    expect(KIT_FILES.length).toBeGreaterThan(0);
    expect(KIT_FILES).not.toContain('apps/web/src/components/charts/chartKitBoundary.test.ts');
  });

  it('no SVG chart (recharts) import exists anywhere outside the kit', () => {
    const offenders = SOURCE_FILES.filter(
      (file) => !file.startsWith(KIT_DIR) && SVG_CHART_IMPORT.test(readRepoFile(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('no canvas chart (chart.js/react-chartjs-2) import exists outside the allowlist', () => {
    const allowlistSet = new Set(LEGACY_CANVAS_ALLOWLIST);
    const offenders = SOURCE_FILES.filter(
      (file) => !allowlistSet.has(file) && CANVAS_CHART_IMPORT.test(readRepoFile(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('the allowlist cannot rot: every entry still exists and still needs its exemption', () => {
    const stale = LEGACY_CANVAS_ALLOWLIST.filter((file) => {
      const fullPath = path.join(REPO_ROOT, file);
      if (!fs.existsSync(fullPath)) return true;
      return !CANVAS_CHART_IMPORT.test(fs.readFileSync(fullPath, 'utf8'));
    });
    expect(
      stale,
      `stale allowlist entries (missing file or no longer importing): ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('the two files that are NOT allowlisted stay unlisted (R1-BLOCKER-3: neither imports the package)', () => {
    expect(LEGACY_CANVAS_ALLOWLIST).not.toContain('apps/web/src/test/stubs/react-chartjs-2.tsx');
    expect(LEGACY_CANVAS_ALLOWLIST).not.toContain(
      'apps/web/src/pages/Scout/components/FullAnalysisSection.test.tsx',
    );
  });

  it('37-01 migrated MatchupChart.tsx off the allowlist', () => {
    expect(LEGACY_CANVAS_ALLOWLIST).not.toContain(
      'apps/web/src/pages/Matchups/components/MatchupChart.tsx',
    );
  });

  /**
   * M-01 (plan 38-05): this file's own head comment (above) has claimed since
   * Phase 37 that `eslint.config.js`'s `ignores` array — the `no-restricted-imports`
   * rule's exemption list — is "literally comparable to `LEGACY_CANVAS_ALLOWLIST`
   * below, path for path, with no base-translation step". Nothing ever checked
   * that claim: ESLint does not error on an `ignores` pattern that matches no
   * file, so a stale entry there survives `pnpm lint` silently. This assertion
   * makes the claim real, in BOTH directions, so an entry added to either list
   * without the other is named.
   *
   * Parsed rather than imported — importing the flat config inside a Vitest
   * worker pulls in the whole ESLint plugin graph. The `ignores` array is
   * located by finding the LAST `ignores: [...]` literal that appears before
   * the `'no-restricted-imports'` rule key in the source text (this file
   * declares two `ignores` arrays; the first, at the top of the config, is an
   * unrelated dist/coverage/node_modules exclusion).
   *
   * Deliberate failure observed (per this file's own discipline), reverted,
   * and recorded in the plan 38-05 SUMMARY: temporarily removing one entry
   * from `LEGACY_CANVAS_ALLOWLIST` (leaving `eslint.config.js` untouched)
   * turned this assertion red, naming the orphaned `eslint.config.js` entry.
   */
  it("eslint.config.js's no-restricted-imports ignores array (minus its charts/** kit-directory entry) equals LEGACY_CANVAS_ALLOWLIST, in both directions (M-01)", () => {
    const eslintSource = readRepoFile('eslint.config.js');
    const ruleIndex = eslintSource.indexOf("'no-restricted-imports'");
    expect(ruleIndex, 'expected a no-restricted-imports rule in eslint.config.js').toBeGreaterThan(
      -1,
    );
    const beforeRule = eslintSource.slice(0, ruleIndex);
    const ignoresStart = beforeRule.lastIndexOf('ignores: [');
    expect(ignoresStart, 'expected an `ignores: [...]` array before the rule').toBeGreaterThan(-1);
    const fromIgnores = beforeRule.slice(ignoresStart + 'ignores: ['.length);
    const arrayBody = fromIgnores.slice(0, fromIgnores.indexOf(']'));
    const eslintIgnoresMembers = [...arrayBody.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    const KIT_DIRECTORY_IGNORE_ENTRY = 'apps/web/src/components/charts/**';
    expect(eslintIgnoresMembers).toContain(KIT_DIRECTORY_IGNORE_ENTRY);
    const withoutKitDirectory = eslintIgnoresMembers.filter(
      (entry) => entry !== KIT_DIRECTORY_IGNORE_ENTRY,
    );
    expect([...withoutKitDirectory].sort()).toEqual([...LEGACY_CANVAS_ALLOWLIST].sort());
  });

  it('the SVG-chart-import assertion is not vacuous — at least one kit file imports recharts', () => {
    const anyKitFileUsesRecharts = KIT_FILES.some((file) =>
      SVG_CHART_IMPORT.test(readRepoFile(file)),
    );
    expect(anyKitFileUsesRecharts).toBe(true);
  });

  it('the kit stays dark-only: no hex colour literal, no colour-scheme media query', () => {
    const hexOffenders = KIT_FILES.filter((file) => /#[0-9a-fA-F]{6}\b/.test(readRepoFile(file)));
    const mediaOffenders = KIT_FILES.filter((file) =>
      /prefers-color-scheme/.test(readRepoFile(file)),
    );
    expect(hexOffenders, `hex-literal offenders: ${hexOffenders.join(', ')}`).toEqual([]);
    expect(mediaOffenders, `colour-scheme-media offenders: ${mediaOffenders.join(', ')}`).toEqual(
      [],
    );
  });

  it('the structural frame rule holds in both membership directions (R1-BLOCKER-2, R2-MEDIUM-2)', () => {
    // (a) recharts is importable only from KIT_FILES — proven by the
    // "no SVG chart import outside the kit" assertion above.

    // (b) membership, both directions: every kit file that imports recharts
    // is listed in KIT_CHART_PRIMITIVES, and every listed member actually
    // imports recharts. A weaker "non-empty and members exist" check would
    // let a new primitive slip in unlisted (R2-MEDIUM-2).
    const rechartsImportingKitFiles = KIT_FILES.filter((file) =>
      SVG_CHART_IMPORT.test(readRepoFile(file)),
    );
    expect([...rechartsImportingKitFiles].sort()).toEqual([...KIT_CHART_PRIMITIVES].sort());

    // (c) the nesting proof exists: every listed primitive has a colocated
    // `.test.tsx` — that test is what actually proves the chart renders
    // inside a ChartCard (asserting the card's title/caption chrome around
    // it); without this existence check the array is just a list of names.
    for (const primitive of KIT_CHART_PRIMITIVES) {
      const colocatedTest = primitive.replace(/\.tsx$/, '.test.tsx');
      const exists = fs.existsSync(path.join(REPO_ROOT, colocatedTest));
      expect(
        exists,
        `expected colocated test ${colocatedTest} for kit primitive ${primitive}`,
      ).toBe(true);
    }
  });

  it('the frame rule is structural, not lexical: a page owning the frame while its child owns the chart stays green', () => {
    // Mechanical statement of the designed split (plan 37-01): MatchupChart.tsx
    // renders TrendLine directly and never IMPORTS ChartCard — its host,
    // MatchupsPage.tsx, supplies the frame. A lexical co-import rule would
    // wrongly flag this file; the structural assertions above do not. Checked
    // against an actual import specifier (not a bare substring search): the
    // file's own doc comment legitimately explains this split in prose using
    // the word "ChartCard" twice, which a naive substring check would
    // misread as a violation (see the plan 37-02 SUMMARY for the corrected
    // acceptance-criterion count).
    const matchupChartSource = readRepoFile(
      'apps/web/src/pages/Matchups/components/MatchupChart.tsx',
    );
    expect(matchupChartSource).not.toMatch(/from\s+['"]@\/components\/charts\/ChartCard['"]/);
  });

  /**
   * Phase 39.1 plan 10 (T-39.1-10-06, review finding C1-H5): a palette run
   * that validates the stylesheet says nothing about whether anything DRAWS
   * with what it validated. This is the check that would have caught
   * win/loss/steady shipping as declared-but-unused tokens while three
   * components drew their marks with Tailwind colour utilities instead.
   * Every key of the frozen map must be referenced — by the literal
   * `CHART_TOKENS.<key>` substring — in at least one non-test source file
   * under the kit or analytics directories (`tokens.ts` itself excluded; see
   * `TOKEN_CONSUMPTION_FILES`'s doc comment).
   */
  it('every key of the frozen CHART_TOKENS map is referenced by at least one non-test source file under the kit or analytics directories (T-39.1-10-06)', () => {
    const combinedSource = TOKEN_CONSUMPTION_FILES.map((file) => readRepoFile(file)).join('\n');
    const tokenKeys = Object.keys(CHART_TOKENS);
    const unreferenced = tokenKeys.filter((key) => !combinedSource.includes(`CHART_TOKENS.${key}`));
    expect(unreferenced, `unreferenced CHART_TOKENS keys: ${unreferenced.join(', ')}`).toEqual([]);
  });

  it('the consumption assertion is not vacuous — the frozen map has at least one key and at least one file actually references one', () => {
    expect(Object.keys(CHART_TOKENS).length).toBeGreaterThan(0);
    const anyFileReferencesAnyKey = TOKEN_CONSUMPTION_FILES.some((file) =>
      /CHART_TOKENS\.\w+/.test(readRepoFile(file)),
    );
    expect(anyFileReferencesAnyKey).toBe(true);
  });

  /**
   * Phase 39.1 plan 10 (T-39.1-10-02, UI-SPEC §4.2): after the token-map
   * repoint, `CHART_TOKENS` is the ONLY legal consumption point for a chart
   * custom property — a kit file reading `var(--chart-...)` directly bypasses
   * the frozen map entirely (Phase 38 hand-off item 7's exact failure class).
   */
  it('no kit file reads a raw chart custom property directly — the frozen token map is the only consumption point (T-39.1-10-02)', () => {
    const offenders = KIT_FILES.filter((file) => /var\(--chart-/.test(readRepoFile(file)));
    expect(offenders, `raw --chart- property offenders: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * Phase 39.1 plan 10 (T-39.1-10-02, UI-SPEC §4.3): brand red (`--primary`)
   * is never a data mark anywhere in the kit — chrome only.
   */
  it('no kit file uses --primary as a fill or a stroke (brand red is never a data mark, T-39.1-10-02)', () => {
    const offenders = KIT_FILES.filter((file) => /var\(--primary\)/.test(readRepoFile(file)));
    expect(offenders, `--primary-as-mark offenders: ${offenders.join(', ')}`).toEqual([]);
  });
});

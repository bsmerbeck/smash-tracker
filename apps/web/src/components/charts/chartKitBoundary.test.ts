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
 *   2. (Retired by plan 41-11 with the allowlist it guarded.) Temporarily deleting the `chart.js` import
 *      from one allowlisted file turned "the allowlist cannot rot" red, naming that stale entry.
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
 *
 * PROVEN FAILING, plan 41-11 (CHRT-03 / C3 / T-41-30: the ban is unconditional, no allowlist; executed by
 * hand, each mutation reverted before commit):
 *   7. A scratch page file `apps/web/src/pages/Trends/zzScratch.ts` importing `chart.js` turned "no canvas
 *      chart import exists in ANY source file" red: `canvas-library import offenders:
 *      apps/web/src/pages/Trends/zzScratch.ts`.
 *   8. Re-adding `"chart.js": "^4.5.1"` to `apps/web/package.json` turned "neither canvas package is
 *      declared in any workspace package.json" red: `canvas packages declared: apps/web/package.json
 *      dependencies.chart.js`.
 *   9. Recreating `apps/web/src/test/stubs/react-chartjs-2.tsx` turned "the canvas theme module and the
 *      jsdom canvas stub are gone" red: `apps/web/src/test/stubs/react-chartjs-2.tsx must not exist:
 *      expected true to be false`.
 *
 * THE ENUMERATED NON-URL CLICKS: a kit chart's point / mark click drills into the games behind it through
 * the Phase 38 URL contract - EXCEPT the two named here. No other chart may add a non-URL click without
 * being named here.
 *   (1) Plan 41-06, DD-41-12, UI-SPEC 9.3: the GSP curve / MMR panel, because GSP readings are not games
 *       and `FilteredMatchList` has no row for one. At reading grain the click opens that reading's edit
 *       dialog; at a coarser grain it expands the GSP Log and marks the close's rows (`aria-current`).
 *       Neither writes a URL axis (`GspCurve.tsx` imports no router API).
 *   (2) Plan 41-12, PD-12-1: the Scout Recent Form point (and its keyboard table-twin row) lists the
 *       point's games in-card (identity through `matchIds`, never a time window), because a scouted
 *       third party's games have no row in the viewer's `FilteredMatchList` and Phase 38 H-01 / H-02
 *       forbid links from that host into the viewer's routes. No URL axis, no anchor, no router /
 *       query / subject hook (`ScoutRecentFormCard.tsx` imports none).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * One stated path base for the whole gate (R1-HIGH-1): every path here is
 * REPO-RELATIVE with forward slashes, resolved from `import.meta.url` and
 * normalised back to this form before any comparison. ESLint's `ignores`
 * patterns in the root `eslint.config.js` also resolve from the repo root
 * (the config file's own directory) — which is what makes that array
 * directly comparable to `KIT_DIR` with no base-translation step.
 */
const KIT_DIR = 'apps/web/src/components/charts/';

/**
 * Plan 41-11 (CHRT-03, C3): there is NO canvas allowlist. `chart.js` and `react-chartjs-2` were
 * removed from the repository in Phase 41 - the last file that imported them (`lib/chartTheme.ts`),
 * the jsdom stub and its vitest alias, and both dependencies are gone - so the ban below is
 * unconditional. History of the shrinking allowlist (37-02 .. 41-10) lives in the plan SUMMARYs.
 */
const SVG_CHART_IMPORT = /from\s+['"]recharts['"]/;
const CANVAS_PACKAGES = ['chart.js', 'react-chartjs-2', '@kurkle/color'];

/**
 * Every spelling that pulls a canvas chart package in: a static import, a sub-path of either
 * package, a dynamic import call, a require call and a bare side-effect import (41-REVIEW IN-03 -
 * the static form alone left the others unguarded). The doc comment names the forms in prose: a
 * quoted example here would be matched by the source-tree scan, which reads this file too.
 */
const CANVAS_CHART_IMPORT =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](?:chart\.js|react-chartjs-2)(?:\/[^'"]*)?['"]/;

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
 * Plan 39.1-34 adds the second member, `CareerTimeline.tsx` (VIZ-02's
 * "exactly two members" is superseded for this chart by the owner's
 * 2026-09-25 decision — see the kit README).
 */
const KIT_CHART_PRIMITIVES = [
  'apps/web/src/components/charts/TrendLine.tsx',
  // Plan 39.1-34 (owner decision 2026-09-25, UI-SPEC §12.1): the career
  // timeline — the section 12.1 replacement for the chart.js Rating Curve /
  // Monthly Performance pair, not a new idiom. Its colocated test renders it
  // inside a ChartCard.
  'apps/web/src/components/charts/CareerTimeline.tsx',
];

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

  it('no canvas chart (chart.js/react-chartjs-2) import exists in ANY source file, the kit included (CHRT-03, unconditional)', () => {
    const offenders = SOURCE_FILES.filter((file) => CANVAS_CHART_IMPORT.test(readRepoFile(file)));
    expect(offenders, `canvas-library import offenders: ${offenders.join(', ')}`).toEqual([]);
  });

  // IN-03 positive controls. The sample strings are assembled at runtime: a literal import-shaped string in this
  // file would be matched by the source-tree scan above, which reads this file too.
  it('the canvas-import detector matches every import spelling (synthetic positive controls) and no look-alike', () => {
    const q = (name: string) => `'${name}'`;
    const dq = (name: string) => `"${name}"`;
    const hits = [
      `import { Chart } from ${q('chart.js')};`,
      `import { Chart } from ${q('chart.js/auto')};`,
      `import { Line } from ${q('react-chartjs-2')};`,
      `const mod = await import(${q('chart.js')});`,
      `const mod = import( ${q('chart.js/helpers')} );`,
      `const chart = require(${q('chart.js')});`,
      `import ${q('chart.js/auto')};`,
      `import { Chart } from ${dq('chart.js')};`,
    ];
    for (const sample of hits) {
      expect(CANVAS_CHART_IMPORT.test(sample), sample).toBe(true);
    }
    const misses = [
      `import { LineChart } from ${q('recharts')};`,
      `import x from ${q('chart.json')};`,
      `import x from ${q('my-chart.js')};`,
      `const note = ${q('chart.js')};`,
    ];
    for (const sample of misses) {
      expect(CANVAS_CHART_IMPORT.test(sample), sample).toBe(false);
    }
  });

  it('neither canvas package is declared in any workspace package.json dependency map (CHRT-03)', () => {
    const manifests = [
      'package.json',
      'apps/web/package.json',
      'apps/api/package.json',
      'packages/shared/package.json',
    ];
    const declared: string[] = [];
    for (const manifest of manifests) {
      const parsed = JSON.parse(readRepoFile(manifest)) as Record<string, unknown>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const map = (parsed[field] ?? {}) as Record<string, string>;
        for (const name of CANVAS_PACKAGES) {
          if (name in map) declared.push(`${manifest} ${field}.${name}`);
        }
      }
    }
    expect(declared, `canvas packages declared: ${declared.join(', ')}`).toEqual([]);
  });

  it('the canvas theme module and the jsdom canvas stub are gone, and nothing aliases or mocks the canvas wrapper (CHRT-03)', () => {
    for (const gone of [
      'apps/web/src/lib/chartTheme.ts',
      'apps/web/src/test/stubs/react-chartjs-2.tsx',
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, gone)), `${gone} must not exist`).toBe(false);
    }
    expect(readRepoFile('apps/web/vitest.config.ts')).not.toMatch(/react-chartjs-2|chart\.js/);
    const mockOffenders = SOURCE_FILES.filter((file) =>
      /vi\.mock\(\s*['"](react-chartjs-2|chart\.js)['"]/.test(readRepoFile(file)),
    );
    expect(mockOffenders, `canvas-wrapper vi.mock offenders: ${mockOffenders.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * M-01 (plan 38-05), made unconditional by plan 41-11: this file's head comment claims the
   * `eslint.config.js` `no-restricted-imports` `ignores` array and the source-tree rule agree.
   * ESLint does not error on an `ignores` pattern that matches no file, so a stale or newly added
   * exemption survives `pnpm lint` silently. With no allowlist left, the array minus the kit
   * directory entry must be EMPTY - any other entry is a licensed chart-library bypass.
   *
   * Parsed rather than imported - importing the flat config inside a Vitest worker pulls in the
   * whole ESLint plugin graph. The `ignores` array is located by finding the LAST `ignores: [...]`
   * literal before the `'no-restricted-imports'` rule key (the config declares an earlier,
   * unrelated dist/coverage/node_modules `ignores`).
   */
  it("eslint.config.js's no-restricted-imports ignores array is exactly the kit directory (M-01, unconditional)", () => {
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
    expect(eslintIgnoresMembers.filter((entry) => entry !== KIT_DIRECTORY_IGNORE_ENTRY)).toEqual(
      [],
    );
  });

  it('the kit README states Recharts is the only chart library and names no legacy canvas file (README agreement)', () => {
    const readme = readRepoFile('apps/web/src/components/charts/README.md');
    const boundary = readme.slice(readme.indexOf('## Boundary'), readme.indexOf('## Tokens'));
    expect(boundary.length).toBeGreaterThan(0);
    expect(boundary).toMatch(/Recharts[^.]*only chart library/);
    expect(readme).not.toMatch(/legacy (chart\.js|canvas)|chartTheme|allowlist|jsdom stub/i);
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

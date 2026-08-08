import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Phase 29 Plan 12 — the by-name AND by-execution lock over the v2.5
 * protective test blocks this phase's house constraint declares
 * untouchable (`.planning/ROADMAP.md` House Constraint 7). A future edit
 * that renames, deletes, or SKIPS one of these blocks — or quietly guts a
 * locked block's inner tests while leaving its name intact, masked by
 * unrelated passing suites in the same file — is otherwise an invisible
 * regression no other gate catches (T-29-12-06, T-29-12-09).
 *
 * Two independent proofs, per review finding 29-11 MEDIUM and cycle-2
 * finding C2-HIGH-12:
 *
 * 1. EXISTENCE — a comment-stripped source scan proves each locked block's
 *    exact title is declared as a plain (never `.skip`/`.todo`) `describe`
 *    in its named file. A lexical check alone is not sufficient (a name
 *    mentioned only in a comment, or a skipped block, would pass a naive
 *    grep) — this scan strips comments first and rejects the skipped/todo
 *    forms explicitly.
 * 2. EXECUTION — a HERMETIC re-run of the four API locked-suite files plus
 *    the web locked-suite file, via the JSON reporter, parsed by SUITE-TITLE
 *    ANCESTRY (never by file — a per-file "non-zero passing, zero skipped"
 *    check would happily pass even if a locked block were emptied of its
 *    own inner tests, as long as some UNRELATED describe block in the same
 *    file still had passing tests). Each contract records the BASELINE test
 *    count observed when this lock was written; the ancestry check asserts
 *    the CURRENT count is still at or above that baseline, so removing
 *    inner tests one at a time fails rather than degrades silently.
 */

const REPO_ROOT = resolve(process.cwd(), '..', '..');

/** Strips `//` and `/* *\/` comments so a comment-only mention of a title never satisfies the existence check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface LockedContract {
  /** Repo-root-relative path. */
  file: string;
  /** The exact locked `describe` block title. */
  blockTitle: string;
  /** The number of passing tests this block carried when this lock was written. */
  baselineCount: number;
  /** Which hermetic reporter run's JSON output to read this block's execution proof from. */
  reporterSource: 'api' | 'web';
}

/**
 * The v2.5 protections this phase's house constraint declares untouchable —
 * baseline counts recorded from a real reporter run at the time this lock
 * was written (`node -e` script against `--reporter=json --outputFile=...`
 * over the same 5 files this suite re-runs below). Sourced by reading each
 * file directly (see `<read_first>`), never guessed.
 */
const LOCKED_CONTRACTS: LockedContract[] = [
  {
    file: 'apps/api/src/routes/reports.test.ts',
    blockTitle: 'paid prep activation gate (RPT-04)',
    baselineCount: 6,
    reporterSource: 'api',
  },
  {
    file: 'apps/api/src/routes/reports.test.ts',
    blockTitle: 'bundle failure math (RPT-02/RPT-03, owner battery item 3)',
    baselineCount: 9,
    reporterSource: 'api',
  },
  {
    file: 'apps/api/src/config/prepPaidWiring.test.ts',
    blockTitle:
      'index.ts wires PREP_PAID_REPORTS_ENABLED through to buildApp (RPT-04 production-wiring gate)',
    baselineCount: 5,
    reporterSource: 'api',
  },
  {
    file: 'apps/api/src/config/prepPaidWiring.test.ts',
    blockTitle: 'default-OFF runtime proof (production ships UNSET)',
    baselineCount: 1,
    reporterSource: 'api',
  },
  {
    file: 'apps/api/src/events/envelopeWireSafety.test.ts',
    blockTitle: 'createEvent under the strict fake (end-to-end incident closure)',
    baselineCount: 2,
    reporterSource: 'api',
  },
  {
    file: 'apps/api/src/coaching/foreignClient.test.ts',
    blockTitle: 'CANONICAL_TENANT_TREES stays in lockstep with the harness route list',
    baselineCount: 1,
    reporterSource: 'api',
  },
  {
    file: 'apps/api/src/coaching/foreignClient.test.ts',
    blockTitle: 'TENANT_DELETION_TREES is a documented superset of CANONICAL_TENANT_TREES',
    baselineCount: 2,
    reporterSource: 'api',
  },
  {
    file: 'apps/web/src/pages/Tournaments/prep/prepStructuralIntegrity.test.ts',
    blockTitle: 'prep structural integrity (no paid affordance, RPT-04)',
    baselineCount: 24,
    reporterSource: 'web',
  },
];

const API_LOCKED_FILES = [
  ...new Set(LOCKED_CONTRACTS.filter((c) => c.reporterSource === 'api').map((c) => c.file)),
];
const WEB_LOCKED_FILES = [
  ...new Set(LOCKED_CONTRACTS.filter((c) => c.reporterSource === 'web').map((c) => c.file)),
];

// ---------------------------------------------------------------------------
// 1. EXISTENCE lock — comment-stripped, skip/todo-rejecting source scan.
// ---------------------------------------------------------------------------

describe('locked-contract existence (comment-stripped, rejects skipped/todo forms)', () => {
  it('the contract array is non-empty (anti-vacuous-pass guard)', () => {
    expect(LOCKED_CONTRACTS.length).toBeGreaterThan(0);
    expect(LOCKED_CONTRACTS.length).toBeGreaterThanOrEqual(7);
  });

  it.each(LOCKED_CONTRACTS)(
    '$file: "$blockTitle" exists as a plain (non-skipped, non-todo) describe block',
    ({ file, blockTitle }) => {
      // A missing file throws here (readFileSync), failing this test rather
      // than skipping it.
      const source = stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf-8'));
      const escapedTitle = escapeForRegex(blockTitle);
      const skippedOrTodoPattern = new RegExp(`describe\\.(skip|todo)\\(\\s*['"\`]${escapedTitle}`);
      const plainPattern = new RegExp(`describe\\(\\s*['"\`]${escapedTitle}`);

      expect(skippedOrTodoPattern.test(source)).toBe(false);
      expect(plainPattern.test(source)).toBe(true);
    },
  );

  it('fixture: a comment-only mention of a title does NOT satisfy the existence check (review finding 29-11 MEDIUM)', () => {
    const fixtureSource = `
      // describe('a fictitious locked block that only exists in a comment', () => {
      /* describe('another one, block-commented out', () => { it('x', () => {}); }); */
      describe('a genuinely declared block', () => { it('x', () => {}); });
    `;
    const stripped = stripComments(fixtureSource);
    const commentOnlyPattern = new RegExp(
      `describe\\(\\s*['"\`]${escapeForRegex('a fictitious locked block that only exists in a comment')}`,
    );
    const genuinePattern = new RegExp(
      `describe\\(\\s*['"\`]${escapeForRegex('a genuinely declared block')}`,
    );
    expect(commentOnlyPattern.test(stripped)).toBe(false);
    expect(genuinePattern.test(stripped)).toBe(true);
  });

  it('fixture: a describe.skip/.todo declaration does NOT satisfy the plain-existence check', () => {
    const fixtureSource = `describe.skip('a disabled locked block', () => { it('x', () => {}); });`;
    const stripped = stripComments(fixtureSource);
    const escapedTitle = escapeForRegex('a disabled locked block');
    const skippedOrTodoPattern = new RegExp(`describe\\.(skip|todo)\\(\\s*['"\`]${escapedTitle}`);
    const plainPattern = new RegExp(`describe\\(\\s*['"\`]${escapedTitle}`);
    expect(skippedOrTodoPattern.test(stripped)).toBe(true);
    expect(plainPattern.test(stripped)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. EXECUTION lock — hermetic, per-run mkdtemp reporter spawn, parsed by
//    suite-title ancestry (cycle-2 finding C2-HIGH-12).
//
// HERMETICITY (cycle-3 HIGH): this suite NEVER reads ambient /tmp state and
// NEVER depends on files a separate verify command produced. Every run
// creates its own uniquely-scoped directory, spawns the reporter runs
// itself, parses exactly those files, and removes the directory afterward —
// a clean checkout running plain `pnpm test` passes with no pre-seeded
// reporter files anywhere.
// ---------------------------------------------------------------------------

interface ReporterAssertion {
  ancestorTitles: string[];
  status: string;
}

interface ReporterJson {
  testResults: { assertionResults: ReporterAssertion[] }[];
}

function flattenAssertions(json: ReporterJson): ReporterAssertion[] {
  return json.testResults.flatMap((tr) => tr.assertionResults);
}

/**
 * The core ancestry-check primitive (cycle-2 C2-HIGH-12): counts tests whose
 * ENCLOSING-TITLE CHAIN contains the exact locked block title — never a
 * per-FILE count. A pure function, independently testable against a
 * synthetic fixture (see the "not file-granular" test below) without
 * spawning anything.
 */
function countUnderAncestor(
  assertions: ReporterAssertion[],
  blockTitle: string,
): { total: number; passed: number; nonPassing: string[] } {
  const matching = assertions.filter((a) => a.ancestorTitles.includes(blockTitle));
  const nonPassing = matching.filter((a) => a.status !== 'passed').map((a) => a.status);
  return {
    total: matching.length,
    passed: matching.filter((a) => a.status === 'passed').length,
    nonPassing,
  };
}

describe('locked-contract execution (hermetic, suite-title ancestry, cycle-2 C2-HIGH-12)', () => {
  let runDir: string;
  let apiAssertions: ReporterAssertion[] = [];
  let webAssertions: ReporterAssertion[] = [];
  const observedCounts: Record<string, number> = {};

  beforeAll(() => {
    // Per-run, uniquely-scoped directory — the ONLY source this suite ever
    // reads from. Never an ambient/hardcoded path.
    runDir = mkdtempSync(join(tmpdir(), 'gsd-29-locked-'));
    const apiOutputPath = join(runDir, 'api.json');
    const webOutputPath = join(runDir, 'web.json');

    const apiRun = spawnSync(
      'pnpm',
      [
        '--filter',
        '@smash-tracker/api',
        'exec',
        'vitest',
        'run',
        ...API_LOCKED_FILES.map((f) => f.replace('apps/api/', '')),
        '--reporter=json',
        `--outputFile=${apiOutputPath}`,
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 150_000 },
    );
    if (apiRun.error) {
      throw new Error(`Hermetic API reporter spawn failed: ${apiRun.error.message}`);
    }

    const webRun = spawnSync(
      'pnpm',
      [
        '--filter',
        '@smash-tracker/web',
        'exec',
        'vitest',
        'run',
        ...WEB_LOCKED_FILES.map((f) => f.replace('apps/web/', '')),
        '--reporter=json',
        `--outputFile=${webOutputPath}`,
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 150_000 },
    );
    if (webRun.error) {
      throw new Error(`Hermetic web reporter spawn failed: ${webRun.error.message}`);
    }

    apiAssertions = flattenAssertions(
      JSON.parse(readFileSync(apiOutputPath, 'utf-8')) as ReporterJson,
    );
    webAssertions = flattenAssertions(
      JSON.parse(readFileSync(webOutputPath, 'utf-8')) as ReporterJson,
    );
  }, 150_000);

  afterAll(() => {
    if (runDir) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('the hermetic reporter runs produced at least one test result for each source (anti-vacuous-pass guard)', () => {
    expect(apiAssertions.length).toBeGreaterThan(0);
    expect(webAssertions.length).toBeGreaterThan(0);
  });

  it.each(LOCKED_CONTRACTS)(
    '$file: "$blockTitle" is at or above its baseline count ($baselineCount), all passed, zero skipped',
    ({ blockTitle, baselineCount, reporterSource }) => {
      const assertions = reporterSource === 'api' ? apiAssertions : webAssertions;
      const result = countUnderAncestor(assertions, blockTitle);

      expect(result.total).toBeGreaterThan(0);
      expect(result.nonPassing).toEqual([]);
      expect(result.passed).toBe(result.total);
      expect(result.total).toBeGreaterThanOrEqual(baselineCount);

      observedCounts[blockTitle] = result.total;
    },
    150_000,
  );

  it('records the observed per-block passing counts for the SUMMARY', () => {
    // Populated by the it.each block above; this assertion exists so a
    // reader (or the SUMMARY-writing step) has a single place to read the
    // final tally from, and so an empty record fails loudly.
    expect(Object.keys(observedCounts).length).toBe(LOCKED_CONTRACTS.length);
  });

  it('fixture: the ancestry check is NOT file-granular — an emptied block fails even while a sibling block in the same file keeps passing', () => {
    const guttedFileAssertions: ReporterAssertion[] = [
      // The "healthy" sibling block in the SAME (synthetic) file — still
      // has 3 passing tests.
      { ancestorTitles: ['a healthy sibling block'], status: 'passed' },
      { ancestorTitles: ['a healthy sibling block'], status: 'passed' },
      { ancestorTitles: ['a healthy sibling block'], status: 'passed' },
      // The LOCKED block itself has been gutted — its `describe` still
      // exists (so the EXISTENCE check above would still pass), but every
      // inner test has been deleted, so zero assertions carry its title.
    ];

    // A file-granular check ("does this FILE have non-zero passing tests?")
    // would pass here (3 healthy tests exist in the "file"). Prove the
    // ancestry check is not that: it must isolate the gutted block's own
    // zero-count and fail its baseline assertion, independent of the
    // sibling block's health.
    const guttedBlockResult = countUnderAncestor(guttedFileAssertions, 'a gutted locked block');
    expect(guttedBlockResult.total).toBe(0);
    expect(() => {
      // Mirrors the it.each assertion above verbatim, against a baseline of
      // 1 (any real locked contract's baseline is >= 1) — this is the exact
      // check that must throw for a gutted block, and does.
      expect(guttedBlockResult.total).toBeGreaterThanOrEqual(1);
    }).toThrow();

    // Sanity check that the fixture itself is non-vacuous: the sibling
    // block's own count IS healthy, proving this failure is specific to the
    // gutted block, not an artifact of an empty fixture array.
    const siblingResult = countUnderAncestor(guttedFileAssertions, 'a healthy sibling block');
    expect(siblingResult.total).toBe(3);
    expect(siblingResult.passed).toBe(3);
  });
});

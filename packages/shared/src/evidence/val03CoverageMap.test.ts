import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VAL-03 (phase 39 plan 13): the anti-drift test for
 * `records/VAL-03-acceptance-map.md`. Every file the map names as a proof must
 * exist on disk, the DIMENSION table must hold exactly the sixteen AI-SPEC §5
 * dimensions in the spec's order, and the separate owner-decision table must
 * hold exactly D-20 and D-21. The two tables are parsed separately, each
 * scoped by its own heading, so the decision rows can never be absorbed into
 * the sixteen (review C3-M1).
 */

const MAP_PATH = fileURLToPath(new URL('./records/VAL-03-acceptance-map.md', import.meta.url));
const DIMENSION_HEADING = '## Dimension table (AI-SPEC §5, sixteen rows)';
const DECISION_HEADING = '## Owner-decision coverage (D-20 / D-21)';

/** AI-SPEC §5's sixteen dimension names, in the spec's own order. `.planning/` is not tracked, so the list is restated here; the map must match it row for row. */
const AI_SPEC_DIMENSIONS = [
  'Unsupported factual-claim rate',
  'Wrong-number-with-real-ID caught',
  'Unissued claim ID rejected',
  'Prose lint (unlicensed specifics)',
  'Confidence-word licensing',
  'Tier-boundary correctness',
  'Identical-claim-identical-treatment across surfaces',
  'Abstention on starved snapshots',
  '≤3 evidence-linked actions (structural)',
  'Legacy/unvalidated labelling, fail-closed',
  'Refund on validation failure, v2.5 math byte-intact',
  'Gate ordering untouched',
  'Structural absence of paid vocabulary',
  'Own-account-only entry-point scoping (supporting)',
  'Live abstention/usefulness under the real model',
  'Coach-view / prep-debrief entry-point parity, UAT',
] as const;

const ALLOWED_METHODS = ['deterministic-vitest', 'locked-test', 'owner-run-live', 'manual-UAT'];
const NON_TEST_DISPOSITIONS: Readonly<Record<string, string>> = {
  'owner-run-live': 'OWNER-RUN',
  'manual-UAT': 'UAT',
};

/** Package directory -> the `--filter` name its command must use. */
const PACKAGE_FILTERS: ReadonlyArray<[string, string]> = [
  ['packages/shared/', '@smash-tracker/shared'],
  ['apps/api/', '@smash-tracker/api'],
  ['apps/web/', '@smash-tracker/web'],
];

/**
 * The data rows of the ONE markdown table that follows `heading`, stopping at
 * the next `## ` heading. Header and separator rows are excluded. Each row is
 * split into its trimmed cells.
 */
export function parseTableUnder(markdown: string, heading: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(`heading not found: ${heading}`);
  }
  const rows: string[][] = [];
  let seenHeader = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) {
      break;
    }
    if (!line.startsWith('|')) {
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) {
      continue;
    }
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

/** Every backticked repo path (`apps/...` or `packages/...`) in a cell. */
function repoPathsIn(cell: string): string[] {
  return Array.from(cell.matchAll(/`((?:apps|packages)\/[^`\s]+)`/g), (match) => match[1]!);
}

function existsInRepo(repoPath: string): boolean {
  // this file lives at packages/shared/src/evidence/; the repo root is four levels up.
  return existsSync(new URL(`../../../../${repoPath}`, import.meta.url));
}

/** The command must actually run the mapped file: its package filter and its package-relative path both appear. */
function commandRuns(command: string, repoPath: string): boolean {
  const entry = PACKAGE_FILTERS.find(([prefix]) => repoPath.startsWith(prefix));
  if (!entry) {
    return false;
  }
  const [prefix, filter] = entry;
  return command.includes(filter) && command.includes(repoPath.slice(prefix.length));
}

const MARKDOWN = readFileSync(MAP_PATH, 'utf8');
const DIMENSIONS = parseTableUnder(MARKDOWN, DIMENSION_HEADING);
const DECISIONS = parseTableUnder(MARKDOWN, DECISION_HEADING);

// Dimension columns: # | Dimension | Method | Proving artifact | Command | Does NOT prove
const D_NUM = 0;
const D_NAME = 1;
const D_METHOD = 2;
const D_ARTIFACT = 3;
const D_COMMAND = 4;
const D_LIMIT = 5;
// Decision columns: Decision | What it proves | Method | Committed test file | Command | Does NOT prove
const O_ID = 0;
const O_METHOD = 2;
const O_FILES = 3;
const O_COMMAND = 4;
const O_LIMIT = 5;

describe('parseTableUnder is scoped by heading (review C3-M1)', () => {
  it('counts only the rows under its own heading, never a following table', () => {
    const sample = [
      '## A',
      '| x | y |',
      '| - | - |',
      '| 1 | a |',
      '| 2 | b |',
      '',
      '## B',
      '| x | y |',
      '| - | - |',
      '| 3 | c |',
    ].join('\n');
    expect(parseTableUnder(sample, '## A')).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ]);
    expect(parseTableUnder(sample, '## B')).toEqual([['3', 'c']]);
    expect(() => parseTableUnder(sample, '## C')).toThrow();
  });
});

describe('VAL-03 acceptance map: the sixteen AI-SPEC dimensions', () => {
  it('the dimension table has exactly sixteen rows, in the AI-SPEC §5 order', () => {
    expect(DIMENSIONS.length).toBe(AI_SPEC_DIMENSIONS.length);
    expect(DIMENSIONS.map((row) => row[D_NAME])).toEqual([...AI_SPEC_DIMENSIONS]);
    expect(DIMENSIONS.map((row) => row[D_NUM])).toEqual(
      AI_SPEC_DIMENSIONS.map((_, index) => String(index + 1)),
    );
  });

  it('every row has all six cells, and none of them is empty', () => {
    for (const row of DIMENSIONS) {
      expect(row, row[D_NAME]).toHaveLength(6);
      for (const cell of row) {
        expect(cell.length, `${row[D_NAME]}: empty cell`).toBeGreaterThan(0);
      }
    }
  });

  it('every dimension method is one of the four allowed values', () => {
    for (const row of DIMENSIONS) {
      expect(ALLOWED_METHODS, row[D_NAME]).toContain(row[D_METHOD]);
    }
  });

  it('exactly two rows carry a non-test disposition (OWNER-RUN, UAT), each stating what it does not prove', () => {
    const nonTest = DIMENSIONS.filter((row) => row[D_METHOD]! in NON_TEST_DISPOSITIONS);
    expect(nonTest.map((row) => row[D_METHOD]).sort()).toEqual(['manual-UAT', 'owner-run-live']);
    for (const row of nonTest) {
      expect(row[D_ARTIFACT], row[D_NAME]).toBe(NON_TEST_DISPOSITIONS[row[D_METHOD]!]);
      expect(repoPathsIn(row[D_ARTIFACT]!), row[D_NAME]).toEqual([]);
      expect(row[D_LIMIT]!.length, row[D_NAME]).toBeGreaterThan(40);
    }
  });

  it('every test-backed row names at least one committed file, every named file exists on disk, and its command runs it', () => {
    for (const row of DIMENSIONS) {
      if (row[D_METHOD]! in NON_TEST_DISPOSITIONS) {
        continue;
      }
      const paths = repoPathsIn(row[D_ARTIFACT]!);
      expect(paths.length, `${row[D_NAME]} names no committed test`).toBeGreaterThan(0);
      for (const repoPath of paths) {
        expect(existsInRepo(repoPath), `${row[D_NAME]}: ${repoPath} does not exist`).toBe(true);
        expect(
          commandRuns(row[D_COMMAND]!, repoPath),
          `${row[D_NAME]}: command skips ${repoPath}`,
        ).toBe(true);
      }
    }
  });

  it('dimension 1 is proven by the stop-ship suite itself', () => {
    expect(repoPathsIn(DIMENSIONS[0]![D_ARTIFACT]!)).toEqual([
      'packages/shared/src/evidence/val03Acceptance.test.ts',
    ]);
  });
});

describe('VAL-03 acceptance map: owner-decision coverage (D-20 / D-21)', () => {
  it('the decision table has exactly one row per decision, D-20 and D-21, and is not part of the sixteen', () => {
    expect(DECISIONS.map((row) => row[O_ID])).toEqual(['D-20', 'D-21']);
    expect(DIMENSIONS.some((row) => /^D-\d+$/.test(row[D_NUM]!))).toBe(false);
  });

  it('every decision row names existing committed files, a command that runs them, and what it does not prove', () => {
    for (const row of DECISIONS) {
      expect(row, row[O_ID]).toHaveLength(6);
      expect(ALLOWED_METHODS, row[O_ID]).toContain(row[O_METHOD]);
      expect(row[O_COMMAND]!.length, `${row[O_ID]}: empty command`).toBeGreaterThan(0);
      expect(row[O_LIMIT]!.length, `${row[O_ID]}: empty limit`).toBeGreaterThan(0);
      const paths = repoPathsIn(row[O_FILES]!);
      expect(paths.length, `${row[O_ID]} names no committed test`).toBeGreaterThan(0);
      for (const repoPath of paths) {
        expect(existsInRepo(repoPath), `${row[O_ID]}: ${repoPath} does not exist`).toBe(true);
        expect(
          commandRuns(row[O_COMMAND]!, repoPath),
          `${row[O_ID]}: command skips ${repoPath}`,
        ).toBe(true);
      }
    }
  });
});

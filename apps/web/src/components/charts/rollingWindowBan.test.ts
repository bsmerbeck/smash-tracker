import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Plan 41-12 (SC1 / SC2, verifier gap 2, T-41-12-04): the committed, falsifiable oracle for "no rolling
 * win-rate builder ships". Phase 41's success criteria say no rolling-N zigzag ships and the Scouting
 * trend is event-anchored with no rolling window; the first verification found a trailing-5 line still
 * rendering on the Scout page because nothing scanned for the builder itself. This file is in the DEFAULT
 * `pnpm test` suite (deliberately NOT named `*.guard.test.ts`, which the default config excludes).
 *
 * It walks every non-test `.ts` / `.tsx` file under `apps/web/src` AND `packages/shared/src` - a strict
 * superset of every rendered chart surface - with comments stripped first, and bans two things:
 *
 *   ROLLING_IDENTIFIER: any identifier containing `Rolling` or `ROLLING`, or starting `rolling` followed
 *   by an upper-case letter or an underscore (the shipped builder, its point type and its window constant).
 *
 *   TRAILING_WINDOW_SLICE: the structural idiom of a trailing window, a slice that starts at
 *   `Math.max(0, <a> - <b> + 1)` and ends at `<c> + 1`. It catches the same builder under a new name.
 *
 * The ban is unconditional (C3's precedent): there is NO allowlist and NO exemption list. A file that
 * legitimately needed a trailing window would have to change this contract in its own commit, with its own
 * justification, not slip past a list. Positive controls and look-alike negatives below prove each detector
 * fires and does not over-fire; the positive control strings are built in the test body, and the scan never
 * reads test files, so they cannot trip the tree scan themselves.
 *
 * PROVEN FAILING (executed by hand during plan 41-12, reverted before commit - observed messages recorded
 * in the plan's SUMMARY):
 *   (a) Run on the tree as plan 41-12 task 1 left it (the Scout card already swapped, the builder and the
 *       dead `fighterHero.ts` helper not yet deleted), "no non-test source carries a rolling win-rate
 *       builder" went red naming both files:
 *       `rolling win-rate builder offenders: apps/web/src/lib/stats.ts [ROLLING_IDENTIFIER],
 *       apps/web/src/lib/stats.ts [TRAILING_WINDOW_SLICE],
 *       apps/web/src/pages/FighterAnalysis/lib/fighterHero.ts [ROLLING_IDENTIFIER]`.
 *   (b) With (a)'s three offenders still present, a scratch file `apps/web/src/pages/Scout/zzScratch.ts`
 *       holding a RENAMED builder (`trailingForm`) that used the trailing-window slice idiom added a
 *       fourth entry to the same case's message: `apps/web/src/pages/Scout/zzScratch.ts
 *       [TRAILING_WINDOW_SLICE]` (no ROLLING_IDENTIFIER entry for it - the identifier detector stayed
 *       silent, which is the reason the idiom detector exists). The scratch file was deleted before commit.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SCAN_ROOTS = ['apps/web/src', 'packages/shared/src'];

/** Non-vacuity floors (measured at plan 41-12: see the SUMMARY): the walker must see most of each real tree. */
const MIN_SCANNED_WEB_FILES = 430;
const MIN_SCANNED_SHARED_FILES = 100;

export const ROLLING_IDENTIFIER = /\b\w*(?:Rolling|ROLLING)\w*\b|\brolling[A-Z_]\w*\b/;
export const TRAILING_WINDOW_SLICE =
  /\.slice\(\s*Math\.max\(\s*0\s*,\s*[\w.$]+\s*-\s*[\w.$]+\s*\+\s*1\s*\)\s*,\s*[\w.$]+\s*\+\s*1\s*\)/;

const DETECTORS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'ROLLING_IDENTIFIER', pattern: ROLLING_IDENTIFIER },
  { name: 'TRAILING_WINDOW_SLICE', pattern: TRAILING_WINDOW_SLICE },
];

/** Strip block and line comments so a doc comment that names the banned text is never a hit (copied from `localeFormatting.test.ts`). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function detectorsHitting(source: string): string[] {
  const stripped = stripComments(source);
  return DETECTORS.filter((detector) => detector.pattern.test(stripped)).map(
    (detector) => detector.name,
  );
}

const SKIPPED_DIRECTORIES = new Set(['locales', 'node_modules', 'dist']);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function filesUnder(root: string): Array<{ rel: string; source: string }> {
  return sourceFiles(path.join(REPO_ROOT, root)).map((file) => ({
    rel: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
    source: fs.readFileSync(file, 'utf8'),
  }));
}

const FILES_BY_ROOT = Object.fromEntries(SCAN_ROOTS.map((root) => [root, filesUnder(root)]));

describe('no rolling win-rate builder ships (SC1 / SC2, plan 41-12)', () => {
  describe('ROLLING_IDENTIFIER', () => {
    it.each([
      [
        'the pre-41-12 Scout call line',
        'const trendSeries = getRollingWinRate(matches, ROLLING_WINDOW);',
      ],
      [
        'the stats builder declaration',
        'export function getRollingWinRate(matches: Match[], window = 10) {',
      ],
      ['the point type name', 'export interface RollingWinRatePoint {'],
      ['an upper-case window constant', 'const ROLLING_WINDOW = 5;'],
      ['a lower-case-led builder', 'const rollingAverage = rollingWinRate(series);'],
    ])('matches %s', (_label, source) => {
      expect(ROLLING_IDENTIFIER.test(source)).toBe(true);
    });

    it.each([
      ['isScrollingDown', 'const isScrollingDown = false;'],
      ['scrollingContainer', 'const scrollingContainer = ref.current;'],
      ['Enrolling', 'function Enrolling() {}'],
      ['a plain tail slice', 'const tail = series.slice(-60);'],
    ])('does not match the look-alike %s', (_label, source) => {
      expect(ROLLING_IDENTIFIER.test(source)).toBe(false);
    });
  });

  describe('TRAILING_WINDOW_SLICE', () => {
    it('matches the trailing-window slice idiom from the deleted stats builder', () => {
      expect(
        TRAILING_WINDOW_SLICE.test(
          'const slice = sorted.slice(Math.max(0, i - window + 1), i + 1);',
        ),
      ).toBe(true);
    });

    it('matches the same idiom inside a renamed builder with other identifiers and spacing', () => {
      const renamed = [
        'function trailingForm(games: Match[], span: number) {',
        '  return games.map((g, idx) => games.slice( Math.max( 0 , idx - span + 1 ) , idx + 1 ));',
        '}',
      ].join('\n');
      expect(TRAILING_WINDOW_SLICE.test(renamed)).toBe(true);
      expect(ROLLING_IDENTIFIER.test(renamed)).toBe(false);
    });

    it.each([
      ['a head slice', 'const top = sorted.slice(0, 5);'],
      ['a tail slice', 'const tail = series.slice(-60);'],
      ['a bounded tail slice', 'const tail = arr.slice(Math.max(0, len - 60));'],
    ])('does not match the look-alike %s', (_label, source) => {
      expect(TRAILING_WINDOW_SLICE.test(source)).toBe(false);
    });
  });

  it('a source whose only mention of a rolling builder is inside a comment yields zero hits', () => {
    const commented = [
      '/** The old getRollingWinRate builder (ROLLING_WINDOW = 5) was deleted. */',
      '// sorted.slice(Math.max(0, i - window + 1), i + 1) is the idiom this repo bans',
      'export const x = 1;',
    ].join('\n');
    expect(detectorsHitting(commented)).toEqual([]);
  });

  it('is not vacuous: the walker sees most of each real tree', () => {
    expect(FILES_BY_ROOT['apps/web/src']!.length).toBeGreaterThanOrEqual(MIN_SCANNED_WEB_FILES);
    expect(FILES_BY_ROOT['packages/shared/src']!.length).toBeGreaterThanOrEqual(
      MIN_SCANNED_SHARED_FILES,
    );
  });

  it('no non-test source carries a rolling win-rate builder', () => {
    const offenders = SCAN_ROOTS.flatMap((root) =>
      FILES_BY_ROOT[root]!.flatMap((file) =>
        detectorsHitting(file.source).map((name) => `${file.rel} [${name}]`),
      ),
    );
    expect(offenders, `rolling win-rate builder offenders: ${offenders.join(', ')}`).toEqual([]);
  });
});

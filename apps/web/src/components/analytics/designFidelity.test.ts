import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 39.1 Plan 36 (design-audit pattern P1, INS-04 / D-07): the design-
 * fidelity source-tree guard. A default-suite file (deliberately NOT named
 * `*.guard.test.ts`, which `vitest.config.ts` excludes from `pnpm test`).
 * Scaffolding (repo-relative walker, `toRepoRelative`, non-vacuity canary,
 * shrink-only allowlist with an anti-rot assertion) copied from
 * `layoutIdioms.test.ts`. Plans 39.1-37..39 extend this file.
 *
 * Rule 1 — one ladder-to-chip mapping: `deltaChipView.ts` is the ONLY non-
 * test file under `apps/web/src` that may declare the private honesty-
 * ladder-to-DeltaChip helpers (`deltaChipStateFor` / `deltaValueLabel`).
 * Nine files carried a private copy before this plan, every one of which
 * labelled the `none` state with the word for `thin` and mapped a sub-floor
 * window to a chip the sketches never draw.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SELF_PATH = 'apps/web/src/components/analytics/designFidelity.test.ts';
const CHIP_VIEW_PATH = 'apps/web/src/components/analytics/deltaChipView.ts';

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

function readRepoFile(repoRelativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, repoRelativePath), 'utf8');
}

/** Non-test `.ts`/`.tsx` files under `apps/web/src`. */
const NON_TEST_FILES = listSourceFiles().filter((file) => !/\.test\.tsx?$/.test(file));

/** A private ladder-to-chip or chip-label helper declaration (function or const binding). */
const PRIVATE_CHIP_HELPER_PATTERN =
  /\bfunction\s+(deltaChipStateFor|deltaValueLabel)\b|\b(?:const|let)\s+(deltaChipStateFor|deltaValueLabel)\s*=/;

/**
 * Measured by a real grep at plan-execution time (2026-09-25,
 * `grep -rlE "function (deltaChipStateFor|deltaValueLabel)\b" apps/web/src`),
 * never recalled. Shrink-only: an entry that no longer declares a private
 * helper fails the anti-rot assertion below.
 *
 * - The five hosts plan 39.1-36 Task 2 converts to `deltaChipView`.
 * - `MatchWinLossCard.tsx` and `PairingOpponents.tsx`: the Matchups record
 *   card and By-opponent rows, which plans 39.1-44/45 remove or rebuild on
 *   sketch 003-A and adopt `deltaChipView` there (coordinator instruction
 *   2026-09-25: this plan does not edit them).
 */
const KNOWN_PRIVATE_CHIP_HELPERS: readonly string[] = [
  'apps/web/src/pages/Dashboard/components/HeroStats.tsx',
  'apps/web/src/pages/FighterAnalysis/components/VsCharactersList.tsx',
  'apps/web/src/pages/FighterAnalysis/components/VsPlayersList.tsx',
  'apps/web/src/pages/Matchups/components/MatchWinLossCard.tsx',
  'apps/web/src/pages/Matchups/components/PairingOpponents.tsx',
  'apps/web/src/pages/Trends/components/SettingComparison.tsx',
  'apps/web/src/pages/Trends/components/TrendsHero.tsx',
];

describe('design fidelity — source-tree guard (plan 39.1-36)', () => {
  it('the default suite excludes the .guard.test.ts suffix (this file is deliberately NOT named with it)', () => {
    const vitestConfigSource = readRepoFile('apps/web/vitest.config.ts');
    expect(vitestConfigSource).toMatch(/guard\.test\.ts/);
    expect(SELF_PATH).not.toMatch(/\.guard\.test\.ts$/);
  });

  it("the scanned file set is non-empty, contains the mapping module and excludes this guard's own source (base-mismatch canary)", () => {
    expect(NON_TEST_FILES.length).toBeGreaterThan(100);
    expect(NON_TEST_FILES).toContain(CHIP_VIEW_PATH);
    expect(NON_TEST_FILES).not.toContain(SELF_PATH);
  });

  describe('one ladder-to-chip mapping (deltaChipView)', () => {
    it('the pattern detects a private helper declaration (non-vacuity)', () => {
      const fixtures = [
        "function deltaChipStateFor(state: InsightState): DeltaChipState { return 'steady'; }",
        'function deltaValueLabel(state, deltaPoints, t) {}',
        'const deltaChipStateFor = (state) => state;',
      ];
      for (const fixture of fixtures) {
        expect(PRIVATE_CHIP_HELPER_PATTERN.test(fixture), fixture).toBe(true);
      }
      expect(PRIVATE_CHIP_HELPER_PATTERN.test('import { deltaChipView } from "x";')).toBe(false);
    });

    it('no non-test file other than deltaChipView.ts declares a private ladder-to-chip helper, except the allowlist', () => {
      const allowlistSet = new Set(KNOWN_PRIVATE_CHIP_HELPERS);
      const offenders = NON_TEST_FILES.filter(
        (file) =>
          file !== CHIP_VIEW_PATH &&
          !allowlistSet.has(file) &&
          PRIVATE_CHIP_HELPER_PATTERN.test(readRepoFile(file)),
      );
      expect(offenders).toEqual([]);
    });

    it('the allowlist cannot rot: every entry still exists and still declares a private helper', () => {
      const stale = KNOWN_PRIVATE_CHIP_HELPERS.filter((file) => {
        const fullPath = path.join(REPO_ROOT, file);
        if (!fs.existsSync(fullPath)) return true;
        return !PRIVATE_CHIP_HELPER_PATTERN.test(fs.readFileSync(fullPath, 'utf8'));
      });
      expect(stale, `stale allowlist entries: ${stale.join(', ')}`).toEqual([]);
    });

    it('the mapping module itself exports deltaChipView', () => {
      const exists = fs.existsSync(path.join(REPO_ROOT, CHIP_VIEW_PATH));
      expect(exists, `${CHIP_VIEW_PATH} exists`).toBe(true);
      expect(readRepoFile(CHIP_VIEW_PATH)).toMatch(/export function deltaChipView\b/);
    });
  });
});

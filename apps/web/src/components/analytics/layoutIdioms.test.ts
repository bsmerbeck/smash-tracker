import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 39.1 Plan 09 (UI-SPEC §13.3/§13.4): the layout-idiom guard — the
 * `justify-evenly`/`justify-around` grid-collision ban, the page-local
 * stat-component ban, and the nested-scroller ban. A default-suite file
 * (deliberately NOT named `*.guard.test.ts`, which `vitest.config.ts`
 * excludes from `pnpm test` — verified by this file's own first test).
 * Scaffolding (repo-relative path base, recursive walker, `toRepoRelative`,
 * named shrink-only allowlists with an anti-rot assertion) copied verbatim
 * from `apps/web/src/components/charts/chartKitBoundary.test.ts`.
 *
 * PROVEN FAILING (RED phase, `test(39.1-09)` commit): with every allowlist
 * below seeded EMPTY, all three assertions failed against the real tree —
 * `justify-evenly`/`justify-around` found in 3 files, the stat-component
 * pattern found in 6 files (including the 2 permanent GSP exemptions), and
 * the nested max-h/overflow-y pair found in 12 files. See the plan's
 * SUMMARY for the exact recorded run. The GREEN phase (`feat(39.1-09)`
 * commit) seeds each allowlist from that measured run.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PAGES_DIR = 'apps/web/src/pages/';
const CHARTS_DIR = 'apps/web/src/components/charts/';
const ANALYTICS_DIR = 'apps/web/src/components/analytics/';
const SELF_PATH = 'apps/web/src/components/analytics/layoutIdioms.test.ts';

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

const SOURCE_FILES = listSourceFiles();

/** Non-test `.tsx` files under `apps/web/src/pages/`. */
const PAGES_FILES = SOURCE_FILES.filter(
  (file) => file.startsWith(PAGES_DIR) && !/\.test\.tsx?$/.test(file),
);
/** Non-test `.tsx` files under `apps/web/src/components/charts/`. */
const CHARTS_FILES = SOURCE_FILES.filter(
  (file) => file.startsWith(CHARTS_DIR) && !/\.test\.tsx?$/.test(file),
);
/** Non-test `.tsx` files under `apps/web/src/components/analytics/`, excluding this guard's own deliberately-broken proving fixtures. */
const ANALYTICS_FILES = SOURCE_FILES.filter(
  (file) =>
    file.startsWith(ANALYTICS_DIR) &&
    !/\.test\.tsx?$/.test(file) &&
    !file.includes(`${ANALYTICS_DIR}guardFixtures/`),
);

/** §13.3: `justify-evenly`/`justify-around` — a grid with a `gap` cannot collide; this is the idiom `StatRow` replaces. */
const FLEX_DISTRIBUTION_PATTERN = /justify-(evenly|around)\b/;

/**
 * Measured by a real grep at plan-execution time (2026-09-20), never
 * recalled (37 D-20). Shrink-only: an entry that no longer contains the
 * banned utility fails the anti-rot assertion below, so this array could
 * only ever shrink toward empty as Track C converted each file.
 *
 * TERMINAL STATE (plan 39.1-20): `StatTile.tsx` was the sole remaining
 * entry (measured before this plan: `['apps/web/src/components/charts/
 * StatTile.tsx']`, length 1) — this plan rewrites it as a thin wrapper over
 * `StatRow`, so the array is now EMPTY (measured after: `[]`, length 0) and
 * is expected to STAY empty: every file under `pages/` and `components/
 * charts/` uses the one stat idiom for this pattern, with no known-offender
 * allowlist left to shrink-track.
 */
const KNOWN_FLEX_DISTRIBUTION_OFFENDERS: string[] = [];

/** §13.4: a page-local component whose name begins with one of the closed stat-idiom names — the defect `StatRow`/`StatFigure` replace. */
const STAT_COMPONENT_NAME_PATTERN = /\bfunction\s+(Stat|HeroCard|StatBlock|SettingBlock)\b/;

/**
 * The two GSP entries handed to Phase 41 (DD-13) — a PERMANENT exemption,
 * not shrink-only like the array below, but still anti-rot checked (an
 * entry that stops declaring the pattern is stale).
 */
const STAT_COMPONENT_GSP_ALLOWLIST = [
  'apps/web/src/pages/Gsp/components/GspHero.tsx',
  'apps/web/src/pages/Gsp/components/GainsAnalysis.tsx',
];

/**
 * Measured by a real grep at plan-execution time (2026-09-20). Shrink-only:
 * Track C empties this array as each page adopts `StatRow`/`StatFigure`.
 */
const STAT_COMPONENT_KNOWN_OFFENDERS: string[] = [];

/** §6.4: a `max-h-*` utility paired with a vertical-overflow utility in the same file — a nested scroller inside an analytics surface. */
const MAX_HEIGHT_PATTERN = /\bmax-h-[^\s"'`]+/;
const VERTICAL_OVERFLOW_PATTERN = /\boverflow-y-(auto|scroll)\b/;

/**
 * Measured by a real grep at plan-execution time (2026-09-20): every
 * `pages/**` file where BOTH patterns occur, including files whose scroller
 * is a dialog/modal's own internal scroll (unrelated to an analytics CARD
 * nesting a scroller, but still measured and named here rather than
 * silently passed — a shrink-only allowlist may only ever remove an entry,
 * never explain one away). Track C converts the four analytics-card
 * offenders UI-SPEC §6.4 names by file (`MatchupStageGuide.tsx`,
 * `OpponentTable.tsx`, `MonthlyPerformance.tsx`, `StageDetailPage.tsx`); the
 * remaining eight are dialog/form scroll regions outside this phase's scope
 * and stay allowlisted until a future phase addresses dialogs.
 *
 * Plan 39.1-18: `StageDetailPage.tsx` removed — both its by-opponent and
 * by-character tables converted to the `LIST_CAP`/`LIST_CAP_RAIL` cap-ladder
 * idiom (`OpponentTable.tsx`'s precedent), in the SAME commit as this
 * removal, since the anti-rot assertion below fails the instant the fix
 * lands without it.
 */
const NESTED_SCROLLER_KNOWN_OFFENDERS = [
  'apps/web/src/pages/Matchups/components/SetStateControl.tsx',
  'apps/web/src/pages/Dashboard/components/AddMatchForm.tsx',
  'apps/web/src/pages/Review/components/DeliveryVodNotesTab.tsx',
  'apps/web/src/pages/VodManager/MySharesDialog.tsx',
  'apps/web/src/pages/VodManager/components/VodMatchList.tsx',
  'apps/web/src/pages/Tournaments/components/RulesetOverrideSection.tsx',
  'apps/web/src/pages/Coaching/ReviewComposerPage.tsx',
  'apps/web/src/pages/Coaching/components/DeliveryVodPicker.tsx',
];

/**
 * §13.7 / UIX-07 (plan 39.1-20): the eight analytics pages this phase
 * rebuilds onto the one `CardSkeleton`-based loading pattern — named
 * explicitly, not derived from a directory scan, so the non-vacuity canary
 * below can assert the scanned set is exactly this size rather than
 * "whatever glob happened to match."
 */
const ANALYTICS_PAGE_FILES = [
  'apps/web/src/pages/Dashboard/DashboardPage.tsx',
  'apps/web/src/pages/FighterAnalysis/FighterAnalysisPage.tsx',
  'apps/web/src/pages/Matchups/MatchupsPage.tsx',
  'apps/web/src/pages/MatchData/MatchDataPage.tsx',
  'apps/web/src/pages/Trends/TrendsPage.tsx',
  'apps/web/src/pages/Opponents/OpponentsPage.tsx',
  'apps/web/src/pages/Opponents/OpponentHubPage.tsx',
  'apps/web/src/pages/Stages/StageDetailPage.tsx',
];

/** The text-loading-line idiom §7.2/§13.7 replaces — a `text-muted-foreground` div wrapping a `t('…loading')` call, literally `<div className="text-muted-foreground">{t('…loading')}</div>`. */
const TEXT_LOADING_LINE_PATTERN =
  /<div className="text-muted-foreground">\{t\('[^']*\.loading'\)\}<\/div>/;

describe('layout idioms — source-tree guard (UIX-04, §13.3/§13.4)', () => {
  it('the default suite excludes the .guard.test.ts suffix (this file is deliberately NOT named with it)', () => {
    const vitestConfigSource = readRepoFile('apps/web/vitest.config.ts');
    expect(vitestConfigSource).toMatch(/guard\.test\.ts/);
    expect(SELF_PATH).not.toMatch(/\.guard\.test\.ts$/);
  });

  it("the scanned file sets are non-empty and exclude this guard's own source (base-mismatch canary)", () => {
    expect(PAGES_FILES.length).toBeGreaterThan(0);
    expect(CHARTS_FILES.length).toBeGreaterThan(0);
    expect(ANALYTICS_FILES.length).toBeGreaterThan(0);
    expect(PAGES_FILES).not.toContain(SELF_PATH);
  });

  it('a zero-length scanned set fails the non-vacuity assertion above rather than letting every offender assertion pass vacuously', () => {
    // Mechanical statement of the canary above: `toBeGreaterThan(0)` against
    // an empty array is itself a failing assertion, so a future change that
    // accidentally scoped `PAGES_FILES`/`CHARTS_FILES`/`ANALYTICS_FILES` down
    // to nothing would fail THAT test, not silently pass every offender
    // check below (which would vacuously report zero offenders over zero
    // files scanned).
    const emptyScan: string[] = [];
    expect(() => expect(emptyScan.length).toBeGreaterThan(0)).toThrow();
  });

  describe('§13.3 — no justify-evenly/justify-around outside the allowlist', () => {
    it('no file under pages/ or components/charts/ uses the banned flex-distribution utility, except the allowlist', () => {
      const allowlistSet = new Set(KNOWN_FLEX_DISTRIBUTION_OFFENDERS);
      const scanned = [...PAGES_FILES, ...CHARTS_FILES];
      const offenders = scanned.filter(
        (file) => !allowlistSet.has(file) && FLEX_DISTRIBUTION_PATTERN.test(readRepoFile(file)),
      );
      expect(offenders).toEqual([]);
    });

    it('the allowlist cannot rot: every entry still contains the banned utility', () => {
      const stale = KNOWN_FLEX_DISTRIBUTION_OFFENDERS.filter((file) => {
        const fullPath = path.join(REPO_ROOT, file);
        if (!fs.existsSync(fullPath)) return true;
        return !FLEX_DISTRIBUTION_PATTERN.test(fs.readFileSync(fullPath, 'utf8'));
      });
      expect(stale, `stale allowlist entries: ${stale.join(', ')}`).toEqual([]);
    });

    it('has reached its terminal empty state (plan 39.1-20 converted StatTile.tsx, the last known offender)', () => {
      // The "not vacuous — matches at least one real offender" shape this
      // test used to have is no longer meaningful: there is no longer a
      // known-offender entry FOR this pattern to prove against, by design.
      // A zero-violation, zero-allowlist state IS the correct terminal claim
      // — asserting it directly (rather than vacuously `.some()`-ing over an
      // empty array, which would silently read `false` on this same line
      // without this rewrite) keeps the guard honest about which state it's
      // actually in.
      expect(KNOWN_FLEX_DISTRIBUTION_OFFENDERS).toEqual([]);
    });
  });

  describe('§13.4 — no page-local stat-component declaration outside the allowlists', () => {
    it('no file under pages/ declares a Stat/HeroCard/StatBlock/SettingBlock-named function, except the GSP allowlist and the measured known-offenders', () => {
      const allowlistSet = new Set([
        ...STAT_COMPONENT_GSP_ALLOWLIST,
        ...STAT_COMPONENT_KNOWN_OFFENDERS,
      ]);
      const offenders = PAGES_FILES.filter(
        (file) => !allowlistSet.has(file) && STAT_COMPONENT_NAME_PATTERN.test(readRepoFile(file)),
      );
      expect(offenders).toEqual([]);
    });

    it('the GSP allowlist cannot rot', () => {
      const stale = STAT_COMPONENT_GSP_ALLOWLIST.filter(
        (file) => !STAT_COMPONENT_NAME_PATTERN.test(readRepoFile(file)),
      );
      expect(stale, `stale GSP allowlist entries: ${stale.join(', ')}`).toEqual([]);
    });

    it('the known-offender allowlist cannot rot', () => {
      const stale = STAT_COMPONENT_KNOWN_OFFENDERS.filter(
        (file) => !STAT_COMPONENT_NAME_PATTERN.test(readRepoFile(file)),
      );
      expect(stale, `stale known-offender entries: ${stale.join(', ')}`).toEqual([]);
    });
  });

  describe('§6.4 — no nested vertical scroller outside the allowlist', () => {
    it('no file under pages/ or components/analytics/ pairs max-h-* with overflow-y-auto|scroll, except the allowlist', () => {
      const allowlistSet = new Set(NESTED_SCROLLER_KNOWN_OFFENDERS);
      const scanned = [...PAGES_FILES, ...ANALYTICS_FILES];
      const offenders = scanned.filter((file) => {
        if (allowlistSet.has(file)) return false;
        const source = readRepoFile(file);
        return MAX_HEIGHT_PATTERN.test(source) && VERTICAL_OVERFLOW_PATTERN.test(source);
      });
      expect(offenders).toEqual([]);
    });

    it('the nested-scroller allowlist cannot rot: every entry still pairs both utilities', () => {
      const stale = NESTED_SCROLLER_KNOWN_OFFENDERS.filter((file) => {
        const fullPath = path.join(REPO_ROOT, file);
        if (!fs.existsSync(fullPath)) return true;
        const source = fs.readFileSync(fullPath, 'utf8');
        return !(MAX_HEIGHT_PATTERN.test(source) && VERTICAL_OVERFLOW_PATTERN.test(source));
      });
      expect(stale, `stale nested-scroller allowlist entries: ${stale.join(', ')}`).toEqual([]);
    });
  });

  describe('§13.7 — one loading pattern across the eight analytics pages (UIX-07, plan 39.1-20)', () => {
    it('the scanned analytics-page set contains exactly the eight named files (non-vacuity canary)', () => {
      expect(ANALYTICS_PAGE_FILES).toHaveLength(8);
      for (const file of ANALYTICS_PAGE_FILES) {
        expect(fs.existsSync(path.join(REPO_ROOT, file)), `missing: ${file}`).toBe(true);
      }
    });

    it('none of the eight analytics pages still renders the muted-text loading line', () => {
      const offenders = ANALYTICS_PAGE_FILES.filter((file) =>
        TEXT_LOADING_LINE_PATTERN.test(readRepoFile(file)),
      );
      expect(offenders).toEqual([]);
    });

    it('a zero-length analytics-page set fails the non-vacuity assertion rather than vacuously passing the loading-line check', () => {
      const emptySet: string[] = [];
      expect(() => expect(emptySet).toHaveLength(8)).toThrow();
    });

    it('every one of the eight pages composes a page skeleton from CardSkeleton (positive presence check)', () => {
      const missing = ANALYTICS_PAGE_FILES.filter(
        (file) => !readRepoFile(file).includes('CardSkeleton'),
      );
      expect(missing, `pages missing CardSkeleton: ${missing.join(', ')}`).toEqual([]);
    });
  });
});

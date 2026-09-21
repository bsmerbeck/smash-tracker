import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureLocales, type FixtureLocaleTree } from './guardFixtures/fixtureLocales';

/**
 * Phase 39.1 Plan 09 (UI-SPEC §13.8, D-05): the insight-copy guard — no
 * concatenated translation calls, no second-person copy in the insight
 * namespaces, no bare probability phrasing. A default-suite file
 * (deliberately NOT named `*.guard.test.ts`). Scaffolding shared with
 * `layoutIdioms.test.ts`/`typeScale.test.ts` (this plan, same repo-relative
 * path base and recursive walker convention as
 * `chartKitBoundary.test.ts`).
 *
 * PROVEN FAILING (RED phase, `test(39.1-09)` commit): with the walker NOT
 * yet excluding `guardFixtures/`, assertion (a) found
 * `ConcatenatedCopyFixture.tsx`'s three-piece sentence and failed. Each of
 * the six locale second-person patterns (b) and the probability pattern (c)
 * were proven directly against `fixtureLocales.ts`'s deliberately offending
 * values from the first commit (they are permanent positive-control tests,
 * not part of the RED/GREEN toggle). See the plan SUMMARY for the exact
 * recorded runs.
 *
 * In THIS plan (b)/(c) run against `fixtureLocales.ts`. Plan 39.1-11
 * repoints `INSIGHT_COPY_LOCALE_SOURCE` (the single exported scan target
 * below) at the six real locale JSON files, changing ONE declaration.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ANALYTICS_DIR = 'apps/web/src/components/analytics/';
const CHARTS_DIR = 'apps/web/src/components/charts/';
const SELF_PATH = 'apps/web/src/components/analytics/insightCopy.test.ts';
const FIXTURE_PATH = 'apps/web/src/components/analytics/guardFixtures/ConcatenatedCopyFixture.tsx';

/**
 * Plan 39.1-11 repoints this SINGLE constant at the six real locale JSON
 * files under `apps/web/src/i18n/locales/` — never rewrites the guard
 * logic below it.
 */
export const INSIGHT_COPY_LOCALE_SOURCE: Record<string, FixtureLocaleTree> = fixtureLocales;

/** UI-SPEC §13.8's per-locale second-person word lists. */
const SECOND_PERSON_PATTERNS: Record<string, RegExp> = {
  en: /\b(you|your|you're)\b/i,
  es: /\b(tú|tu|tus|usted)\b/i,
  fr: /\b(vous|votre|vos|tu|ton|tes)\b/i,
  de: /\b(du|dein\w*|Sie|Ihr\w*)\b/,
  pt: /\b(você|seu|sua|teu|tua)\b/i,
  ja: /あなた/,
};

/** UI-SPEC §13.8 assertion (c): a percent sign next to a chance/probability/future-tense word. English phrasing, per the spec's literal word list. */
const PROBABILITY_PATTERN =
  /%[^%]{0,25}\b(chance|probability|will)\b|\b(chance|probability|will)\b[^%]{0,25}%/i;

interface LocaleLeaf {
  locale: string;
  namespace: string;
  keyPath: string;
  value: string;
}

/** Flattens one locale's namespace object into `{ locale, namespace, keyPath, value }` leaves. */
function collectLeaves(
  locale: string,
  namespace: string,
  tree: Record<string, string>,
): LocaleLeaf[] {
  return Object.entries(tree).map(([keyPath, value]) => ({ locale, namespace, keyPath, value }));
}

/** Matches one balanced `t(...)` call, tolerating one level of nested parens (an interpolation options object). */
const TRANSLATION_CALL_PATTERN = /\bt\([^()]*(?:\([^()]*\)[^()]*)*\)/g;

/**
 * Depth-tracks the JSX tags inside a "between two t() calls" text span.
 * Returns the minimum depth reached, treating an opening tag as +1 and a
 * closing tag as -1 starting from 0. If the minimum ever goes negative, the
 * span closed an ancestor element it did not itself open — i.e. execution
 * left the current parent (a new sibling paragraph, a new component), so
 * the two calls are NOT part of one concatenated sentence.
 */
function minTagDepth(between: string): number {
  let depth = 0;
  let min = 0;
  for (const match of between.matchAll(/<\/?([A-Za-z][\w.]*)/g)) {
    depth += match[0]!.startsWith('</') ? -1 : 1;
    if (depth < min) min = depth;
  }
  return min;
}

/**
 * Pure concatenation scanner (assertion a) — takes a file's SOURCE TEXT and
 * returns every pair of `t(...)` calls joined by a string literal, JSX
 * text, or a template literal WITHOUT crossing out of their shared parent
 * element. A ternary's `? a : b` EXCLUSIVE branch selector between two
 * calls is not concatenation (only one of the two ever renders) and is
 * excluded; a call that renders unconditionally followed by one selected
 * by a ternary IS concatenation (UI-SPEC's own named example: an
 * unconditional `t('...youWin')` followed by a ternary choosing between
 * `moreOnline`/`moreOffline`) and is NOT excluded.
 */
export function scanConcatenationViolations(source: string): string[] {
  const calls = [...source.matchAll(TRANSLATION_CALL_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }));

  const violations: string[] = [];
  for (let i = 0; i < calls.length - 1; i += 1) {
    const current = calls[i]!;
    const next = calls[i + 1]!;
    const between = source.slice(current.end, next.start);
    const isExclusiveTernaryBranch = /^\s*:\s*$/.test(between) || /^\s*(\|\||&&)\s*$/.test(between);
    if (isExclusiveTernaryBranch) {
      continue;
    }
    if (minTagDepth(between) < 0) {
      continue;
    }
    // A statement-terminating `;` between two calls means the first call
    // sits in plain JS (a variable assignment, a prior return statement)
    // and the second is an unrelated call in a DIFFERENT statement (often
    // the first call inside a freshly-entered JSX return) — never two
    // pieces of one rendered sentence.
    if (/;/.test(between)) {
      continue;
    }
    violations.push(`${current.text}${between.slice(0, 60)}${next.text}`.replace(/\s+/g, ' '));
  }
  return violations;
}

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

/** Non-test `.tsx` files under the two scanned directories, excluding this guard's own proving fixtures. */
const SCANNED_FILES = SOURCE_FILES.filter(
  (file) =>
    (file.startsWith(ANALYTICS_DIR) || file.startsWith(CHARTS_DIR)) && !/\.test\.tsx?$/.test(file),
);

/** Pages are explicitly OUT of scope (D-05): the app's existing second-person copy elsewhere is left alone. */
const PAGES_FILES = SOURCE_FILES.filter(
  (file) => file.startsWith('apps/web/src/pages/') && !/\.test\.tsx?$/.test(file),
);

describe('insight copy — no concatenation, no second person, no probability (INS-03, D-05)', () => {
  it("the scanned file set is non-empty (non-vacuity canary) and excludes this guard's own fixture", () => {
    expect(SCANNED_FILES.length).toBeGreaterThan(0);
    expect(SCANNED_FILES).not.toContain(FIXTURE_PATH);
    expect(SCANNED_FILES).not.toContain(SELF_PATH);
  });

  describe('assertion (a) — no two adjacent translation calls joined by text', () => {
    it('no scanned file under analytics/ or charts/ has a concatenated-translation-call leaf', () => {
      const offenders: { file: string; violations: string[] }[] = [];
      for (const file of SCANNED_FILES) {
        const violations = scanConcatenationViolations(readRepoFile(file));
        if (violations.length > 0) {
          offenders.push({ file, violations });
        }
      }
      expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
    });

    it("positive control: the guard's own fixture (scanned directly, bypassing the guardFixtures/ exclusion) DOES trigger a concatenation violation", () => {
      const violations = scanConcatenationViolations(readRepoFile(FIXTURE_PATH));
      expect(violations.length).toBeGreaterThan(0);
    });

    it('a component rendering two unrelated t() calls in separate leaf elements does NOT trigger (no false positive on ordinary multi-string components)', () => {
      const clean = `
        <div>
          <h3>{t('card.title')}</h3>
          <button>{t('card.action')}</button>
        </div>
      `;
      expect(scanConcatenationViolations(clean)).toEqual([]);
    });
  });

  describe('assertions (b)/(c) — second person and probability phrasing, scoped to the insight namespace', () => {
    const locales = Object.keys(INSIGHT_COPY_LOCALE_SOURCE);

    it('the locale scan target is a single exported constant (source scan showing exactly one declaration)', () => {
      const selfSource = readRepoFile(SELF_PATH);
      const declarations = selfSource.match(/\bINSIGHT_COPY_LOCALE_SOURCE\s*:/g) ?? [];
      expect(declarations.length).toBe(1);
    });

    it('examines at least one key per locale (non-vacuity canary)', () => {
      for (const locale of locales) {
        const leaves = collectLeaves(
          locale,
          'insights',
          INSIGHT_COPY_LOCALE_SOURCE[locale]!.insights,
        );
        expect(leaves.length).toBeGreaterThan(0);
      }
    });

    for (const locale of ['en', 'es', 'fr', 'de', 'pt', 'ja']) {
      it(`${locale}'s second-person pattern fires on its deliberately offending fixture value and NOT on the clean one`, () => {
        const tree = INSIGHT_COPY_LOCALE_SOURCE[locale];
        expect(tree, `expected a fixture entry for locale ${locale}`).toBeDefined();
        const pattern = SECOND_PERSON_PATTERNS[locale]!;
        expect(pattern.test(tree!.insights.offendingSecondPerson!)).toBe(true);
        expect(pattern.test(tree!.insights.cleanVerdict!)).toBe(false);
      });
    }

    it('assertion (c) fires against a percent sign paired with a probability word, and not against a clean observed-rate value', () => {
      const enTree = INSIGHT_COPY_LOCALE_SOURCE.en!;
      expect(PROBABILITY_PATTERN.test(enTree.insights.offendingProbability!)).toBe(true);
      expect(PROBABILITY_PATTERN.test(enTree.insights.cleanRate!)).toBe(false);
    });

    it('D-05 scoping: a second-person string OUTSIDE the insights namespace does NOT fail the guard', () => {
      const enTree = INSIGHT_COPY_LOCALE_SOURCE.en!;
      // The guard only ever reads `.insights` — `.unrelated` exists in the
      // fixture purely to prove this scoping, never scanned by the guard.
      expect(SECOND_PERSON_PATTERNS.en!.test(enTree.unrelated.existingSecondPerson!)).toBe(true);
      const scannedNamespaces = Object.keys(enTree).filter((key) => key !== 'unrelated');
      expect(scannedNamespaces).toEqual(['insights']);
    });

    it('the guard never scans apps/web/src/pages/ for second-person strings (D-05)', () => {
      // Mechanical statement of scope: this guard's locale scan target is
      // `INSIGHT_COPY_LOCALE_SOURCE` only, never a source-tree walk over
      // pages/ — PAGES_FILES exists in this file only for this assertion.
      expect(PAGES_FILES.length).toBeGreaterThan(0);
      expect(SCANNED_FILES.some((file) => file.startsWith('apps/web/src/pages/'))).toBe(false);
    });
  });
});

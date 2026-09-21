import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * `ConcatenatedCopyFixture.tsx`'s three-piece sentence and failed.
 *
 * Plan 39.1-11 (Task 1) repoints the locale-scan half of this guard from
 * plan 39.1-09's small hand-written `guardFixtures/fixtureLocales.ts`
 * object at the SIX REAL locale JSON files under
 * `apps/web/src/i18n/locales/` — the actual shipped `insights`/`analytics`
 * namespace content, not a fixture standing in for it. `fixtureLocales.ts`
 * itself is left uncommented-on and unused by this file from here on (it
 * remains committed for any other guard that may reuse the same shape;
 * removing it is out of this plan's scope). The concatenation scanner
 * (assertion a) is untouched — it still scans real `.tsx` source files via
 * `ConcatenatedCopyFixture.tsx`, which has nothing to do with locale JSON.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ANALYTICS_DIR = 'apps/web/src/components/analytics/';
const CHARTS_DIR = 'apps/web/src/components/charts/';
const SELF_PATH = 'apps/web/src/components/analytics/insightCopy.test.ts';
const FIXTURE_PATH = 'apps/web/src/components/analytics/guardFixtures/ConcatenatedCopyFixture.tsx';

/**
 * The two NEW top-level i18n namespaces this phase introduces (UI-SPEC
 * §9.3) — the only namespaces this guard's second-person/probability/
 * empty-value scan ever reads. `analytics` does not exist yet as of this
 * plan's Task 1 commit (it lands in Task 2); the filter in
 * `buildLocaleSource` below reads whichever of the two are actually present
 * on a given locale module, so this file needs no further edits when Task 2
 * adds `analytics`.
 */
const NEW_NAMESPACE_KEYS = ['insights', 'analytics'] as const;
type NewNamespaceKey = (typeof NEW_NAMESPACE_KEYS)[number];

/**
 * ONE declaration pointing at the locales directory (this plan's own
 * acceptance criterion) — Vite's `import.meta.glob`, eagerly resolving
 * every `*.json` file under `apps/web/src/i18n/locales/` at once, rather
 * than six hand-written `import` statements that would need a new line
 * every time a locale is added.
 */
const REAL_LOCALE_MODULES = import.meta.glob('/src/i18n/locales/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, unknown>>;

function localeCodeFromModulePath(modulePath: string): string {
  const match = /\/([a-z]{2})\.json$/.exec(modulePath);
  if (!match) {
    throw new Error(`Could not extract a two-letter locale code from ${modulePath}`);
  }
  return match[1]!;
}

/** `{ locale-code: real parsed locale JSON module }`, keyed off the glob's file paths. */
function buildLocaleSource(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [modulePath, mod] of Object.entries(REAL_LOCALE_MODULES)) {
    out[localeCodeFromModulePath(modulePath)] = mod;
  }
  return out;
}

/**
 * The single exported locale-scan constant plan 39.1-09 declared and this
 * plan repoints — now the six REAL locale files, keyed by locale code, each
 * holding the FULL parsed document (every existing namespace, not just the
 * two new ones). The scan functions below explicitly narrow to
 * `NEW_NAMESPACE_KEYS` before flattening — the guard scans only `insights`/
 * `analytics`, never the rest of the document, which is exactly D-05's
 * scoping contract proven below.
 */
export const INSIGHT_COPY_LOCALE_SOURCE: Record<
  string,
  Record<string, unknown>
> = buildLocaleSource();

/** UI-SPEC §13.8's per-locale second-person word lists — unchanged from plan 39.1-09. */
const SECOND_PERSON_PATTERNS: Record<string, RegExp> = {
  en: /\b(you|your|you're)\b/i,
  es: /\b(tú|tu|tus|usted)\b/i,
  fr: /\b(vous|votre|vos|tu|ton|tes)\b/i,
  de: /\b(du|dein\w*|Sie|Ihr\w*)\b/,
  pt: /\b(você|seu|sua|teu|tua)\b/i,
  ja: /あなた/,
};

/** UI-SPEC §13.8 assertion (c): a percent sign next to a chance/probability/future-tense word. English phrasing, per the spec's literal word list — unchanged from plan 39.1-09. */
const PROBABILITY_PATTERN =
  /%[^%]{0,25}\b(chance|probability|will)\b|\b(chance|probability|will)\b[^%]{0,25}%/i;

interface LocaleLeaf {
  locale: string;
  namespace: string;
  keyPath: string;
  value: string;
}

/**
 * Recursively flattens one locale's namespace object into
 * `{ locale, namespace, keyPath, value }` leaves — the real `insights`/
 * `analytics` trees nest several levels deep (`insights.state.thinRecent
 * .page.lastEvent`, etc.), unlike plan 39.1-09's flat one-level fixture, so
 * this walker recurses until it hits a non-object value.
 */
function collectLeaves(
  locale: string,
  namespace: string,
  tree: Record<string, unknown>,
  prefix = '',
): LocaleLeaf[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      return collectLeaves(locale, namespace, value as Record<string, unknown>, keyPath);
    }
    return [{ locale, namespace, keyPath, value: String(value) }];
  });
}

/** Every leaf under a locale's `insights`/`analytics` namespaces only — never the rest of the document (D-05 scoping). */
function collectNewNamespaceLeaves(locale: string): LocaleLeaf[] {
  const tree = INSIGHT_COPY_LOCALE_SOURCE[locale];
  if (!tree) {
    throw new Error(`No locale module resolved for ${locale}`);
  }
  return NEW_NAMESPACE_KEYS.filter(
    (namespace): namespace is NewNamespaceKey => tree[namespace] !== undefined,
  ).flatMap((namespace) =>
    collectLeaves(locale, namespace, tree[namespace] as Record<string, unknown>),
  );
}

/**
 * A cheap structural deep-clone (locale namespace trees are plain
 * JSON-shaped data — string/number leaves and plain-object branches only),
 * used by the permanent positive-control tests below to inject a
 * deliberately offending value into a COPY of the real content without
 * ever touching the committed locale files.
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Overwrites one arbitrary existing leaf (by dotted path) in a cloned namespace tree with `newValue`, for a positive-control test. */
function withOverriddenLeaf(
  tree: Record<string, unknown>,
  dottedPath: string,
  newValue: string,
): Record<string, unknown> {
  const clone = deepClone(tree);
  const segments = dottedPath.split('.');
  let node = clone as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i += 1) {
    node = node[segments[i]!] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = newValue;
  return clone;
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
    (file.startsWith(ANALYTICS_DIR) || file.startsWith(CHARTS_DIR)) &&
    !/\.test\.tsx?$/.test(file) &&
    !file.includes('guardFixtures/'),
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

  describe('assertions (b)/(c)/(d) — second person, probability and empty values, scoped to insights/analytics (Plan 39.1-11: real locale files)', () => {
    const REAL_LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'ja'] as const;

    /**
     * Measured directly against the six real locale files at Task 1's
     * commit time (the `insights.{kind,rail,door,chip,horizon,evidence,
     * state}` shared vocabulary — 61 leaf keys per locale). A floor, not an
     * exact match: Task 2 lands ~86 more per-template keys plus the
     * `analytics` namespace on top of this without needing this number
     * changed, since every later addition only grows the count.
     */
    const MEASURED_MIN_NEW_NAMESPACE_KEYS_PER_LOCALE = 61;

    it('the locale scan target is a single exported constant (source scan showing exactly one declaration)', () => {
      const selfSource = readRepoFile(SELF_PATH);
      const declarations = selfSource.match(/\bINSIGHT_COPY_LOCALE_SOURCE\s*:/g) ?? [];
      expect(declarations.length).toBe(1);
    });

    it('the locale-scan constant resolves via exactly one import.meta.glob declaration pointing at the locales directory', () => {
      const selfSource = readRepoFile(SELF_PATH);
      const globDeclarations = selfSource.match(/import\.meta\.glob\([^)]*i18n\/locales/g) ?? [];
      expect(globDeclarations.length).toBe(1);
    });

    it('resolves all six real locale files (non-vacuity canary)', () => {
      expect(Object.keys(INSIGHT_COPY_LOCALE_SOURCE).sort()).toEqual([...REAL_LOCALES].sort());
    });

    it('examines at least the measured minimum number of insights/analytics keys per locale (non-vacuity canary)', () => {
      for (const locale of REAL_LOCALES) {
        const leaves = collectNewNamespaceLeaves(locale);
        expect(
          leaves.length,
          `locale ${locale} has ${leaves.length} scanned keys`,
        ).toBeGreaterThanOrEqual(MEASURED_MIN_NEW_NAMESPACE_KEYS_PER_LOCALE);
      }
    });

    describe('assertion (b) — no second-person copy in insights/analytics, real content', () => {
      for (const locale of REAL_LOCALES) {
        it(`${locale}: no real insights/analytics value matches the second-person pattern`, () => {
          const pattern = SECOND_PERSON_PATTERNS[locale]!;
          const offenders = collectNewNamespaceLeaves(locale).filter((leaf) =>
            pattern.test(leaf.value),
          );
          expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
        });

        it(`${locale}: permanent positive control — injecting a second-person value into a clone of the real insights tree makes the scan fire`, () => {
          const pattern = SECOND_PERSON_PATTERNS[locale]!;
          const realTree = INSIGHT_COPY_LOCALE_SOURCE[locale]!;
          const offendingWord: Record<(typeof REAL_LOCALES)[number], string> = {
            en: 'your win rate is down',
            es: 'tu tasa de victorias bajó',
            fr: 'votre taux de victoires a baissé',
            de: 'deine Siegquote ist gesunken',
            pt: 'sua taxa de vitórias caiu',
            ja: 'あなたの勝率は下降しました',
          };
          const mutatedInsights = withOverriddenLeaf(
            realTree.insights as Record<string, unknown>,
            'kind.fact',
            offendingWord[locale],
          );
          const violations = collectLeaves(locale, 'insights', mutatedInsights).filter((leaf) =>
            pattern.test(leaf.value),
          );
          expect(violations.length).toBeGreaterThan(0);
        });
      }
    });

    describe('assertion (c) — no bare probability phrasing in insights/analytics, real content', () => {
      it('no real insights/analytics value (any locale) matches the probability pattern', () => {
        const offenders = REAL_LOCALES.flatMap((locale) =>
          collectNewNamespaceLeaves(locale).filter((leaf) => PROBABILITY_PATTERN.test(leaf.value)),
        );
        expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
      });

      it('permanent positive control — injecting a probability phrase into a clone of the real (en) insights tree makes the scan fire', () => {
        const realTree = INSIGHT_COPY_LOCALE_SOURCE.en!;
        const mutatedInsights = withOverriddenLeaf(
          realTree.insights as Record<string, unknown>,
          'kind.fact',
          'a 70% chance the trend will continue',
        );
        const violations = collectLeaves('en', 'insights', mutatedInsights).filter((leaf) =>
          PROBABILITY_PATTERN.test(leaf.value),
        );
        expect(violations.length).toBeGreaterThan(0);
      });
    });

    describe('assertion (d) — no empty string in either new namespace, real content', () => {
      it('no real insights/analytics leaf (any locale) is an empty string', () => {
        const offenders = REAL_LOCALES.flatMap((locale) =>
          collectNewNamespaceLeaves(locale).filter((leaf) => leaf.value.trim() === ''),
        );
        expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
      });

      it('permanent positive control — an empty-string leaf in a clone of the real insights tree makes the scan fire', () => {
        const realTree = INSIGHT_COPY_LOCALE_SOURCE.en!;
        const mutatedInsights = withOverriddenLeaf(
          realTree.insights as Record<string, unknown>,
          'kind.fact',
          '',
        );
        const offenders = collectLeaves('en', 'insights', mutatedInsights).filter(
          (leaf) => leaf.value.trim() === '',
        );
        expect(offenders.length).toBeGreaterThan(0);
      });
    });

    it('D-05 scoping: a second-person string OUTSIDE insights/analytics does NOT fail the guard', () => {
      const enModule = INSIGHT_COPY_LOCALE_SOURCE.en!;
      // A real, already-shipped second-person string that lives OUTSIDE the
      // two new namespaces — proves this guard's scope, never sweeps in the
      // rest of the document. Replaces plan 39.1-09's synthetic
      // `.unrelated` fixture entry now that real content is in scope.
      const existingOutsideString = (
        (enModule.trends as { setting: { youWin: string } }).setting as { youWin: string }
      ).youWin;
      expect(SECOND_PERSON_PATTERNS.en!.test(existingOutsideString)).toBe(true);
      const scannedLeaves = collectNewNamespaceLeaves('en');
      expect(scannedLeaves.some((leaf) => leaf.value === existingOutsideString)).toBe(false);
      const scannedNamespaces = [...new Set(scannedLeaves.map((leaf) => leaf.namespace))].sort();
      expect(
        scannedNamespaces.every((ns) => (NEW_NAMESPACE_KEYS as readonly string[]).includes(ns)),
      ).toBe(true);
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

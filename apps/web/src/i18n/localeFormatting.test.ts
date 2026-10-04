import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 41 plan 08 (I18N-01, D1): the committed oracle for "a date or number follows the app
 * language, never the OS locale". A key-parity test can never see a bare `toLocaleDateString()`
 * — it prints whatever the browser default is, so a `de` reader on an `en-US` machine gets
 * `3/5/2024`. This file is in the DEFAULT `pnpm test` suite (deliberately NOT named
 * `*.guard.test.ts`, which the default config excludes — RESEARCH correction 2).
 *
 * Two bans over the non-test, non-locale source of `apps/web/src` (comments stripped first):
 *
 *   Ban A (everywhere): a `.toLocale(Date|Time)?String(` call whose first argument is absent or
 *   `undefined`, and a `new Intl.<Formatter>()` constructed with no locale.
 *
 *   Ban B (under `components/charts/**`): ANY `.toLocale…(` call, and any `new Intl.` outside
 *   `timeAxisTicks.ts` / `periodTicks.ts` — the kit formats through `lib/format.ts` or those two
 *   cached tick modules, never ad hoc.
 *
 * THE RATCHET (RESEARCH correction 11 — not day-one red): surfaces outside D1 (Coaching, Review,
 * Share, VodManager, GspCalculator, the Scout markdown export) still carry bare calls. They sit on
 * the NAMED, shrink-only `LOCALE_LESS_KNOWN_OFFENDERS` allowlist keyed by file with an EXACT bare-
 * call count. A file whose count drops fails until its entry is lowered (or deleted); a file whose
 * count rises, or a new file with a bare call, fails until it is fixed — the allowlist only ever
 * shrinks. No entry may lie under the D1 directories (`D1_DIRECTORIES`): that scope is closed.
 *
 * PROVEN FAILING (executed by hand during plan 41-08, reverted before commit — observed messages
 * recorded in the plan's SUMMARY):
 *   1. Appending `const probe = new Date(0).toLocaleDateString();` to `lib/eventAxisSummary.ts`
 *      (a D1 file, not allowlisted) turned "non-allowlisted source files contain no locale-less
 *      date/number call" red: `locale-less toLocale / Intl calls — pass i18n.language: lib/eventAxisSummary.ts (1)`.
 *   2. Lowering `pages/Coaching/SessionsListPage.tsx` from 3 to 2 turned "the allowlist cannot
 *      rot" red: `allowlist drift: pages/Coaching/SessionsListPage.tsx: expected 2, found 3 (a new
 *      offender — fix it)` (raising it to 4 reads `... (shrink)`).
 *   3. Appending `new Date(0).toLocaleString("en")` to `components/charts/TrendLine.tsx` (locale-
 *      bearing, so Ban A is silent) turned "no chart-kit file calls toLocale* or constructs an Intl
 *      formatter ad hoc" red: `components/charts/TrendLine.tsx: toLocale*`.
 *
 * NAMED FAILING CASE (12.3): the detector matches the exact pre-41-01 text of
 * `FilteredMatchList.tsx:247` — `new Date(axes.from).toLocaleDateString()` — see the positive
 * controls below.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Ban A — a date/time/number `toLocale*String` call with no locale argument (or literal `undefined`). */
export const BARE_TO_LOCALE = /\.toLocale(?:Date|Time)?String\(\s*(?:undefined\s*)?[,)]/g;
/**
 * Ban A — an `Intl` formatter constructed with no locale: no arguments, or a literal `undefined` first
 * argument (the host default), with or without `new` (`Intl.DateTimeFormat()` is legal without it).
 */
export const BARE_INTL = /(?:new\s+)?Intl\.\w+\(\s*(?:undefined\s*)?[,)]/g;
/** Ban B — any `toLocale…(` call (also catches the locale-bearing form) under the chart kit. */
export const ANY_TO_LOCALE = /\.toLocale\w*\(/g;
/** Ban B — any `Intl` construction. */
export const ANY_NEW_INTL = /new\s+Intl\./g;

/** The two kit modules that own cached `Intl.DateTimeFormat` construction. */
const KIT_INTL_MODULES = ['timeAxisTicks.ts', 'periodTicks.ts'];

/**
 * The D1 scope (UI-SPEC §11 rule 1): no allowlist entry may start with one of these. Prefixes are
 * repo-relative to `apps/web/src`.
 */
export const D1_DIRECTORIES = [
  'components/analytics/',
  'components/charts/',
  'lib/',
  'pages/Dashboard/',
  'pages/Trends/',
  'pages/Gsp/',
  'pages/FighterAnalysis/',
  'pages/MatchData/',
  'pages/Matchups/',
  'pages/Opponents/',
];

/**
 * Out-of-scope surfaces that still hold bare locale calls, repo-relative path → EXACT Ban-A count.
 * Shrink-only: edit it down as a surface is converted, never up. Measured at plan 41-08: 43 bare
 * calls across 25 files before the sweep, 24 calls across 13 files after it (the D1 files and
 * `ScoutAiReportCard` were converted and removed from this list).
 */
export const LOCALE_LESS_KNOWN_OFFENDERS: Record<string, number> = {
  'pages/Coaching/ClientOverviewPage.tsx': 1,
  'pages/Coaching/ReviewsListPage.tsx': 2,
  'pages/Coaching/SessionsListPage.tsx': 3,
  'pages/Coaching/components/ClientHubTable.tsx': 1,
  'pages/Coaching/components/IssueClaimCodeDialog.tsx': 1,
  'pages/GspCalculator/GspCalculatorPage.tsx': 5,
  'pages/Review/ReviewDeliveryPage.tsx': 5,
  'pages/Scout/reportMarkdown.ts': 1,
  'pages/Share/ShareViewPage.tsx': 1,
  'pages/Share/components/RecapView.tsx': 1,
  'pages/VodManager/components/PlaylistRow.tsx': 1,
  'pages/VodManager/components/ShareRow.tsx': 1,
  'pages/VodManager/components/VodMatchList.tsx': 1,
};

/** Non-vacuity: the walker must see most of the real tree (measured 545 files at plan 41-08). */
const MIN_SCANNED_FILES = 430;

/** Strip block and line comments so a doc comment that quotes the banned text is never a hit. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function countMatches(source: string, pattern: RegExp): number {
  return (stripComments(source).match(pattern) ?? []).length;
}

export function countBareLocaleCalls(source: string): number {
  return countMatches(source, BARE_TO_LOCALE) + countMatches(source, BARE_INTL);
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'locales' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function relativeToSrc(file: string): string {
  return path.relative(SRC_DIR, file).split(path.sep).join('/');
}

const FILES = sourceFiles(SRC_DIR).map((file) => ({
  rel: relativeToSrc(file),
  source: fs.readFileSync(file, 'utf8'),
}));

describe('I18N-01 locale-explicit formatting (Ban A, ratchet)', () => {
  it('non-allowlisted source files contain no locale-less date/number call', () => {
    const offenders = FILES.filter(
      (file) => !(file.rel in LOCALE_LESS_KNOWN_OFFENDERS) && countBareLocaleCalls(file.source) > 0,
    ).map((file) => `${file.rel} (${countBareLocaleCalls(file.source)})`);
    expect(
      offenders,
      `locale-less toLocale / Intl calls — pass i18n.language: ${offenders}`,
    ).toEqual([]);
  });

  it('the allowlist cannot rot: every entry matches its file exactly, both ways', () => {
    const drift: string[] = [];
    for (const [rel, expected] of Object.entries(LOCALE_LESS_KNOWN_OFFENDERS)) {
      const file = FILES.find((candidate) => candidate.rel === rel);
      if (!file) {
        drift.push(`${rel}: listed but the file does not exist`);
        continue;
      }
      const found = countBareLocaleCalls(file.source);
      if (found !== expected) {
        drift.push(
          `${rel}: expected ${expected}, found ${found} (${found < expected ? 'shrink' : 'a new offender — fix it'})`,
        );
      }
    }
    expect(drift, `allowlist drift: ${drift.join('; ')}`).toEqual([]);
  });

  it('the D1 scope is closed: no allowlist entry lies under a D1 directory', () => {
    const inScope = Object.keys(LOCALE_LESS_KNOWN_OFFENDERS).filter((rel) =>
      D1_DIRECTORIES.some((prefix) => rel.startsWith(prefix)),
    );
    expect(inScope, `D1 files may not be allowlisted: ${inScope}`).toEqual([]);
  });
});

describe('I18N-01 chart kit (Ban B)', () => {
  it('no chart-kit file calls toLocale* or constructs an Intl formatter ad hoc', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (!file.rel.startsWith('components/charts/')) continue;
      if (countMatches(file.source, ANY_TO_LOCALE) > 0) offenders.push(`${file.rel}: toLocale*`);
      const base = file.rel.split('/').pop() ?? '';
      if (!KIT_INTL_MODULES.includes(base) && countMatches(file.source, ANY_NEW_INTL) > 0) {
        offenders.push(`${file.rel}: new Intl.`);
      }
    }
    expect(offenders, `kit formatting must go through lib/format.ts: ${offenders}`).toEqual([]);
  });
});

describe('guard non-vacuity (T-41-23)', () => {
  it('scanned the real source tree', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    expect(FILES.some((file) => file.rel === 'lib/format.ts')).toBe(true);
    expect(FILES.some((file) => file.rel === 'components/FilteredMatchList.tsx')).toBe(true);
  });

  it('the kit directory is actually walked', () => {
    expect(
      FILES.filter((file) => file.rel.startsWith('components/charts/')).length,
    ).toBeGreaterThan(5);
    // The two sanctioned Intl owners exist and do construct a formatter, so the exemption is not dead.
    for (const name of KIT_INTL_MODULES) {
      const file = FILES.find((candidate) => candidate.rel === `components/charts/${name}`);
      expect(file, name).toBeDefined();
      expect(countMatches(file!.source, ANY_NEW_INTL)).toBeGreaterThan(0);
    }
  });

  it('flags the named failing case: the pre-41-01 FilteredMatchList.tsx:247 text', () => {
    expect(countBareLocaleCalls('parts.push(new Date(axes.from).toLocaleDateString());')).toBe(1);
  });

  it('every detector matches its synthetic positive control', () => {
    expect(countBareLocaleCalls('d.toLocaleDateString()')).toBe(1);
    expect(countBareLocaleCalls('d.toLocaleTimeString()')).toBe(1);
    expect(countBareLocaleCalls('n.toLocaleString()')).toBe(1);
    expect(countBareLocaleCalls('d.toLocaleString(undefined, { dateStyle: "short" })')).toBe(1);
    expect(countBareLocaleCalls('d.toLocaleDateString(\n  )')).toBe(1);
    expect(countBareLocaleCalls('new Intl.NumberFormat()')).toBe(1);
    // 41-REVIEW IN-03: the `undefined`-locale and `new`-less forms are the same defect.
    expect(countBareLocaleCalls('new Intl.NumberFormat(undefined, { style: "percent" })')).toBe(1);
    expect(countBareLocaleCalls('new Intl.DateTimeFormat( undefined )')).toBe(1);
    expect(countBareLocaleCalls('Intl.DateTimeFormat()')).toBe(1);
    expect(countBareLocaleCalls('Intl.NumberFormat(undefined, { notation: "compact" })')).toBe(1);
    expect(countMatches('d.toLocaleDateString(locale)', ANY_TO_LOCALE)).toBe(1);
    expect(countMatches('d.toLocaleUpperCase()', ANY_TO_LOCALE)).toBe(1);
    expect(countMatches('new Intl.DateTimeFormat(locale)', ANY_NEW_INTL)).toBe(1);
  });

  it('does not flag the locale-bearing forms or text inside comments', () => {
    expect(countBareLocaleCalls('d.toLocaleDateString(i18n.language)')).toBe(0);
    expect(countBareLocaleCalls("d.toLocaleString('en-US', { style: 'currency' })")).toBe(0);
    expect(countBareLocaleCalls('new Intl.NumberFormat(locale)')).toBe(0);
    expect(countBareLocaleCalls('Intl.DateTimeFormat(locale, { dateStyle: "short" })')).toBe(0);
    expect(countBareLocaleCalls('new Intl.NumberFormat(undefinedLocale)')).toBe(0);
    expect(countBareLocaleCalls('// d.toLocaleDateString()\nconst a = 1;')).toBe(0);
    expect(countBareLocaleCalls('/* new Intl.NumberFormat() */ const a = 1;')).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 39.1 Plan 09 (UI-SPEC §5.1/§13.16): the type-scale guard. Scans
 * every non-test `.tsx` under `apps/web/src/components/analytics/` and
 * `apps/web/src/components/charts/` (excluding this guard's own
 * `guardFixtures/` deliberately-broken proving components) for any of
 * §13.16's five violation classes. Threshold: ZERO violations. NO
 * allowlist — this file's own self-check below asserts it declares none.
 *
 * PROVEN FAILING (RED phase, `test(39.1-09)` commit): with the file walker
 * NOT yet excluding `guardFixtures/`, the guard found
 * `OffScaleTypeFixture.tsx`'s two deliberate violations (an off-scale
 * `text-[13px]` size and a `font-bold` weight) and failed. The GREEN phase
 * (`feat(39.1-09)` commit) adds the `guardFixtures/` exclusion so the
 * default suite is green, while a permanent "positive control" test below
 * scans the fixture's raw source DIRECTLY (bypassing the exclusion) to
 * prove the detection logic still fires on it. See the plan SUMMARY for
 * the exact recorded runs.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ANALYTICS_DIR = 'apps/web/src/components/analytics/';
const CHARTS_DIR = 'apps/web/src/components/charts/';
const SELF_PATH = 'apps/web/src/components/analytics/typeScale.test.ts';
const FIXTURE_PATH = 'apps/web/src/components/analytics/guardFixtures/OffScaleTypeFixture.tsx';

/** The two role literals UI-SPEC §5.1 declares (`overline`, `figure-lg`) — the only legal `text-[…]` SIZE literals. */
const ALLOWED_ARBITRARY_TEXT_SIZES = new Set(['text-[0.6875rem]', 'text-[1.75rem]']);
/** The four declared named sizes (§5.1's role scale: meta/body/title+verdict/figure). */
const ALLOWED_NAMED_SIZES = new Set(['text-xs', 'text-sm', 'text-base', 'text-xl']);
/** The three declared weights. */
const ALLOWED_WEIGHTS = new Set(['font-normal', 'font-medium', 'font-semibold']);
/** The kit's exported axis font-size constant name — the only legal SVG `fontSize` value. */
const CHART_AXIS_FONT_SIZE_IDENTIFIER = 'CHART_AXIS_FONT_SIZE';

export interface TypeScaleViolation {
  type: 'arbitrary-size' | 'named-size' | 'weight' | 'inline-style' | 'svg-font-size';
  match: string;
}

/**
 * Pure violation scanner — takes a file's SOURCE TEXT and returns every
 * §13.16 violation it finds. Exported so both the live-tree scan below and
 * the fixture's "positive control" test share exactly one detection path.
 */
export function scanTypeScaleViolations(source: string): TypeScaleViolation[] {
  const violations: TypeScaleViolation[] = [];

  // (a) arbitrary text-[…] SIZE literals — a bracket colour value (e.g.
  // text-[var(--foo)]) is not a size and is ignored; a size literal is one
  // that looks like a length (digits, unit, or a bare number).
  for (const match of source.matchAll(/text-\[[^\]]+\]/g)) {
    const literal = match[0];
    const bracketContent = literal.slice('text-['.length, -1);
    const looksLikeSize = /^-?\d/.test(bracketContent) || /(rem|px|em|%)\b/.test(bracketContent);
    if (looksLikeSize && !ALLOWED_ARBITRARY_TEXT_SIZES.has(literal)) {
      violations.push({ type: 'arbitrary-size', match: literal });
    }
  }

  // (b) named sizes outside the declared four.
  for (const match of source.matchAll(
    /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g,
  )) {
    const literal = match[0];
    if (!ALLOWED_NAMED_SIZES.has(literal)) {
      violations.push({ type: 'named-size', match: literal });
    }
  }

  // (c) weights outside the declared three, including an arbitrary font-[…] weight.
  for (const match of source.matchAll(
    /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g,
  )) {
    const literal = match[0];
    if (!ALLOWED_WEIGHTS.has(literal)) {
      violations.push({ type: 'weight', match: literal });
    }
  }
  for (const match of source.matchAll(/\bfont-\[[^\]]+\]/g)) {
    violations.push({ type: 'weight', match: match[0] });
  }

  // (d) an inline fontSize/fontWeight CSS style, or an em/% font size inside one.
  for (const match of source.matchAll(/style=\{\{[^}]*\}\}/g)) {
    const styleBlock = match[0];
    if (/font(Size|Weight)\s*:/.test(styleBlock)) {
      violations.push({ type: 'inline-style', match: styleBlock });
    }
  }

  // (e) an SVG fontSize (JSX attribute or object property) that is not the
  // kit's exported axis font-size constant.
  for (const match of source.matchAll(/\bfontSize\s*[:=]\s*\{?([A-Za-z0-9_.'"$-]+)/g)) {
    const value = match[1] ?? '';
    if (value !== CHART_AXIS_FONT_SIZE_IDENTIFIER) {
      violations.push({ type: 'svg-font-size', match: match[0] });
    }
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

/**
 * Non-test `.tsx` files under the two scanned directories, EXCLUDING this
 * guard's own `guardFixtures/` proving components — those are deliberately
 * broken and never rendered by a real page (see `StretchedCardFixture.tsx`,
 * which is clean of type-scale violations regardless, and
 * `OffScaleTypeFixture.tsx`, which is not).
 */
const SCANNED_FILES = SOURCE_FILES.filter(
  (file) =>
    (file.startsWith(ANALYTICS_DIR) || file.startsWith(CHARTS_DIR)) &&
    !/\.test\.tsx?$/.test(file) &&
    !file.includes('guardFixtures/'),
);

describe('type-scale guard — source-tree guard (UIX-04, §5.1/§13.16)', () => {
  it("the scanned file set is non-empty (non-vacuity canary) and excludes this guard's own fixture proving directory", () => {
    expect(SCANNED_FILES.length).toBeGreaterThan(0);
    expect(SCANNED_FILES).not.toContain(FIXTURE_PATH);
    expect(SCANNED_FILES).not.toContain(SELF_PATH);
  });

  it("declares no exemption list — self-check over this file's own declared constants", () => {
    const selfSource = readRepoFile(SELF_PATH);
    // Looks for an actual variable DECLARATION whose name carries the
    // exemption-list naming convention this repo's other guards use, never
    // a bare substring match — this test's own description and doc
    // comments legitimately discuss the ABSENCE of such a list in prose,
    // which a bare substring search would wrongly trip over on its own text.
    const declarationPattern = new RegExp(
      ['\\bconst\\s+\\w*', 'ALLOW', 'LIST', '\\w*\\s*=|\\bconst\\s+\\w*EXEMPT\\w*\\s*='].join(''),
    );
    expect(selfSource).not.toMatch(declarationPattern);
  });

  it('every scanned file has zero type-scale violations', () => {
    const offenders: { file: string; violations: TypeScaleViolation[] }[] = [];
    for (const file of SCANNED_FILES) {
      const violations = scanTypeScaleViolations(readRepoFile(file));
      if (violations.length > 0) {
        offenders.push({ file, violations });
      }
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it("positive control: the guard's own fixture (scanned directly, bypassing the guardFixtures/ exclusion) DOES trigger violations", () => {
    const violations = scanTypeScaleViolations(readRepoFile(FIXTURE_PATH));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.type === 'arbitrary-size')).toBe(true);
    expect(violations.some((v) => v.type === 'weight')).toBe(true);
  });

  it('the two role literals are the only arbitrary text sizes ever allowed', () => {
    expect(scanTypeScaleViolations('<span className="text-[0.6875rem]" />')).toEqual([]);
    expect(scanTypeScaleViolations('<span className="text-[1.75rem]" />')).toEqual([]);
    expect(scanTypeScaleViolations('<span className="text-[2.5rem]" />')).not.toEqual([]);
  });

  it('an arbitrary colour value in bracket notation is not a size and is ignored', () => {
    expect(scanTypeScaleViolations('<span className="text-[var(--foo)]" />')).toEqual([]);
  });

  it('a legal SVG fontSize using the kit constant passes; a literal number fails', () => {
    expect(scanTypeScaleViolations('fontSize={CHART_AXIS_FONT_SIZE}')).toEqual([]);
    expect(scanTypeScaleViolations('fontSize={14}')).not.toEqual([]);
    expect(scanTypeScaleViolations('tick={{ fontSize: CHART_AXIS_FONT_SIZE }}')).toEqual([]);
    expect(scanTypeScaleViolations('tick={{ fontSize: 14 }}')).not.toEqual([]);
  });

  it('an inline fontSize/fontWeight style is a violation', () => {
    expect(scanTypeScaleViolations("<span style={{ fontSize: '14px' }} />")).not.toEqual([]);
    expect(scanTypeScaleViolations('<span style={{ fontWeight: 700 }} />')).not.toEqual([]);
  });
});

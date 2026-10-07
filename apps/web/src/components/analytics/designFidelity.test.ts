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
 * never recalled. Shrink-only, and now at its TERMINAL STATE: empty.
 *
 * Task 1 of plan 39.1-36 seeded seven entries (HeroStats, VsCharactersList,
 * VsPlayersList, SettingComparison, TrendsHero, MatchWinLossCard,
 * PairingOpponents); its Task 2 converted the first five to `deltaChipView`;
 * plan 39.1-44 (PD-44-2) deleted `MatchWinLossCard.tsx`; plan 39.1-45 rebuilt
 * the last entry — `PairingOpponents.tsx`, the By-opponent rivalry-ledger
 * rows — on `deltaChipView` and deleted its private helpers. The app has one
 * ladder-to-chip owner; a new private helper anywhere fails the test below.
 */
const KNOWN_PRIVATE_CHIP_HELPERS: readonly string[] = [];

/**
 * Named exemption, not an allowlist entry: `OpponentList.tsx` keeps its own
 * notable-only inline mapping because UI-SPEC §8.5 renders a DeltaChip on an
 * opponent row only when the read is notable (up/down); a sub-floor or
 * steady row renders no chip at all, which satisfies "never steady/up/down
 * below the floor" by omission.
 */
const OPPONENT_LIST_EXEMPTION = 'apps/web/src/pages/Opponents/components/OpponentList.tsx';

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

    it('has reached its terminal state: the allowlist is empty and NO non-test file under apps/web/src declares a private ladder-to-chip helper', () => {
      // REWRITTEN by plan 39.1-45 (was: "only PairingOpponents.tsx"): the last
      // entry is rebuilt on deltaChipView, so the allowlist is empty and the
      // matcher — proven non-vacuous by its fixture strings above — finds zero
      // declarations across EVERY non-test file, the mapping module included.
      expect([...KNOWN_PRIVATE_CHIP_HELPERS]).toEqual([]);
      const declaring = NON_TEST_FILES.filter((file) =>
        PRIVATE_CHIP_HELPER_PATTERN.test(readRepoFile(file)),
      );
      expect(declaring).toEqual([]);
    });

    it('OpponentList is a named exemption (UI-SPEC §8.5: a DeltaChip only when notable) whose inline mapping emits up/down only', () => {
      const source = readRepoFile(OPPONENT_LIST_EXEMPTION);
      // Positive presence: the notable-only gate and the up/down-only state are still there.
      expect(source).toMatch(/return state === 'trend' \|\| state === 'suggestion';/);
      expect(source).toMatch(/\{notable && \(\s*<DeltaChip/);
      expect(source).toMatch(/deltaPoints < 0 \? 'down' : 'up'/);
      // It never renders a steady / thin / none / no-direction chip.
      expect(source).not.toMatch(/insights\.chip\./);
      expect(source).not.toMatch(/state=\{?['"](steady|thin|none)['"]/);
      expect(PRIVATE_CHIP_HELPER_PATTERN.test(source)).toBe(false);
    });

    it('the mapping module itself exports deltaChipView', () => {
      const exists = fs.existsSync(path.join(REPO_ROOT, CHIP_VIEW_PATH));
      expect(exists, `${CHIP_VIEW_PATH} exists`).toBe(true);
      expect(readRepoFile(CHIP_VIEW_PATH)).toMatch(/export function deltaChipView\b/);
    });
  });
});

/**
 * Plan 39.1-39 (DD-11, UI-SPEC §4.3 "brand red is never a data mark";
 * OWNER DECISION 2026-09-25 extends the rule to the GSP page): no non-test
 * file under the eight scanned page directories may reach for the brand-red
 * chart ink again. No allowlist.
 */
const RED_INK_PAGE_DIRS: readonly string[] = [
  'apps/web/src/pages/Dashboard/',
  'apps/web/src/pages/FighterAnalysis/',
  'apps/web/src/pages/Matchups/',
  'apps/web/src/pages/MatchData/',
  'apps/web/src/pages/Trends/',
  'apps/web/src/pages/Opponents/',
  'apps/web/src/pages/Stages/',
  'apps/web/src/pages/Gsp/',
];
const RED_CHART_INK_PATTERN = /\bredLineDataset\b|\bchartColors\.(red|redSoft)\b/;
const RED_INK_SCANNED = NON_TEST_FILES.filter((file) =>
  RED_INK_PAGE_DIRS.some((dir) => file.startsWith(dir)),
);

describe('design fidelity — no brand-red chart ink on an analytics or GSP page (plan 39.1-39)', () => {
  it('the pattern detects each red-ink reference (non-vacuity)', () => {
    for (const fixture of [
      '...redLineDataset(),',
      'backgroundColor: chartColors.red,',
      'fill: chartColors.redSoft',
      "import { darkChartOptions, redLineDataset } from '@/lib/chartTheme';",
    ]) {
      expect(RED_CHART_INK_PATTERN.test(fixture), fixture).toBe(true);
    }
    expect(RED_CHART_INK_PATTERN.test('...seriesLineDataset(),')).toBe(false);
    expect(RED_CHART_INK_PATTERN.test('borderColor: chartColors.series,')).toBe(false);
  });

  it('the scanned set is non-empty and includes the form strip tile and all three GSP chart files', () => {
    expect(RED_INK_SCANNED.length).toBeGreaterThan(50);
    for (const file of [
      'apps/web/src/pages/Dashboard/components/FormStripTile.tsx',
      'apps/web/src/pages/Gsp/components/GspCurve.tsx',
      'apps/web/src/pages/Gsp/components/GspVsGlicko.tsx',
      'apps/web/src/pages/Gsp/components/GainsAnalysis.tsx',
    ]) {
      expect(RED_INK_SCANNED).toContain(file);
    }
  });

  it('no scanned file references redLineDataset, chartColors.red or chartColors.redSoft', () => {
    const offenders = RED_INK_SCANNED.filter((file) =>
      RED_CHART_INK_PATTERN.test(readRepoFile(file)),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * Plan 41-09 (UI-SPEC §12.13, DD-41-14 widened): the GSP chart files are rebuilt on the chart kit, whose
 * ink comes from the kit's own series token. Nothing under `pages/Gsp/components/` may reach for a
 * chart palette token (`var(--chart-*)`), the brand red (`var(--primary)`), the chart.js palette
 * (`chartColors`) or the red dataset helper (`redLineDataset`) as mark ink. This extends the brand-red
 * guard above, which only names the two red palette members, to every palette and token route.
 */
const GSP_COMPONENT_DIR = 'apps/web/src/pages/Gsp/components/';
const GSP_MARK_INK_PATTERN = /var\(--chart-|var\(--primary\)|\bchartColors\b|\bredLineDataset\b/;
const GSP_COMPONENT_FILES = NON_TEST_FILES.filter((file) => file.startsWith(GSP_COMPONENT_DIR));
/**
 * Plan 41-10 (UI-SPEC §12.13): the Dashboard form strip tile hosts the kit strip, whose ink is the kit's
 * own win / loss tokens, so it is held to the same no-palette, no-brand-red rule as the GSP components.
 */
const FORM_STRIP_TILE_FILE = 'apps/web/src/pages/Dashboard/components/FormStripTile.tsx';
const MARK_INK_FILES = [...GSP_COMPONENT_FILES, FORM_STRIP_TILE_FILE];

describe('design fidelity — no palette or brand-red mark ink in the rebuilt GSP components and the Dashboard form strip tile (plans 41-09, 41-10)', () => {
  it('the pattern detects each forbidden ink reference and ignores a look-alike (non-vacuity)', () => {
    for (const fixture of [
      'stroke="var(--chart-1)"',
      "style={{ fill: 'var(--primary)' }}",
      'borderColor: chartColors.series,',
      '...redLineDataset(),',
    ]) {
      expect(GSP_MARK_INK_PATTERN.test(fixture), fixture).toBe(true);
    }
    expect(GSP_MARK_INK_PATTERN.test('className="text-primary-foreground"')).toBe(false);
    expect(GSP_MARK_INK_PATTERN.test('stroke="var(--series)"')).toBe(false);
  });

  it('the scanned set contains the four rebuilt GSP files', () => {
    for (const file of ['GspCurve.tsx', 'GspVsGlicko.tsx', 'GainsAnalysis.tsx', 'GspHero.tsx']) {
      expect(GSP_COMPONENT_FILES, file).toContain(`${GSP_COMPONENT_DIR}${file}`);
    }
    expect(GSP_COMPONENT_FILES.every((file) => !/\.test\.tsx?$/.test(file))).toBe(true);
  });

  it('the scanned set also contains the Dashboard form strip tile, which exists (plan 41-10)', () => {
    expect(MARK_INK_FILES).toContain(FORM_STRIP_TILE_FILE);
    expect(NON_TEST_FILES).toContain(FORM_STRIP_TILE_FILE);
  });

  it('no non-test GSP component or the form strip tile uses var(--chart-*), var(--primary), chartColors or redLineDataset', () => {
    const offenders = MARK_INK_FILES.filter((file) =>
      GSP_MARK_INK_PATTERN.test(readRepoFile(file)),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * Plan 39.1-39 Task 2 (deviation, recorded in SUMMARY): the page-owned list
 * controls whose text is a kit label ("Show all N" / "Show fewer" /
 * "Show 50 more") take the one muted link tone in the same task as the kit,
 * so guard:layout's post-kit gate can tell kit labels from page links. Each
 * `<Button … variant="link" …>` opening tag in these files carries
 * MUTED_LINK_TONE.
 */
const PAGE_LIST_CONTROL_FILES: readonly string[] = [
  'apps/web/src/pages/MatchData/components/RosterUsage.tsx',
  'apps/web/src/pages/FighterAnalysis/components/MatchupStageGuide.tsx',
  'apps/web/src/pages/FighterAnalysis/components/OpponentTable.tsx',
  'apps/web/src/pages/Opponents/components/OpponentList.tsx',
  'apps/web/src/pages/Opponents/components/RecentEncounters.tsx',
  'apps/web/src/pages/Stages/StageDetailPage.tsx',
];

/** Every `<Button …>` opening tag (up to its first unbraced `>`) that declares variant="link". */
function linkButtonOpeningTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<Button\b/g)) {
    let depth = 0;
    let end = match.index! + 7;
    for (; end < source.length; end += 1) {
      const ch = source[end];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
    }
    const tag = source.slice(match.index!, end + 1);
    if (/variant="link"/.test(tag)) tags.push(tag);
  }
  return tags;
}

describe('design fidelity — page list controls use the muted link tone (plan 39.1-39 Task 2)', () => {
  it('the opening-tag scanner finds a toned and an untoned link button (non-vacuity)', () => {
    const tags = linkButtonOpeningTags(
      '<Button type="button" variant="link" size="sm" onClick={() => go(1 > 0)}>a</Button>' +
        '<Button variant="link" className={MUTED_LINK_TONE}>b</Button><Button>c</Button>',
    );
    expect(tags).toHaveLength(2);
    expect(tags[0]).not.toMatch(/MUTED_LINK_TONE/);
    expect(tags[1]).toMatch(/MUTED_LINK_TONE/);
  });

  it.each(PAGE_LIST_CONTROL_FILES)(
    '%s: every Button variant="link" carries MUTED_LINK_TONE',
    (file) => {
      const tags = linkButtonOpeningTags(readRepoFile(file));
      expect(tags.length).toBeGreaterThan(0);
      const untoned = tags.filter((tag) => !/MUTED_LINK_TONE/.test(tag));
      expect(untoned).toEqual([]);
    },
  );
});

/**
 * Plan 39.1-39 Task 3 (UI-SPEC §4.3: brand red is never text on an analytics
 * surface): no `text-primary` class literal in non-test files under the
 * seven analytics page directories, components/analytics, components/charts,
 * FilteredMatchList.tsx, DrillableRow.tsx and EvidenceCues.tsx — except a
 * named, reasoned, shrink-only allowlist — and every non-test file in that
 * scope containing `variant="link"` references one of the two link tones.
 */
const TEXT_PRIMARY_SCOPE_DIRS: readonly string[] = [
  'apps/web/src/pages/Dashboard/',
  'apps/web/src/pages/FighterAnalysis/',
  'apps/web/src/pages/Matchups/',
  'apps/web/src/pages/MatchData/',
  'apps/web/src/pages/Trends/',
  'apps/web/src/pages/Opponents/',
  'apps/web/src/pages/Stages/',
  'apps/web/src/components/analytics/',
  'apps/web/src/components/charts/',
];
const TEXT_PRIMARY_SCOPE_FILES: readonly string[] = [
  'apps/web/src/components/FilteredMatchList.tsx',
  'apps/web/src/components/DrillableRow.tsx',
  'apps/web/src/components/EvidenceCues.tsx',
];
const TEXT_PRIMARY_SCANNED = NON_TEST_FILES.filter(
  (file) =>
    TEXT_PRIMARY_SCOPE_DIRS.some((dir) => file.startsWith(dir)) ||
    TEXT_PRIMARY_SCOPE_FILES.includes(file),
);
const TEXT_PRIMARY_PATTERN = /(?<![\w-])text-primary(?![\w-])/;
/**
 * Shrink-only. `MatchTable.tsx`: the icon-only VOD trigger
 * (`border-primary text-primary` on a `size="icon-sm"` Button holding only a
 * Video icon) — it carries no text for the browser oracle, and restyling the
 * legacy match table is audit 4.4, not in this batch.
 */
const TEXT_PRIMARY_ALLOWLIST: readonly string[] = [
  'apps/web/src/pages/MatchData/components/MatchTable.tsx',
];
/** Shrink-only; seeded empty (every link-variant file in scope takes a tone). */
const LINK_TONE_ALLOWLIST: readonly string[] = [];
const LINK_TONE_PATTERN = /\b(MUTED_LINK_TONE|INLINE_LINK_TONE)\b/;

describe('design fidelity — no brand-red text classes, one link tone (plan 39.1-39 Task 3)', () => {
  it('the pattern detects a text-primary class literal and ignores look-alikes (non-vacuity)', () => {
    expect(TEXT_PRIMARY_PATTERN.test('className="text-sm text-primary hover:underline"')).toBe(
      true,
    );
    expect(TEXT_PRIMARY_PATTERN.test("cn('text-primary', x)")).toBe(true);
    expect(TEXT_PRIMARY_PATTERN.test('text-primary-foreground')).toBe(false);
    expect(TEXT_PRIMARY_PATTERN.test('hover:text-primary/80')).toBe(true);
  });

  it('the scanned set is non-empty and covers the kit and every analytics page directory', () => {
    expect(TEXT_PRIMARY_SCANNED.length).toBeGreaterThan(100);
    for (const dir of TEXT_PRIMARY_SCOPE_DIRS) {
      expect(
        TEXT_PRIMARY_SCANNED.some((file) => file.startsWith(dir)),
        dir,
      ).toBe(true);
    }
    for (const file of TEXT_PRIMARY_SCOPE_FILES) {
      expect(TEXT_PRIMARY_SCANNED).toContain(file);
    }
  });

  it('no scanned file carries a text-primary class literal, except the allowlist', () => {
    const offenders = TEXT_PRIMARY_SCANNED.filter(
      (file) =>
        !TEXT_PRIMARY_ALLOWLIST.includes(file) && TEXT_PRIMARY_PATTERN.test(readRepoFile(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('the text-primary allowlist cannot rot: each entry exists and still carries it', () => {
    for (const file of TEXT_PRIMARY_ALLOWLIST) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
      expect(TEXT_PRIMARY_PATTERN.test(readRepoFile(file)), file).toBe(true);
    }
    expect([...TEXT_PRIMARY_ALLOWLIST]).toEqual([
      'apps/web/src/pages/MatchData/components/MatchTable.tsx',
    ]);
  });

  it('every scanned file with a variant="link" references MUTED_LINK_TONE or INLINE_LINK_TONE', () => {
    const withLinkVariant = TEXT_PRIMARY_SCANNED.filter((file) =>
      /variant="link"/.test(readRepoFile(file)),
    );
    expect(withLinkVariant.length).toBeGreaterThan(5);
    const offenders = withLinkVariant.filter(
      (file) => !LINK_TONE_ALLOWLIST.includes(file) && !LINK_TONE_PATTERN.test(readRepoFile(file)),
    );
    expect(offenders).toEqual([]);
    expect([...LINK_TONE_ALLOWLIST]).toEqual([]);
  });
});

/**
 * Plan 39.1-41 (PD-41-3, sketch 003 A / 001-C): the period trend is ONE data
 * line plus ONE all-time hairline. No non-test file may declare or pass a
 * cumulative context-series prop to TrendLine, or declare a second period
 * y-axis; every period-trend host builds its reference label from the shared
 * `analytics.trend.referenceLabel` key ("NN% all time"), never a bare rate.
 */
const CONTEXT_SERIES_PATTERN = /\bcontextRatePercents\b|\bcontextPercent\b/;
const SECOND_PERIOD_AXIS_PATTERN = /\b[A-Z_]*CONTEXT_Y_AXIS_ID\b|\byAxisId\s*=/;
/** Every `referenceLabel:` object key in a host (`labels={{ … referenceLabel: … }}`). */
const REFERENCE_LABEL_KEY_PATTERN = /\breferenceLabel:\s*/g;
const SHARED_REFERENCE_LABEL_CALL = /^t\(\s*['"]analytics\.trend\.referenceLabel['"]/;

/** The `referenceLabel:` values in `source` that are NOT a `t('analytics.trend.referenceLabel', …)` call. */
function offendingReferenceLabels(source: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(REFERENCE_LABEL_KEY_PATTERN)) {
    const value = source.slice((match.index ?? 0) + match[0].length).split('\n')[0] ?? '';
    if (!SHARED_REFERENCE_LABEL_CALL.test(value)) offenders.push(value.trim());
  }
  return offenders;
}

describe('design fidelity — one period data line, one reference-label key (plan 39.1-41)', () => {
  it('the matchers detect a context-series prop, a second period axis and a bare reference label (non-vacuity)', () => {
    expect(CONTEXT_SERIES_PATTERN.test('        contextRatePercents={contextRatePercents}')).toBe(
      true,
    );
    expect(CONTEXT_SERIES_PATTERN.test('  contextPercent?: number;')).toBe(true);
    expect(CONTEXT_SERIES_PATTERN.test('const contextLabel = 1;')).toBe(false);
    expect(SECOND_PERIOD_AXIS_PATTERN.test("const PERIOD_CONTEXT_Y_AXIS_ID = 'context';")).toBe(
      true,
    );
    expect(SECOND_PERIOD_AXIS_PATTERN.test('          yAxisId={PERIOD_CONTEXT_Y_AXIS_ID}')).toBe(
      true,
    );
    expect(SECOND_PERIOD_AXIS_PATTERN.test('<YAxis domain={[yMin, yMax]} />')).toBe(false);
    expect(
      offendingReferenceLabels('          referenceLabel: `${Math.round(overallRate)}%`,'),
    ).toEqual(['`${Math.round(overallRate)}%`,']);
    expect(
      offendingReferenceLabels(
        "              referenceLabel: t('analytics.trend.referenceLabel', {\n                rate: `${x}%`,",
      ),
    ).toEqual([]);
    expect(
      offendingReferenceLabels("  referenceLabel: t('analytics.trend.refLabel'),"),
    ).toHaveLength(1);
    // An interface member (`referenceLabel?: string;`) is not a host value.
    expect(offendingReferenceLabels('  referenceLabel?: string;')).toEqual([]);
  });

  it('no non-test file declares or passes a cumulative context series', () => {
    const offenders = NON_TEST_FILES.filter((file) =>
      CONTEXT_SERIES_PATTERN.test(readRepoFile(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('no non-test file declares a second period y-axis', () => {
    const offenders = NON_TEST_FILES.filter((file) =>
      SECOND_PERIOD_AXIS_PATTERN.test(readRepoFile(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('every period-trend host builds its reference label from analytics.trend.referenceLabel', () => {
    const hosts = NON_TEST_FILES.filter((file) => /\breferenceLabel:/.test(readRepoFile(file)));
    // Non-vacuity: both period-trend heroes are scanned.
    expect(hosts).toEqual(
      expect.arrayContaining([
        'apps/web/src/pages/FighterAnalysis/components/FighterHero.tsx',
        'apps/web/src/pages/Matchups/components/MatchupChart.tsx',
      ]),
    );
    const offenders = hosts.flatMap((file) =>
      offendingReferenceLabels(readRepoFile(file)).map((value) => `${file}: ${value}`),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * Plan 39.1-43 Task 1 (hero-idioms-kit, sketch 003 A "Hero port", brief §1
 * "one idiom per job"): a hero host renders its horizon figures through
 * `HorizonStatRow` and its by-match-type bar through `MatchTypeShareBar` —
 * never its own window resolution (`resolveWindow` / `classify`), its own
 * type grouping (`getMatchTypeRecords`) or a direct `ShareBar` / `StatFigure`.
 * The hosts are the Fighter hero and, once plan 39.1-44 creates it, the
 * pairing hero; the case fails when no host exists at all.
 */
const HERO_HOST_FILES: readonly string[] = [
  'apps/web/src/pages/FighterAnalysis/components/FighterHero.tsx',
  'apps/web/src/pages/Matchups/components/PairingHero.tsx',
];
const HERO_PRIVATE_IDIOM_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: 'imports resolveWindow / classify / getMatchTypeRecords',
    pattern:
      /import\s*(?:type\s*)?\{[^}]*\b(resolveWindow|classify|getMatchTypeRecords)\b[^}]*\}\s*from/,
  },
  { name: 'renders ShareBar directly', pattern: /<ShareBar\b/ },
  { name: 'renders StatFigure directly', pattern: /<StatFigure\b/ },
];

function heroIdiomOffences(source: string): string[] {
  return HERO_PRIVATE_IDIOM_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(
    ({ name }) => name,
  );
}

describe('design fidelity — hero hosts build no private horizon figures or share bar (plan 39.1-43)', () => {
  it('each matcher detects its idiom and ignores the kit components (non-vacuity)', () => {
    expect(
      heroIdiomOffences("import {\n  classify,\n  toRateValue,\n} from '@smash-tracker/shared';"),
    ).toEqual(['imports resolveWindow / classify / getMatchTypeRecords']);
    expect(
      heroIdiomOffences("import { resolveWindow } from '@smash-tracker/shared';"),
    ).toHaveLength(1);
    expect(heroIdiomOffences("import { getMatchTypeRecords } from '@/lib/stats';")).toHaveLength(1);
    expect(heroIdiomOffences('        <ShareBar\n          segments={x}')).toEqual([
      'renders ShareBar directly',
    ]);
    expect(heroIdiomOffences('  <StatFigure key="all-time" lead />')).toEqual([
      'renders StatFigure directly',
    ]);
    expect(
      heroIdiomOffences(
        "import { HorizonStatRow } from '@/components/analytics/HorizonStatRow';\n<HorizonStatRow matches={m} />\n<MatchTypeShareBar matches={m} />",
      ),
    ).toEqual([]);
    expect(heroIdiomOffences("import { classifyTone } from './x';")).toEqual([]);
  });

  it('at least one hero host exists, and every existing host renders through HorizonStatRow and MatchTypeShareBar only', () => {
    const hosts = HERO_HOST_FILES.filter((file) => fs.existsSync(path.join(REPO_ROOT, file)));
    expect(hosts.length, 'no hero host file exists').toBeGreaterThan(0);
    const offences = hosts.flatMap((file) =>
      heroIdiomOffences(readRepoFile(file)).map((offence) => `${file}: ${offence}`),
    );
    expect(offences).toEqual([]);
    for (const file of hosts) {
      const source = readRepoFile(file);
      expect(source, file).toMatch(/<HorizonStatRow\b/);
      expect(source, file).toMatch(/<MatchTypeShareBar\b/);
    }
  });
});

/**
 * Plan 39.1-46 Task 2 (sketch 003 A, brief §5 M15 "colour discipline: blue
 * data ink, win / loss only on win / loss marks"): no non-test file under
 * `pages/Matchups` imports / renders the pip component (`WinLossPips` — the
 * second Recent Form row the sketch's Insights card does not draw; the hero's
 * strip is the one form mark) or carries an emerald / destructive text,
 * background or border class (alarm colours on a neutral evidence card).
 *
 * `CounterpickAdvisor.tsx` was the ONE shrink-only allowlist entry (its pick /
 * ban headings were coloured); plan 39.1-47 (segmented controls, neutral
 * Pick / Ban rows, ComparisonBars' status tones deleted) rebuilt the card and
 * emptied the list — the allowlist is at its TERMINAL STATE. The matrix's
 * heat is an inline `style` computed from numbers (`matchupCellColor.ts`),
 * not a class, and its comments mention the colour words without any class
 * literal.
 */
const MATCHUPS_DIR_PREFIX = 'apps/web/src/pages/Matchups/';
const PIP_COMPONENT_PATTERN = /from\s+['"][^'"]*WinLossPips['"]|<WinLossPips\b/;
const STATUS_COLOUR_CLASS_PATTERN =
  /(?<![\w-])(?:[\w-]+:)*(?:text|bg|border|fill|stroke|ring|from|to|via|outline|divide|decoration)-(?:emerald|destructive)(?:-\d{2,3})?(?:\/\d{1,3})?(?![\w-])/;
const KNOWN_STATUS_COLOUR_FILES: readonly string[] = [];

function matchupsOffences(source: string): string[] {
  const offences: string[] = [];
  if (PIP_COMPONENT_PATTERN.test(source)) offences.push('uses the pip component');
  if (STATUS_COLOUR_CLASS_PATTERN.test(source))
    offences.push('uses an emerald / destructive class');
  return offences;
}

const MATCHUPS_NON_TEST_FILES = NON_TEST_FILES.filter((file) =>
  file.startsWith(MATCHUPS_DIR_PREFIX),
);

describe('design fidelity — Matchups carries no pips and no alarm-colour class (plan 39.1-46)', () => {
  it('each matcher detects its idiom and ignores look-alikes (non-vacuity)', () => {
    expect(matchupsOffences("import { WinLossPips } from '@/components/WinLossPips';")).toEqual([
      'uses the pip component',
    ]);
    expect(matchupsOffences('<WinLossPips matches={m} limit={10} />')).toEqual([
      'uses the pip component',
    ]);
    expect(matchupsOffences('<h2 className="text-sm font-medium text-emerald-500">')).toEqual([
      'uses an emerald / destructive class',
    ]);
    expect(matchupsOffences('<h2 className="text-sm font-medium text-destructive">')).toEqual([
      'uses an emerald / destructive class',
    ]);
    expect(matchupsOffences('className="bg-emerald-500/15 hover:bg-destructive/20"')).toEqual([
      'uses an emerald / destructive class',
    ]);
    expect(matchupsOffences('className="dark:text-destructive"')).toEqual([
      'uses an emerald / destructive class',
    ]);
    // Look-alikes: prose, a colour word in a comment, a token name, a longer identifier.
    expect(matchupsOffences('/** emerald-500, used elsewhere in the app */')).toEqual([]);
    expect(matchupsOffences('interpolated between the theme destructive red and emerald')).toEqual(
      [],
    );
    expect(matchupsOffences('const noTextDestructive = 1; // text-destructive-ish')).toEqual([]);
    expect(matchupsOffences('className="text-muted-foreground"')).toEqual([]);
    expect(matchupsOffences('const WinLossPipsLegend = 1')).toEqual([]);
    expect(
      matchupsOffences('/** emerald-500, used elsewhere in the app (WinLossPips, X) */'),
    ).toEqual([]);
  });

  it('the scanned set is non-empty and covers the rail cards', () => {
    expect(MATCHUPS_NON_TEST_FILES.length).toBeGreaterThan(5);
    expect(MATCHUPS_NON_TEST_FILES).toEqual(
      expect.arrayContaining([
        'apps/web/src/pages/Matchups/components/MatchupInsights.tsx',
        'apps/web/src/pages/Matchups/components/MatchupStageTable.tsx',
        'apps/web/src/pages/Matchups/components/MatchupOrPlayerCard.tsx',
      ]),
    );
  });

  it('no non-test file under pages/Matchups uses the pip component or an emerald / destructive class, except the allowlist', () => {
    const offenders = MATCHUPS_NON_TEST_FILES.filter(
      (file) => !KNOWN_STATUS_COLOUR_FILES.includes(file),
    ).flatMap((file) =>
      matchupsOffences(readRepoFile(file)).map((offence) => `${file}: ${offence}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the allowlist is at its terminal state: empty (plan 39.1-47)', () => {
    expect(KNOWN_STATUS_COLOUR_FILES).toEqual([]);
  });

  it('the allowlist cannot rot: every entry still exists and still carries an offence', () => {
    for (const file of KNOWN_STATUS_COLOUR_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), `${file} no longer exists`).toBe(true);
      expect(
        matchupsOffences(readRepoFile(file)),
        `${file} is clean — remove it from KNOWN_STATUS_COLOUR_FILES`,
      ).not.toEqual([]);
    }
  });
});

/**
 * Plan 39.1-47 (segmented-set-state, PD-47-1 / PD-47-4, brief §5 M11 / M15):
 *
 * - `ComparisonBars` has ONE tone, `series`. A status tone (`emerald` /
 *   `destructive`) passed to it anywhere under `apps/web/src` is a pick / ban
 *   alarm colour on an evidence row (sketch README point 7).
 * - ONE segmented single-choice implementation: a `ToggleGroup` import under
 *   `components/analytics` or `pages/Matchups` is allowed only in
 *   `SegmentedControl.tsx` — the page horizon switch and the advisor's
 *   Phase / Role / Won-Lost controls render through it, never through a
 *   second copy of its markup. A file whose every `<ToggleGroup>` is
 *   `type="multiple"` is a multi-select chip filter (39.2's
 *   `TierFilterChips`), not a single-choice segmented control, and is exempt.
 */
const SEGMENTED_CONTROL_PATH = 'apps/web/src/components/analytics/SegmentedControl.tsx';
const SEGMENTED_SCOPE_PREFIXES: readonly string[] = [
  'apps/web/src/components/analytics/',
  'apps/web/src/pages/Matchups/',
];
const COMPARISON_BARS_STATUS_TONE_PATTERN =
  /\btone\s*(?:=\s*(?:\{\s*)?|:\s*)(["'`])(?:emerald|destructive)\1/;
const TOGGLE_GROUP_IMPORT_PATTERN = /from\s+['"]@\/components\/ui\/toggle-group['"]/;

function comparisonBarsStatusToneOffences(source: string): string[] {
  return /\bComparisonBars\b/.test(source) && COMPARISON_BARS_STATUS_TONE_PATTERN.test(source)
    ? ['passes a status tone to ComparisonBars']
    : [];
}

function secondSegmentedOffences(file: string, source: string): string[] {
  if (file === SEGMENTED_CONTROL_PATH) return [];
  if (!SEGMENTED_SCOPE_PREFIXES.some((prefix) => file.startsWith(prefix))) return [];
  if (!TOGGLE_GROUP_IMPORT_PATTERN.test(source)) return [];
  return allToggleGroupsMultiple(source) ? [] : ['imports ToggleGroup outside SegmentedControl'];
}

/** True when the source opens at least one `<ToggleGroup>` and every one is `type="multiple"`. */
function allToggleGroupsMultiple(source: string): boolean {
  // Each opening tag runs to the next `<` (its first child or the next tag).
  const tags = [...source.matchAll(/<ToggleGroup\b(?!Item)[^<]*/g)].map((match) => match[0]);
  return tags.length > 0 && tags.every((tag) => /\btype\s*=\s*["']multiple["']/.test(tag));
}

describe('design fidelity — one ComparisonBars tone and one segmented control (plan 39.1-47)', () => {
  it('the status-tone matcher detects a status tone and ignores look-alikes (non-vacuity)', () => {
    expect(
      comparisonBarsStatusToneOffences('<ComparisonBars tone="emerald" rows={rows} />'),
    ).toHaveLength(1);
    expect(
      comparisonBarsStatusToneOffences("<ComparisonBars\n  tone='destructive'\n  rows={r}/>"),
    ).toHaveLength(1);
    expect(
      comparisonBarsStatusToneOffences('<ComparisonBars tone={"emerald"} rows={rows} />'),
    ).toHaveLength(1);
    expect(
      comparisonBarsStatusToneOffences(
        "import { ComparisonBars } from 'x'; const p = { tone: 'destructive' };",
      ),
    ).toHaveLength(1);
    // Look-alikes: the series tone, another component's tone, a file without ComparisonBars.
    expect(comparisonBarsStatusToneOffences('<ComparisonBars tone="series" rows={r} />')).toEqual(
      [],
    );
    expect(comparisonBarsStatusToneOffences('<ComparisonBars tone={tone} rows={r} />')).toEqual([]);
    expect(comparisonBarsStatusToneOffences('<DeltaChip tone="emerald" />')).toEqual([]);
    expect(
      comparisonBarsStatusToneOffences('/* ComparisonBars once took tone emerald */ const x = 1;'),
    ).toEqual([]);
  });

  it('the second-segmented matcher detects a ToggleGroup import in scope and ignores the primitive and out-of-scope files (non-vacuity)', () => {
    const importLine =
      "import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';";
    expect(
      secondSegmentedOffences('apps/web/src/components/analytics/Other.tsx', importLine),
    ).toHaveLength(1);
    expect(
      secondSegmentedOffences('apps/web/src/pages/Matchups/components/Thing.tsx', importLine),
    ).toHaveLength(1);
    expect(secondSegmentedOffences(SEGMENTED_CONTROL_PATH, importLine)).toEqual([]);
    expect(
      secondSegmentedOffences('apps/web/src/pages/Gsp/components/QuickLogger.tsx', importLine),
    ).toEqual([]);
    expect(
      secondSegmentedOffences(
        'apps/web/src/components/analytics/Other.tsx',
        "import { SegmentedControl } from '@/components/analytics/SegmentedControl';",
      ),
    ).toEqual([]);
    // A multi-select chip filter is not a segmented control; one single-mode group still offends.
    const multiple = `${importLine}\n<ToggleGroup\n  type="multiple"\n  onValueChange={(v) => set(v)}\n>\n  <ToggleGroupItem value="a" />\n</ToggleGroup>`;
    expect(
      secondSegmentedOffences('apps/web/src/components/analytics/Other.tsx', multiple),
    ).toEqual([]);
    expect(
      secondSegmentedOffences(
        'apps/web/src/components/analytics/Other.tsx',
        `${multiple}\n<ToggleGroup type="single" value={v}>\n</ToggleGroup>`,
      ),
    ).toHaveLength(1);
  });

  it('no non-test file under apps/web/src passes a status tone to ComparisonBars', () => {
    const offenders = NON_TEST_FILES.flatMap((file) =>
      comparisonBarsStatusToneOffences(readRepoFile(file)).map((offence) => `${file}: ${offence}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no file under components/analytics or pages/Matchups builds a second ToggleGroup segmented control', () => {
    const scanned = NON_TEST_FILES.filter((file) =>
      SEGMENTED_SCOPE_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );
    // Non-vacuity: the primitive itself is in scope and does import ToggleGroup.
    expect(scanned).toContain(SEGMENTED_CONTROL_PATH);
    expect(TOGGLE_GROUP_IMPORT_PATTERN.test(readRepoFile(SEGMENTED_CONTROL_PATH))).toBe(true);
    const offenders = scanned.flatMap((file) =>
      secondSegmentedOffences(file, readRepoFile(file)).map((offence) => `${file}: ${offence}`),
    );
    expect(offenders).toEqual([]);
  });
});

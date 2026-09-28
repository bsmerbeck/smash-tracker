/**
 * Plain Node test file (Phase 39.1 Plan 09) exercising `guardLayoutCore.mjs`
 * with synthetic measurements — no browser, no Vite server. Run directly via
 * `node --test apps/web/scripts/guardLayoutCore.test.mjs`, the same
 * invocation style this repo already uses for its Node-runner scripts (see
 * `apps/api`'s `node --test` usage). Deliberately NOT written against
 * vitest's `describe`/`it`/`expect`: this file's own module-level import of
 * `node:test` is what makes it independently runnable with no Vite/vitest
 * transform in the loop, matching the plan's stated verify command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRETCH_TOLERANCE_PX,
  SCROLL_BUDGET_2560X1440,
  SCROLL_BUDGET_1440X900,
  DEFAULT_SCROLL_BUDGETS,
  EXTRA_ORACLE_VIEWPORTS,
  ORPHAN_HALF_MIN_RATIO,
  HEADER_SQUEEZE_MIN_SHARE,
  MIN_TICK_GAP_PX,
  PICKER_ALIGN_TOLERANCE_PX,
  VS_CENTER_TOLERANCE_PX,
  ROW_COHESION_TOP_TOLERANCE_PX,
  TAG_MIN_ROW_SHARE,
  NARROW_VIEWPORT_MAX_WIDTH_PX,
  MATCHUPS_SCROLL_BUDGET_390X844,
  WIN_RATE_TREND_CARD_MAX_VIEWPORT_HEIGHTS,
  FORM_STRIP_ROW_TOP_TOLERANCE_PX,
  evaluateStretch,
  evaluateScrollBudget,
  evaluateHorizontalOverflow,
  evaluateTruncation,
  evaluateCardContentOverflow,
  evaluateHeaderSqueeze,
  evaluateAxisTicks,
  evaluateAxisPresence,
  evaluateGridBalance,
  evaluateFamilyPresence,
  evaluatePickerAlignment,
  evaluateRowCohesion,
  evaluateRowTagLegibility,
  evaluateNestedScrollers,
  evaluateCardHeightCeilings,
  evaluateFormStripFit,
} from './guardLayoutCore.mjs';
// Plan 39.1-37: read the new exports through the namespace so a RED run fails
// on an assertion instead of a module-link error.
import * as guardLayoutCoreNs from './guardLayoutCore.mjs';
import {
  CAREER_TIMELINE_ALIGN_TOLERANCE_PX,
  CAREER_TIMELINE_LINE_RESIDUAL_TOLERANCE_PX,
  CAREER_TIMELINE_LINE_POINT_BOUND,
  CAREER_TIMELINE_STRIP_CELL_BOUND,
  CAREER_TIMELINE_NARROW_STRIP_CELL_BOUND,
  CAREER_TIMELINE_NARROW_PLOT_PX,
  CAREER_TIMELINE_FORM_STRIP_TICK_BOUND,
  evaluateCareerTimeline,
} from './guardLayoutCore.mjs';

test('a card exactly at the 24px tolerance passes', () => {
  const violations = evaluateStretch([
    { selectorPath: '#a', height: 100, lastChildBottom: 76, top: 0, paddingBottom: 0 },
  ]);
  assert.equal(violations.length, 0);
});

test('a card 0.01px over the 24px tolerance fails', () => {
  const violations = evaluateStretch([
    { selectorPath: '#a', height: 100.01, lastChildBottom: 76, top: 0, paddingBottom: 0 },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'stretch');
  assert.equal(violations[0].selectorPath, '#a');
});

test('the tolerance constant is exactly 24px', () => {
  assert.equal(STRETCH_TOLERANCE_PX, 24);
});

test('exactly 3.00 viewport heights at 2560x1440 passes', () => {
  const violations = evaluateScrollBudget({
    scrollHeight: 4320,
    innerHeight: 1440,
    viewportName: '2560x1440',
  });
  assert.equal(violations.length, 0);
});

test('3.01 viewport heights at 2560x1440 fails', () => {
  const violations = evaluateScrollBudget({
    scrollHeight: 1440 * 3.01,
    innerHeight: 1440,
    viewportName: '2560x1440',
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'scroll-budget');
  assert.equal(violations[0].budget, SCROLL_BUDGET_2560X1440);
});

test('exactly 5.00 viewport heights at 1440x900 passes', () => {
  const violations = evaluateScrollBudget({
    scrollHeight: 900 * 5,
    innerHeight: 900,
    viewportName: '1440x900',
  });
  assert.equal(violations.length, 0);
});

test('5.01 viewport heights at 1440x900 fails', () => {
  const violations = evaluateScrollBudget({
    scrollHeight: 900 * 5.01,
    innerHeight: 900,
    viewportName: '1440x900',
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].budget, SCROLL_BUDGET_1440X900);
});

test('a viewport with no declared scroll budget (390x844) is exempt', () => {
  const violations = evaluateScrollBudget({
    scrollHeight: 900 * 50,
    innerHeight: 844,
    viewportName: '390x844',
  });
  assert.equal(violations.length, 0);
});

// --- plan 39.1-33: DEFAULT_SCROLL_BUDGETS + the Matchups 390x844 opt-in ---

test('DEFAULT_SCROLL_BUDGETS is exactly the pre-39.1-33 map', () => {
  assert.deepEqual(DEFAULT_SCROLL_BUDGETS, { '2560x1440': 3, '1440x900': 5 });
});

test('scroll-budget: a merged 390x844 budget of 7.5, scrollHeight 11641 / innerHeight 844 -> one violation with budget 7.5', () => {
  const budgets = { ...DEFAULT_SCROLL_BUDGETS, '390x844': MATCHUPS_SCROLL_BUDGET_390X844 };
  const violations = evaluateScrollBudget(
    { scrollHeight: 11641, innerHeight: 844, viewportName: '390x844' },
    budgets,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'scroll-budget');
  assert.equal(violations[0].budget, 7.5);
});

test('scroll-budget: 6015 / 844 at the merged 390x844 budget passes', () => {
  const budgets = { ...DEFAULT_SCROLL_BUDGETS, '390x844': MATCHUPS_SCROLL_BUDGET_390X844 };
  const violations = evaluateScrollBudget(
    { scrollHeight: 6015, innerHeight: 844, viewportName: '390x844' },
    budgets,
  );
  assert.equal(violations.length, 0);
});

test('scroll-budget: exactly 7.5 viewport heights (6330 / 844) at the merged 390x844 budget passes', () => {
  const budgets = { ...DEFAULT_SCROLL_BUDGETS, '390x844': MATCHUPS_SCROLL_BUDGET_390X844 };
  const violations = evaluateScrollBudget(
    { scrollHeight: 6330, innerHeight: 844, viewportName: '390x844' },
    budgets,
  );
  assert.equal(violations.length, 0);
});

test('scroll-budget: 6331 / 844 (0.01 over 7.5) at the merged 390x844 budget fails', () => {
  const budgets = { ...DEFAULT_SCROLL_BUDGETS, '390x844': MATCHUPS_SCROLL_BUDGET_390X844 };
  const violations = evaluateScrollBudget(
    { scrollHeight: 6331, innerHeight: 844, viewportName: '390x844' },
    budgets,
  );
  assert.equal(violations.length, 1);
});

test('scroll-budget: the merged map still applies 5 at 1440x900 (4501 / 900 fails)', () => {
  const budgets = { ...DEFAULT_SCROLL_BUDGETS, '390x844': MATCHUPS_SCROLL_BUDGET_390X844 };
  const violations = evaluateScrollBudget(
    { scrollHeight: 4501, innerHeight: 900, viewportName: '1440x900' },
    budgets,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].budget, 5);
});

test('a document whose scroll width exceeds its inner width fails horizontal overflow', () => {
  const violations = evaluateHorizontalOverflow({ scrollWidth: 400, innerWidth: 390 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'horizontal-overflow');
});

test('a document whose scroll width equals its inner width passes', () => {
  const violations = evaluateHorizontalOverflow({ scrollWidth: 390, innerWidth: 390 });
  assert.equal(violations.length, 0);
});

test('an overflowing element with a title passes truncation', () => {
  const violations = evaluateTruncation([
    { selectorPath: '#tag', scrollWidth: 200, clientWidth: 100, hasTitle: true },
  ]);
  assert.equal(violations.length, 0);
});

test('an overflowing element without a title fails truncation', () => {
  const violations = evaluateTruncation([
    { selectorPath: '#tag', scrollWidth: 200, clientWidth: 100, hasTitle: false },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'truncation');
  assert.equal(violations[0].selectorPath, '#tag');
});

test('a run with multiple violations returns ALL of them, never only the first', () => {
  const violations = evaluateStretch([
    { selectorPath: '#a', height: 200, lastChildBottom: 76, top: 0, paddingBottom: 0 },
    { selectorPath: '#b', height: 100, lastChildBottom: 76, top: 0, paddingBottom: 0 },
    { selectorPath: '#c', height: 300, lastChildBottom: 76, top: 0, paddingBottom: 0 },
  ]);
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => v.selectorPath),
    ['#a', '#c'],
  );
});

// ---------------------------------------------------------------------------
// Plan 39.1-30: EXTRA_ORACLE_VIEWPORTS and the four new evaluator families.
// ---------------------------------------------------------------------------

test('EXTRA_ORACLE_VIEWPORTS carries exactly the two named extra viewports', () => {
  assert.deepEqual(Object.keys(EXTRA_ORACLE_VIEWPORTS).sort(), ['1024x768', '1280x800']);
  assert.equal(EXTRA_ORACLE_VIEWPORTS['1024x768'].width, 1024);
  assert.equal(EXTRA_ORACLE_VIEWPORTS['1024x768'].height, 768);
  assert.equal(EXTRA_ORACLE_VIEWPORTS['1280x800'].width, 1280);
  assert.equal(EXTRA_ORACLE_VIEWPORTS['1280x800'].height, 800);
});

test('the pinned family constants are exactly the documented values', () => {
  assert.equal(ORPHAN_HALF_MIN_RATIO, 0.5);
  assert.equal(HEADER_SQUEEZE_MIN_SHARE, 0.5);
  assert.equal(MIN_TICK_GAP_PX, 4);
});

// --- content-overflow ---

test('content-overflow: a descendant 20px past the card inner right edge fails, naming the offender', () => {
  const violations = evaluateCardContentOverflow([
    {
      selectorPath: '#card',
      innerLeft: 0,
      innerRight: 500,
      offenders: [{ selectorPath: '#child', left: 10, right: 520 }],
    },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'content-overflow');
  assert.equal(violations[0].selectorPath, '#card');
  assert.equal(violations[0].offender, '#child');
});

test('content-overflow: a descendant 0.5px past the inner right edge is within the 1px tolerance and passes', () => {
  const violations = evaluateCardContentOverflow([
    {
      selectorPath: '#card',
      innerLeft: 0,
      innerRight: 500,
      offenders: [{ selectorPath: '#child', left: 10, right: 500.5 }],
    },
  ]);
  assert.equal(violations.length, 0);
});

// --- header-squeeze ---

test('header-squeeze: a 90px description wrapped onto 6 lines in a 400px header fails', () => {
  const violations = evaluateHeaderSqueeze([
    {
      selectorPath: '#header',
      contentWidth: 400,
      parts: [{ role: 'description', width: 90, height: 120, lineHeight: 20 }],
    },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'header-squeeze');
  assert.equal(violations[0].role, 'description');
});

test('header-squeeze: the same 90px width rendered on exactly one line passes (short text is not squeezed)', () => {
  const violations = evaluateHeaderSqueeze([
    {
      selectorPath: '#header',
      contentWidth: 400,
      parts: [{ role: 'description', width: 90, height: 20, lineHeight: 20 }],
    },
  ]);
  assert.equal(violations.length, 0);
});

test('header-squeeze: 200px of 400 on 3 lines passes — exactly the 0.5 share boundary', () => {
  const violations = evaluateHeaderSqueeze([
    {
      selectorPath: '#header',
      contentWidth: 400,
      parts: [{ role: 'title', width: 200, height: 60, lineHeight: 20 }],
    },
  ]);
  assert.equal(violations.length, 0);
});

// --- header-squeeze: config (plan 39.1-50, OOS-11) ---

test('header-squeeze: config — a route without headerSqueeze gets the default card-header scan', () => {
  const config = guardLayoutCoreNs.headerSqueezeConfigForRoute?.({ id: 'matchups' });
  assert.deepEqual(config, {
    header: '[data-slot="card-header"]',
    parts: [
      { role: 'title', selector: '[data-slot="card-title"]' },
      { role: 'description', selector: '[data-slot="card-description"]' },
    ],
  });
});

test('header-squeeze: config — a route that declares headerSqueeze gets its own header and parts', () => {
  const declared = {
    header: '[data-slot="insight-rail-header"]',
    parts: [{ role: 'overline', selector: '[data-slot="insight-rail-overline"]' }],
  };
  const config = guardLayoutCoreNs.headerSqueezeConfigForRoute?.({
    id: 'trends',
    headerSqueeze: declared,
  });
  assert.deepEqual(config, declared);
});

test('header-squeeze: config — an overline 100 wide in a 342 header over 4 lines of 16px fails', () => {
  const violations = evaluateHeaderSqueeze([
    {
      selectorPath: '[data-slot="insight-rail-header"]',
      contentWidth: 342,
      parts: [{ role: 'overline', width: 100, height: 64, lineHeight: 16 }],
    },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].role, 'overline');
  assert.equal(violations[0].lines, 4);
});

test('header-squeeze: config — the same overline at the full 342 width on one line passes', () => {
  const violations = evaluateHeaderSqueeze([
    {
      selectorPath: '[data-slot="insight-rail-header"]',
      contentWidth: 342,
      parts: [{ role: 'overline', width: 342, height: 16, lineHeight: 16 }],
    },
  ]);
  assert.equal(violations.length, 0);
});

test('header-squeeze: config — no matched header is exactly one header-squeeze-unmeasured', () => {
  const violations = evaluateFamilyPresence('header-squeeze', []);
  assert.deepEqual(violations, [{ type: 'header-squeeze-unmeasured' }]);
});

// --- axis-ticks ---

function makeSurface(overrides = {}) {
  return {
    selectorPath: '#surface',
    rect: { left: 0, right: 500, top: 0, bottom: 300 },
    xTicks: [],
    yTicks: [],
    valueLabels: [],
    dots: [],
    xAxisLine: null,
    yAxisLine: null,
    ...overrides,
  };
}

test('axis-ticks: a tick 10px left of the surface is tick-clipped', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      xTicks: [{ left: -10, right: 40, top: 280, bottom: 296, text: 'Nov 1' }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'tick-clipped').length, 1);
});

test('axis-ticks: two x ticks 2px apart overlap', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      xTicks: [
        { left: 50, right: 100, top: 280, bottom: 296, text: 'a' },
        { left: 102, right: 150, top: 280, bottom: 296, text: 'b' },
      ],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'tick-overlap').length, 1);
});

test('axis-ticks: two x ticks exactly 4px apart pass', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      xTicks: [
        { left: 50, right: 100, top: 280, bottom: 296, text: 'a' },
        { left: 104, right: 150, top: 280, bottom: 296, text: 'b' },
      ],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'tick-overlap').length, 0);
});

test('axis-ticks: a value label intersecting a y tick is a value-label-collision', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      yTicks: [{ left: 0, right: 30, top: 10, bottom: 26, text: '100%' }],
      valueLabels: [{ left: 5, right: 35, top: 12, bottom: 28, text: '100%' }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'value-label-collision').length, 1);
});

test('axis-ticks: a dot box crossing the x-axis line is mark-on-axis', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      xAxisLine: { left: 0, right: 500, top: 250, bottom: 251 },
      dots: [{ selectorPath: '#dot', left: 100, right: 109, top: 246, bottom: 255 }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'mark-on-axis').length, 1);
});

// Plan 39.1-37 (item 10, fitted-period-trend): the all-time reference label vs value labels.

test('axis-ticks: a reference label intersecting a value label is one reference-label-collision', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      valueLabels: [{ left: 600, right: 621, top: 53, bottom: 69, text: '48%' }],
      referenceLabels: [{ left: 609, right: 630, top: 54, bottom: 70, text: '55%' }],
    }),
  ]);
  const hits = violations.filter((v) => v.type === 'reference-label-collision');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, '48%');
  assert.equal(hits[0].reference, '55%');
});

test('axis-ticks: a reference label disjoint from every value label has no reference-label-collision', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      valueLabels: [{ left: 600, right: 621, top: 25, bottom: 41, text: '55%' }],
      referenceLabels: [{ left: 609, right: 630, top: 54, bottom: 70, text: '55%' }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'reference-label-collision').length, 0);
});

test('axis-ticks: a surface with a reference label and no value labels has no reference-label-collision', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      referenceLabels: [{ left: 609, right: 630, top: 54, bottom: 70, text: '55%' }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'reference-label-collision').length, 0);
});

test('axis-ticks: a surface collected without a referenceLabels array (older collector) is not a crash', () => {
  const violations = evaluateAxisTicks([makeSurface()]);
  assert.equal(violations.filter((v) => v.type === 'reference-label-collision').length, 0);
});

// Plan 39.1-37 (item 5, human-event-axis): raw engine keys on an axis, and value labels
// overprinting one another.

test('axis-ticks: an x tick "session::1700000000000" is one raw-axis-key violation', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      xTicks: [{ left: 50, right: 140, top: 280, bottom: 296, text: 'session::1700000000000' }],
    }),
  ]);
  const hits = violations.filter((v) => v.type === 'raw-axis-key');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tick, 'session::1700000000000');
});

test('axis-ticks: an ISO timestamp tick "2023-11-15T19:30:20.000Z" is raw-axis-key', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      xTicks: [{ left: 50, right: 190, top: 280, bottom: 296, text: '2023-11-15T19:30:20.000Z' }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'raw-axis-key').length, 1);
});

test('axis-ticks: a y tick carrying a raw key is raw-axis-key too', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      yTicks: [{ left: 0, right: 40, top: 10, bottom: 26, text: 'tournament::1' }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'raw-axis-key').length, 1);
});

test('axis-ticks: a human tick "Nov 15, 2023" is not raw-axis-key', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      xTicks: [{ left: 50, right: 134, top: 280, bottom: 296, text: 'Nov 15, 2023' }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'raw-axis-key').length, 0);
});

test('axis-ticks: RAW_AXIS_KEY_PATTERN is exported and matches "::" and ISO timestamps only', () => {
  const pattern = guardLayoutCoreNs.RAW_AXIS_KEY_PATTERN;
  assert.ok(pattern instanceof RegExp, 'RAW_AXIS_KEY_PATTERN is an exported RegExp');
  assert.equal(pattern.test('session::1700000000000'), true);
  assert.equal(pattern.test('2023-11-15T19:30:20.000Z'), true);
  assert.equal(pattern.test('Nov 15, 2023'), false);
  assert.equal(pattern.test('Genesis Ten …'), false);
});

test('axis-ticks: two intersecting value labels are one value-label-overlap', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      valueLabels: [
        { left: 100, right: 121, top: 40, bottom: 56, text: '9–7' },
        { left: 112, right: 133, top: 44, bottom: 60, text: '8–5' },
      ],
    }),
  ]);
  const hits = violations.filter((v) => v.type === 'value-label-overlap');
  assert.equal(hits.length, 1);
});

test('axis-ticks: disjoint value labels have no value-label-overlap', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      valueLabels: [
        { left: 100, right: 121, top: 40, bottom: 56, text: '9–7' },
        { left: 125, right: 146, top: 40, bottom: 56, text: '8–5' },
      ],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'value-label-overlap').length, 0);
});

test('axis-unmeasured: a route whose surfaces carry zero x ticks fails non-vacuously', () => {
  const violations = evaluateAxisPresence([makeSurface()]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'axis-unmeasured');
});

test('axis-unmeasured: a surface carrying at least one x tick passes', () => {
  const violations = evaluateAxisPresence([
    makeSurface({ xTicks: [{ left: 0, right: 40, top: 280, bottom: 296, text: 'a' }] }),
  ]);
  assert.equal(violations.length, 0);
});

// --- grid-balance ---

test('grid-balance: side-by-side items 200 and 520 tall are an orphan half', () => {
  const violations = evaluateGridBalance([
    {
      selectorPath: '#grid',
      rowGapPx: 16,
      items: [
        { selectorPath: '#a', left: 0, right: 100, top: 0, bottom: 200 },
        { selectorPath: '#b', left: 110, right: 210, top: 0, bottom: 520 },
      ],
    },
  ]);
  assert.equal(violations.filter((v) => v.type === 'orphan-half').length, 1);
});

test('grid-balance: side-by-side items 260 and 520 tall pass — exactly the 0.5 ratio boundary', () => {
  const violations = evaluateGridBalance([
    {
      selectorPath: '#grid',
      rowGapPx: 16,
      items: [
        { selectorPath: '#a', left: 0, right: 100, top: 0, bottom: 260 },
        { selectorPath: '#b', left: 110, right: 210, top: 0, bottom: 520 },
      ],
    },
  ]);
  assert.equal(violations.filter((v) => v.type === 'orphan-half').length, 0);
});

test('grid-balance: stacked items with a 176px gap in a 16px-row-gap grid are a dead gap', () => {
  const violations = evaluateGridBalance([
    {
      selectorPath: '#grid',
      rowGapPx: 16,
      items: [
        { selectorPath: '#top', left: 0, right: 100, top: 0, bottom: 100 },
        { selectorPath: '#bottom', left: 0, right: 100, top: 276, bottom: 400 },
      ],
    },
  ]);
  assert.equal(violations.filter((v) => v.type === 'dead-gap').length, 1);
});

test('grid-balance: a 40px gap (= 16 row-gap + 24 tolerance) passes', () => {
  const violations = evaluateGridBalance([
    {
      selectorPath: '#grid',
      rowGapPx: 16,
      items: [
        { selectorPath: '#top', left: 0, right: 100, top: 0, bottom: 100 },
        { selectorPath: '#bottom', left: 0, right: 100, top: 140, bottom: 260 },
      ],
    },
  ]);
  assert.equal(violations.filter((v) => v.type === 'dead-gap').length, 0);
});

// --- family presence (written RED first, one case per family) ---

test('evaluateFamilyPresence: an empty content-overflow list fails non-vacuously', () => {
  const violations = evaluateFamilyPresence('content-overflow', []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'content-overflow-unmeasured');
});

test('evaluateFamilyPresence: a one-card content-overflow list passes', () => {
  const violations = evaluateFamilyPresence('content-overflow', [{ selectorPath: '#a' }]);
  assert.equal(violations.length, 0);
});

test('evaluateFamilyPresence: an empty header-squeeze list fails non-vacuously', () => {
  const violations = evaluateFamilyPresence('header-squeeze', []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'header-squeeze-unmeasured');
});

test('evaluateFamilyPresence: a one-header header-squeeze list passes', () => {
  const violations = evaluateFamilyPresence('header-squeeze', [{ selectorPath: '#a' }]);
  assert.equal(violations.length, 0);
});

test('evaluateFamilyPresence: an empty grid-balance list fails non-vacuously', () => {
  const violations = evaluateFamilyPresence('grid-balance', []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'grid-balance-unmeasured');
});

test('evaluateFamilyPresence: a one-grid grid-balance list passes', () => {
  const violations = evaluateFamilyPresence('grid-balance', [{ selectorPath: '#a' }]);
  assert.equal(violations.length, 0);
});

// ---------------------------------------------------------------------------
// Plan 39.1-32: the four mobile gap-closure families (picker-alignment,
// row-cohesion, row-tag-legibility, nested-scroll) + their family-presence
// non-vacuity cases.
// ---------------------------------------------------------------------------

test('the plan 39.1-32 family constants are exactly the documented values', () => {
  assert.equal(PICKER_ALIGN_TOLERANCE_PX, 1);
  assert.equal(VS_CENTER_TOLERANCE_PX, 2);
  assert.equal(ROW_COHESION_TOP_TOLERANCE_PX, 2);
  assert.equal(TAG_MIN_ROW_SHARE, 0.6);
  assert.equal(NARROW_VIEWPORT_MAX_WIDTH_PX, 639);
});

// --- picker-alignment ---

function makeStackedPicker(overrides = {}) {
  return {
    selectorPath: '#picker',
    controls: [
      { left: 23, right: 243, top: 40, bottom: 76 },
      { left: 23, right: 243, top: 120, bottom: 156 },
    ],
    labels: [
      { left: 23, right: 100, top: 20, bottom: 36 },
      { left: 23, right: 100, top: 100, bottom: 116 },
    ],
    vs: { left: 128, right: 138, top: 82, bottom: 94 },
    ...overrides,
  };
}

test('picker-alignment: a stacked picker with two 220px controls at lefts 23 and 45 fails with picker-control-offset', () => {
  const picker = makeStackedPicker({
    controls: [
      { left: 23, right: 243, top: 40, bottom: 76 },
      { left: 45, right: 265, top: 120, bottom: 156 },
    ],
    labels: [
      { left: 23, right: 100, top: 20, bottom: 36 },
      { left: 45, right: 122, top: 100, bottom: 116 },
    ],
  });
  const violations = evaluatePickerAlignment([picker]);
  assert.equal(violations.filter((v) => v.type === 'picker-control-offset').length, 1);
});

test('picker-alignment: the same stacked picker with equal control lefts has no offset violation', () => {
  const violations = evaluatePickerAlignment([makeStackedPicker()]);
  assert.equal(violations.filter((v) => v.type === 'picker-control-offset').length, 0);
});

test('picker-alignment: controls 240 and 238 wide fail picker-control-width', () => {
  const picker = makeStackedPicker({
    controls: [
      { left: 0, right: 240, top: 40, bottom: 76 },
      { left: 0, right: 238, top: 120, bottom: 156 },
    ],
  });
  const violations = evaluatePickerAlignment([picker]);
  assert.equal(violations.filter((v) => v.type === 'picker-control-width').length, 1);
});

test('picker-alignment: controls 240 and 239 wide (1px boundary) pass', () => {
  const picker = makeStackedPicker({
    controls: [
      { left: 0, right: 240, top: 40, bottom: 76 },
      { left: 0, right: 239, top: 120, bottom: 156 },
    ],
  });
  const violations = evaluatePickerAlignment([picker]);
  assert.equal(violations.filter((v) => v.type === 'picker-control-width').length, 0);
});

test('picker-alignment: a label 60px right of its control fails picker-label-offset once per label', () => {
  const picker = makeStackedPicker({
    labels: [
      { left: 83, right: 160, top: 20, bottom: 36 },
      { left: 23, right: 100, top: 100, bottom: 116 },
    ],
  });
  const violations = evaluatePickerAlignment([picker]);
  assert.equal(violations.filter((v) => v.type === 'picker-label-offset').length, 1);
});

test("picker-alignment: a stacked vs box sharing control 0's row fails picker-vs-misplaced", () => {
  const picker = makeStackedPicker({
    vs: { left: 128, right: 138, top: 60, bottom: 72 },
  });
  const violations = evaluatePickerAlignment([picker]);
  assert.equal(violations.filter((v) => v.type === 'picker-vs-misplaced').length, 1);
});

test('picker-alignment: a stacked vs box between control 0 and label 1, centred within 2px, passes', () => {
  const violations = evaluatePickerAlignment([makeStackedPicker()]);
  assert.equal(violations.filter((v) => v.type === 'picker-vs-misplaced').length, 0);
});

test('picker-alignment: a stacked vs box 3px off-centre fails picker-vs-misplaced', () => {
  const picker = makeStackedPicker({
    vs: { left: 131, right: 141, top: 82, bottom: 94 },
  });
  const violations = evaluatePickerAlignment([picker]);
  assert.equal(violations.filter((v) => v.type === 'picker-vs-misplaced').length, 1);
});

test('picker-alignment: a 2-up picker with vs between the controls, vertically centred on control 0, passes', () => {
  const picker = {
    selectorPath: '#picker',
    controls: [
      { left: 0, right: 240, top: 40, bottom: 76 },
      { left: 280, right: 520, top: 40, bottom: 76 },
    ],
    labels: [
      { left: 0, right: 80, top: 20, bottom: 36 },
      { left: 280, right: 380, top: 20, bottom: 36 },
    ],
    vs: { left: 250, right: 270, top: 50, bottom: 66 },
  };
  const violations = evaluatePickerAlignment([picker]);
  assert.equal(violations.filter((v) => v.type === 'picker-vs-misplaced').length, 0);
});

test('picker-alignment: a 2-up vs overlapping control 1 fails picker-vs-misplaced', () => {
  const picker = {
    selectorPath: '#picker',
    controls: [
      { left: 0, right: 240, top: 40, bottom: 76 },
      { left: 280, right: 520, top: 40, bottom: 76 },
    ],
    labels: [
      { left: 0, right: 80, top: 20, bottom: 36 },
      { left: 280, right: 380, top: 20, bottom: 36 },
    ],
    vs: { left: 250, right: 290, top: 50, bottom: 66 },
  };
  const violations = evaluatePickerAlignment([picker]);
  assert.equal(violations.filter((v) => v.type === 'picker-vs-misplaced').length, 1);
});

// --- row-cohesion ---

test('row-cohesion: items with tops 100 / 100 / 101.5 pass (2px tolerance)', () => {
  const violations = evaluateRowCohesion([
    {
      selectorPath: '#row',
      items: [
        { selectorPath: '#a', top: 100, scrollWidth: 50, clientWidth: 60 },
        { selectorPath: '#b', top: 100, scrollWidth: 50, clientWidth: 60 },
        { selectorPath: '#c', top: 101.5, scrollWidth: 50, clientWidth: 60 },
      ],
    },
  ]);
  assert.equal(violations.filter((v) => v.type === 'row-wrapped').length, 0);
});

test('row-cohesion: items with tops 100 / 100 / 180 fail row-wrapped', () => {
  const violations = evaluateRowCohesion([
    {
      selectorPath: '#row',
      items: [
        { selectorPath: '#a', top: 100, scrollWidth: 50, clientWidth: 60 },
        { selectorPath: '#b', top: 100, scrollWidth: 50, clientWidth: 60 },
        { selectorPath: '#c', top: 180, scrollWidth: 50, clientWidth: 60 },
      ],
    },
  ]);
  assert.equal(violations.filter((v) => v.type === 'row-wrapped').length, 1);
});

test('row-cohesion: an item with scrollWidth 120 over clientWidth 87 fails row-item-overflow', () => {
  const violations = evaluateRowCohesion([
    {
      selectorPath: '#row',
      items: [{ selectorPath: '#a', top: 100, scrollWidth: 120, clientWidth: 87 }],
    },
  ]);
  assert.equal(violations.filter((v) => v.type === 'row-item-overflow').length, 1);
});

test('row-cohesion: scrollWidth 88 over clientWidth 87 (1px boundary) passes', () => {
  const violations = evaluateRowCohesion([
    {
      selectorPath: '#row',
      items: [{ selectorPath: '#a', top: 100, scrollWidth: 88, clientWidth: 87 }],
    },
  ]);
  assert.equal(violations.filter((v) => v.type === 'row-item-overflow').length, 0);
});

// --- row-tag-legibility ---

test('row-tag-legibility: scrollWidth 75 / clientWidth 50 / row content 294 fails tag-truncated', () => {
  const violations = evaluateRowTagLegibility([
    {
      selectorPath: '#tag',
      text: 'synthopp15',
      scrollWidth: 75,
      clientWidth: 50,
      rowContentWidth: 294,
    },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'tag-truncated');
});

test('row-tag-legibility: the same truncation with clientWidth 270 (share 0.92) passes — a tag owning its line may truncate', () => {
  const violations = evaluateRowTagLegibility([
    {
      selectorPath: '#tag',
      text: 'synthopp15',
      scrollWidth: 280,
      clientWidth: 270,
      rowContentWidth: 294,
    },
  ]);
  assert.equal(violations.length, 0);
});

test('row-tag-legibility: scrollWidth equal to clientWidth + 1 passes', () => {
  const violations = evaluateRowTagLegibility([
    {
      selectorPath: '#tag',
      text: 'synthopp15',
      scrollWidth: 51,
      clientWidth: 50,
      rowContentWidth: 294,
    },
  ]);
  assert.equal(violations.length, 0);
});

// --- nested-scroll ---

test('nested-scroll: overflowY auto with scrollHeight 4600 over clientHeight 500 fails nested-vertical-scroller', () => {
  const violations = evaluateNestedScrollers([
    { selectorPath: '#list', overflowY: 'auto', scrollHeight: 4600, clientHeight: 500 },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'nested-vertical-scroller');
});

test('nested-scroll: overflowY scroll also fails', () => {
  const violations = evaluateNestedScrollers([
    { selectorPath: '#list', overflowY: 'scroll', scrollHeight: 4600, clientHeight: 500 },
  ]);
  assert.equal(violations.length, 1);
});

test('nested-scroll: overflowY auto with scrollHeight equal to clientHeight + 1 passes', () => {
  const violations = evaluateNestedScrollers([
    { selectorPath: '#list', overflowY: 'auto', scrollHeight: 501, clientHeight: 500 },
  ]);
  assert.equal(violations.length, 0);
});

test('nested-scroll: overflowY visible or hidden with taller content passes', () => {
  const violations = evaluateNestedScrollers([
    { selectorPath: '#list', overflowY: 'visible', scrollHeight: 4600, clientHeight: 500 },
    { selectorPath: '#list2', overflowY: 'hidden', scrollHeight: 4600, clientHeight: 500 },
  ]);
  assert.equal(violations.length, 0);
});

test('nested-scroll: a horizontal-only scroller (overflow-y auto but scrollHeight === clientHeight) passes', () => {
  const violations = evaluateNestedScrollers([
    { selectorPath: '#table-container', overflowY: 'auto', scrollHeight: 40, clientHeight: 40 },
  ]);
  assert.equal(violations.length, 0);
});

// --- family presence (one case per new family) ---

test('evaluateFamilyPresence: an empty picker-alignment list fails non-vacuously', () => {
  const violations = evaluateFamilyPresence('picker-alignment', []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'picker-alignment-unmeasured');
});

test('evaluateFamilyPresence: a one-picker picker-alignment list passes', () => {
  const violations = evaluateFamilyPresence('picker-alignment', [{ selectorPath: '#a' }]);
  assert.equal(violations.length, 0);
});

test('evaluateFamilyPresence: an empty row-cohesion list fails non-vacuously', () => {
  const violations = evaluateFamilyPresence('row-cohesion', []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'row-cohesion-unmeasured');
});

test('evaluateFamilyPresence: a one-row row-cohesion list passes', () => {
  const violations = evaluateFamilyPresence('row-cohesion', [{ selectorPath: '#a' }]);
  assert.equal(violations.length, 0);
});

test('evaluateFamilyPresence: an empty row-tag-legibility list fails non-vacuously', () => {
  const violations = evaluateFamilyPresence('row-tag-legibility', []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'row-tag-legibility-unmeasured');
});

test('evaluateFamilyPresence: a one-tag row-tag-legibility list passes', () => {
  const violations = evaluateFamilyPresence('row-tag-legibility', [{ selectorPath: '#a' }]);
  assert.equal(violations.length, 0);
});

test('evaluateFamilyPresence: an empty nested-scroll list fails non-vacuously', () => {
  const violations = evaluateFamilyPresence('nested-scroll', []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'nested-scroll-unmeasured');
});

test('evaluateFamilyPresence: a one-scroller nested-scroll list passes', () => {
  const violations = evaluateFamilyPresence('nested-scroll', [{ selectorPath: '#a' }]);
  assert.equal(violations.length, 0);
});

// ---------------------------------------------------------------------------
// Plan 39.1-33: the Matchups phone scroll budget (above), the Win Rate Trend
// card ceiling (card-height-ceiling) and the single-row form-strip family
// (form-strip-fit) + their family-presence non-vacuity cases.
// ---------------------------------------------------------------------------

test('the plan 39.1-33 family constants are exactly the documented values', () => {
  assert.equal(MATCHUPS_SCROLL_BUDGET_390X844, 7.5);
  assert.equal(WIN_RATE_TREND_CARD_MAX_VIEWPORT_HEIGHTS, 1);
  assert.equal(FORM_STRIP_ROW_TOP_TOLERANCE_PX, 2);
});

// --- card-height-ceiling ---

test('card-height-ceiling: a 1204px card against a 1 viewport-height ceiling at 844 innerHeight fails, carrying height and limitPx', () => {
  const violations = evaluateCardHeightCeilings({
    innerHeight: 844,
    cards: [
      {
        marker: '[data-slot="matchup-chart-body"]',
        selectorPath: '#card',
        height: 1204,
        maxViewportHeights: 1,
      },
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'card-height-ceiling');
  assert.equal(violations[0].height, 1204);
  assert.equal(violations[0].limitPx, 844);
});

test('card-height-ceiling: a 664px card passes', () => {
  const violations = evaluateCardHeightCeilings({
    innerHeight: 844,
    cards: [
      {
        marker: '[data-slot="matchup-chart-body"]',
        selectorPath: '#card',
        height: 664,
        maxViewportHeights: 1,
      },
    ],
  });
  assert.equal(violations.length, 0);
});

test('card-height-ceiling: exactly 844px (the limit) passes', () => {
  const violations = evaluateCardHeightCeilings({
    innerHeight: 844,
    cards: [
      {
        marker: '[data-slot="matchup-chart-body"]',
        selectorPath: '#card',
        height: 844,
        maxViewportHeights: 1,
      },
    ],
  });
  assert.equal(violations.length, 0);
});

test('card-height-ceiling: 845px (0.01 over the limit) fails', () => {
  const violations = evaluateCardHeightCeilings({
    innerHeight: 844,
    cards: [
      {
        marker: '[data-slot="matchup-chart-body"]',
        selectorPath: '#card',
        height: 845,
        maxViewportHeights: 1,
      },
    ],
  });
  assert.equal(violations.length, 1);
});

test('card-height-ceiling: two over-ceiling cards -> two violations', () => {
  const violations = evaluateCardHeightCeilings({
    innerHeight: 844,
    cards: [
      { marker: '#a', selectorPath: '#a', height: 900, maxViewportHeights: 1 },
      { marker: '#b', selectorPath: '#b', height: 1000, maxViewportHeights: 1 },
    ],
  });
  assert.equal(violations.length, 2);
});

test('card-height-ceiling: a card with height null fails non-vacuously with card-height-ceiling-unmeasured naming its marker', () => {
  const violations = evaluateCardHeightCeilings({
    innerHeight: 844,
    cards: [
      {
        marker: '[data-slot="matchup-chart-body"]',
        selectorPath: null,
        height: null,
        maxViewportHeights: 1,
      },
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'card-height-ceiling-unmeasured');
  assert.equal(violations[0].marker, '[data-slot="matchup-chart-body"]');
});

test('card-height-ceiling: an empty card list passes with no violations', () => {
  const violations = evaluateCardHeightCeilings({ innerHeight: 844, cards: [] });
  assert.equal(violations.length, 0);
});

// --- form-strip-fit ---

function makeStrip(overrides = {}) {
  return {
    selectorPath: '#strip',
    setTops: [100],
    rowScrollWidth: 308,
    rowClientWidth: 308,
    ...overrides,
  };
}

test('form-strip-fit: set tops [100, 100, 168] fail form-strip-wrapped', () => {
  const violations = evaluateFormStripFit([makeStrip({ setTops: [100, 100, 168] })]);
  assert.equal(violations.filter((v) => v.type === 'form-strip-wrapped').length, 1);
});

test('form-strip-fit: set tops [100, 100, 101.5] pass (within the 2px tolerance)', () => {
  const violations = evaluateFormStripFit([makeStrip({ setTops: [100, 100, 101.5] })]);
  assert.equal(violations.filter((v) => v.type === 'form-strip-wrapped').length, 0);
});

test('form-strip-fit: set tops [100, 100, 102.5] fail form-strip-wrapped (0.5 over tolerance)', () => {
  const violations = evaluateFormStripFit([makeStrip({ setTops: [100, 100, 102.5] })]);
  assert.equal(violations.filter((v) => v.type === 'form-strip-wrapped').length, 1);
});

test('form-strip-fit: a single set passes (nothing to compare)', () => {
  const violations = evaluateFormStripFit([makeStrip({ setTops: [100] })]);
  assert.equal(violations.filter((v) => v.type === 'form-strip-wrapped').length, 0);
});

test('form-strip-fit: rowScrollWidth 836 / rowClientWidth 308 fails form-strip-overflow', () => {
  const violations = evaluateFormStripFit([
    makeStrip({ setTops: [100], rowScrollWidth: 836, rowClientWidth: 308 }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'form-strip-overflow').length, 1);
});

test('form-strip-fit: rowScrollWidth 309 / rowClientWidth 308 (1px boundary) passes', () => {
  const violations = evaluateFormStripFit([
    makeStrip({ setTops: [100], rowScrollWidth: 309, rowClientWidth: 308 }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'form-strip-overflow').length, 0);
});

test('form-strip-fit: two wrapped strips -> two violations', () => {
  const violations = evaluateFormStripFit([
    makeStrip({ selectorPath: '#a', setTops: [100, 168] }),
    makeStrip({ selectorPath: '#b', setTops: [100, 168] }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'form-strip-wrapped').length, 2);
});

test('evaluateFamilyPresence: an empty form-strip-fit list fails non-vacuously', () => {
  const violations = evaluateFamilyPresence('form-strip-fit', []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'form-strip-fit-unmeasured');
});

test('evaluateFamilyPresence: a one-strip form-strip-fit list passes', () => {
  const violations = evaluateFamilyPresence('form-strip-fit', [{ selectorPath: '#a' }]);
  assert.equal(violations.length, 0);
});

// ---------------------------------------------------------------------------
// Plan 39.1-34: the career-timeline family (UI-SPEC §11, §12.1, §13.1). Every
// rule has a failing fixture AND a passing boundary case; multi-offender
// inputs return ALL offenders.
// ---------------------------------------------------------------------------

/** x(t) = 100 + 10t over a plot 100..300 — three anchors on that exact line. */
const LINE_ANCHORS = [
  { t: 0, cx: 100 },
  { t: 10, cx: 200 },
  { t: 20, cx: 300 },
];

function makeTimeline(overrides = {}) {
  return {
    selectorPath: '#timeline',
    state: 'full',
    plotLeft: 100,
    plotRight: 300,
    plotWidth: 800,
    stripGrain: 'month',
    anchors: LINE_ANCHORS,
    lineVertexCount: 3,
    rateCells: [{ startMs: 5, endMs: 15, left: 150.5, right: 249.5 }],
    gamesCells: [{ startMs: 5, endMs: 15, left: 150.5, right: 249.5 }],
    formStripTicks: 0,
    ...overrides,
  };
}

function cellsOf(count, grainMs = 1) {
  return Array.from({ length: count }, (_, i) => ({
    startMs: i * grainMs,
    endMs: (i + 1) * grainMs,
    left: 100 + i * grainMs * 10 + 0.5,
    right: 100 + (i + 1) * grainMs * 10 - 0.5,
  }));
}

function typesOf(violations) {
  return violations.map((v) => v.type);
}

test('career-timeline: the seven oracle constants mirror the shared/kit bounds', () => {
  assert.equal(CAREER_TIMELINE_ALIGN_TOLERANCE_PX, 1.5);
  assert.equal(CAREER_TIMELINE_LINE_RESIDUAL_TOLERANCE_PX, 1);
  assert.equal(CAREER_TIMELINE_LINE_POINT_BOUND, 60);
  assert.equal(CAREER_TIMELINE_STRIP_CELL_BOUND, 108);
  assert.equal(CAREER_TIMELINE_NARROW_STRIP_CELL_BOUND, 36);
  assert.equal(CAREER_TIMELINE_NARROW_PLOT_PX, 520);
  assert.equal(CAREER_TIMELINE_FORM_STRIP_TICK_BOUND, 60);
});

test('career-timeline: no timeline root -> exactly one career-timeline-unmeasured', () => {
  const violations = evaluateCareerTimeline({ timelines: [], canvasCount: 0 });
  assert.deepEqual(typesOf(violations), ['career-timeline-unmeasured']);
});

test('career-timeline: two canvases -> one career-timeline-legacy-canvas carrying count 2', () => {
  const violations = evaluateCareerTimeline({ timelines: [makeTimeline()], canvasCount: 2 });
  const canvas = violations.filter((v) => v.type === 'career-timeline-legacy-canvas');
  assert.equal(canvas.length, 1);
  assert.equal(canvas[0].count, 2);
});

test('career-timeline: zero canvases -> no career-timeline-legacy-canvas', () => {
  const violations = evaluateCareerTimeline({ timelines: [makeTimeline()], canvasCount: 0 });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-legacy-canvas').length, 0);
});

test('career-timeline: an aligned, paired, bounded timeline passes clean', () => {
  assert.deepEqual(evaluateCareerTimeline({ timelines: [makeTimeline()], canvasCount: 0 }), []);
});

test('career-timeline: a rate cell 3px off the line mapping -> one career-timeline-axis-misaligned { track rate, edge left }', () => {
  const violations = evaluateCareerTimeline({
    timelines: [makeTimeline({ rateCells: [{ startMs: 5, endMs: 15, left: 153, right: 249.5 }] })],
    canvasCount: 0,
  });
  const misaligned = violations.filter((v) => v.type === 'career-timeline-axis-misaligned');
  assert.equal(misaligned.length, 1);
  assert.equal(misaligned[0].track, 'rate');
  assert.equal(misaligned[0].edge, 'left');
  assert.ok(Math.abs(misaligned[0].deltaPx - 3) < 1e-9);
});

test('career-timeline: a delta of exactly 1.5px passes (boundary)', () => {
  const violations = evaluateCareerTimeline({
    timelines: [
      makeTimeline({ rateCells: [{ startMs: 5, endMs: 15, left: 151.5, right: 248.5 }] }),
    ],
    canvasCount: 0,
  });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-axis-misaligned').length, 0);
});

test('career-timeline: the paired games cell shifted 2px -> career-timeline-axis-misaligned { track games }', () => {
  const violations = evaluateCareerTimeline({
    timelines: [
      makeTimeline({ gamesCells: [{ startMs: 5, endMs: 15, left: 152.5, right: 251.5 }] }),
    ],
    canvasCount: 0,
  });
  // Left edge 152.5 vs 150 (2.5px) fails; right edge 251.5 vs 250 sits on the 1.5px boundary.
  const misaligned = violations.filter((v) => v.type === 'career-timeline-axis-misaligned');
  assert.equal(misaligned.length, 1);
  assert.equal(misaligned[0].track, 'games');
  assert.equal(misaligned[0].edge, 'left');
});

test('career-timeline: a cell starting before the domain is expected at the plot left edge (clipped) and passes', () => {
  const clipped = { startMs: -5, endMs: 5, left: 100.5, right: 149.5 };
  const violations = evaluateCareerTimeline({
    timelines: [makeTimeline({ rateCells: [clipped], gamesCells: [clipped] })],
    canvasCount: 0,
  });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-axis-misaligned').length, 0);
});

test('career-timeline: an anchor 1.0px off the least-squares line passes', () => {
  // Residuals of a 4-anchor line with the third anchor lifted by `d`: the fit
  // absorbs part of the lift, so the lift is scaled until the WORST residual is exactly 1.0.
  const anchors = [
    { t: 0, cx: 100 },
    { t: 10, cx: 200 },
    { t: 20, cx: 300 + 4 / 3 },
    { t: 30, cx: 400 },
  ];
  const violations = evaluateCareerTimeline({
    timelines: [
      makeTimeline({ anchors, plotRight: 400, rateCells: [], gamesCells: [], stripGrain: null }),
    ],
    canvasCount: 0,
  });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-line-nonlinear').length, 0);
});

test('career-timeline: an anchor 2.0px off the least-squares line -> career-timeline-line-nonlinear', () => {
  const anchors = [
    { t: 0, cx: 100 },
    { t: 10, cx: 200 },
    { t: 20, cx: 300 + 8 / 3 },
    { t: 30, cx: 400 },
  ];
  const violations = evaluateCareerTimeline({
    timelines: [
      makeTimeline({ anchors, plotRight: 400, rateCells: [], gamesCells: [], stripGrain: null }),
    ],
    canvasCount: 0,
  });
  assert.ok(violations.some((v) => v.type === 'career-timeline-line-nonlinear'));
});

function lineOf(count) {
  return Array.from({ length: count }, (_, i) => ({ t: i, cx: 100 + i * 10 }));
}

test('career-timeline: 60 anchors with 60 path vertices pass the line bound', () => {
  const violations = evaluateCareerTimeline({
    timelines: [makeTimeline({ anchors: lineOf(60), lineVertexCount: 60, plotRight: 700 })],
    canvasCount: 0,
  });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-line-points').length, 0);
});

test('career-timeline: 61 anchors -> career-timeline-line-points', () => {
  const violations = evaluateCareerTimeline({
    timelines: [makeTimeline({ anchors: lineOf(61), lineVertexCount: 60, plotRight: 710 })],
    canvasCount: 0,
  });
  const points = violations.filter((v) => v.type === 'career-timeline-line-points');
  assert.equal(points.length, 1);
  assert.equal(points[0].measure, 'anchors');
});

test('career-timeline: 60 anchors but 61 path vertices -> career-timeline-line-points', () => {
  const violations = evaluateCareerTimeline({
    timelines: [makeTimeline({ anchors: lineOf(60), lineVertexCount: 61, plotRight: 700 })],
    canvasCount: 0,
  });
  const points = violations.filter((v) => v.type === 'career-timeline-line-points');
  assert.equal(points.length, 1);
  assert.equal(points[0].measure, 'vertices');
});

test('career-timeline: 108 cells per strip pass; 109 -> career-timeline-strip-cells for rate AND games', () => {
  const at108 = evaluateCareerTimeline({
    timelines: [
      makeTimeline({ rateCells: cellsOf(108), gamesCells: cellsOf(108), plotRight: 1180 }),
    ],
    canvasCount: 0,
  });
  assert.equal(at108.filter((v) => v.type === 'career-timeline-strip-cells').length, 0);
  const at109 = evaluateCareerTimeline({
    timelines: [
      makeTimeline({ rateCells: cellsOf(109), gamesCells: cellsOf(109), plotRight: 1190 }),
    ],
    canvasCount: 0,
  });
  const cells = at109.filter((v) => v.type === 'career-timeline-strip-cells');
  assert.deepEqual(
    cells.map((v) => v.track),
    ['rate', 'games'],
  );
});

test('career-timeline: a 248px plot at month grain -> career-timeline-narrow-grain', () => {
  const violations = evaluateCareerTimeline({
    timelines: [makeTimeline({ plotWidth: 248, stripGrain: 'month' })],
    canvasCount: 0,
  });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-narrow-grain').length, 1);
});

test('career-timeline: a 248px plot at quarter grain with 36 cells passes; 37 cells -> career-timeline-narrow-grain', () => {
  const at36 = evaluateCareerTimeline({
    timelines: [
      makeTimeline({
        plotWidth: 248,
        stripGrain: 'quarter',
        rateCells: cellsOf(36),
        gamesCells: cellsOf(36),
        plotRight: 460,
      }),
    ],
    canvasCount: 0,
  });
  assert.equal(at36.filter((v) => v.type === 'career-timeline-narrow-grain').length, 0);
  const at37 = evaluateCareerTimeline({
    timelines: [
      makeTimeline({
        plotWidth: 248,
        stripGrain: 'quarter',
        rateCells: cellsOf(37),
        gamesCells: cellsOf(37),
        plotRight: 470,
      }),
    ],
    canvasCount: 0,
  });
  assert.ok(at37.some((v) => v.type === 'career-timeline-narrow-grain'));
});

test('career-timeline: a 520px plot at month grain passes (boundary)', () => {
  const violations = evaluateCareerTimeline({
    timelines: [makeTimeline({ plotWidth: 520, stripGrain: 'month' })],
    canvasCount: 0,
  });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-narrow-grain').length, 0);
});

test('career-timeline: differing rate/games cell counts -> career-timeline-strip-pairing', () => {
  const violations = evaluateCareerTimeline({
    timelines: [makeTimeline({ rateCells: cellsOf(2, 5), gamesCells: cellsOf(1, 5) })],
    canvasCount: 0,
  });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-strip-pairing').length, 1);
});

test('career-timeline: a rate cell with no games cell at the same startMs -> career-timeline-strip-pairing', () => {
  const violations = evaluateCareerTimeline({
    timelines: [
      makeTimeline({
        rateCells: [{ startMs: 5, endMs: 15, left: 150.5, right: 249.5 }],
        gamesCells: [{ startMs: 6, endMs: 15, left: 160.5, right: 249.5 }],
      }),
    ],
    canvasCount: 0,
  });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-strip-pairing').length, 1);
});

test('career-timeline: a full timeline with fewer than 2 anchors -> career-timeline-line-unmeasured', () => {
  const violations = evaluateCareerTimeline({
    timelines: [makeTimeline({ anchors: [{ t: 0, cx: 100 }] })],
    canvasCount: 0,
  });
  assert.ok(violations.some((v) => v.type === 'career-timeline-line-unmeasured'));
});

test('career-timeline: a locked timeline with 0 anchors and no expectation passes', () => {
  const violations = evaluateCareerTimeline({
    timelines: [
      makeTimeline({
        state: 'locked',
        anchors: [],
        lineVertexCount: 0,
        rateCells: [],
        gamesCells: [],
        stripGrain: null,
      }),
    ],
    canvasCount: 0,
  });
  assert.deepEqual(violations, []);
});

test('career-timeline: expectation { strips: true } on a thin timeline or one with 0 cells -> career-timeline-strips-missing', () => {
  const thin = evaluateCareerTimeline(
    { timelines: [makeTimeline({ state: 'thin' })], canvasCount: 0 },
    { strips: true },
  );
  assert.ok(thin.some((v) => v.type === 'career-timeline-strips-missing'));
  const empty = evaluateCareerTimeline(
    {
      timelines: [makeTimeline({ rateCells: [], gamesCells: [], stripGrain: null })],
      canvasCount: 0,
    },
    { strips: true },
  );
  assert.ok(empty.some((v) => v.type === 'career-timeline-strips-missing'));
  const ok = evaluateCareerTimeline(
    { timelines: [makeTimeline()], canvasCount: 0 },
    { strips: true },
  );
  assert.equal(ok.filter((v) => v.type === 'career-timeline-strips-missing').length, 0);
});

test('career-timeline: 61 form-strip ticks -> career-timeline-form-strip-ticks; 60 pass', () => {
  const at61 = evaluateCareerTimeline({
    timelines: [makeTimeline({ formStripTicks: 61 })],
    canvasCount: 0,
  });
  assert.ok(at61.some((v) => v.type === 'career-timeline-form-strip-ticks'));
  const at60 = evaluateCareerTimeline({
    timelines: [makeTimeline({ formStripTicks: 60 })],
    canvasCount: 0,
  });
  assert.equal(at60.filter((v) => v.type === 'career-timeline-form-strip-ticks').length, 0);
});

test('career-timeline: expectation { formStrip: true } on a thin timeline with 0 ticks -> career-timeline-form-strip-missing', () => {
  const thinTimeline = makeTimeline({
    state: 'thin',
    rateCells: [],
    gamesCells: [],
    stripGrain: null,
  });
  const missing = evaluateCareerTimeline(
    { timelines: [thinTimeline], canvasCount: 0 },
    { formStrip: true },
  );
  assert.ok(missing.some((v) => v.type === 'career-timeline-form-strip-missing'));
  const present = evaluateCareerTimeline(
    { timelines: [{ ...thinTimeline, formStripTicks: 12 }], canvasCount: 0 },
    { formStrip: true },
  );
  assert.equal(present.filter((v) => v.type === 'career-timeline-form-strip-missing').length, 0);
});

test('career-timeline: expectation { state: thin } on a full timeline -> career-timeline-state-mismatch', () => {
  const violations = evaluateCareerTimeline(
    { timelines: [makeTimeline()], canvasCount: 0 },
    { state: 'thin' },
  );
  assert.ok(violations.some((v) => v.type === 'career-timeline-state-mismatch'));
  const ok = evaluateCareerTimeline(
    { timelines: [makeTimeline()], canvasCount: 0 },
    { state: 'full' },
  );
  assert.equal(ok.filter((v) => v.type === 'career-timeline-state-mismatch').length, 0);
});

test('career-timeline: a multi-offender input returns ALL offenders (two timelines, both misaligned, plus the canvas)', () => {
  const bad = makeTimeline({ rateCells: [{ startMs: 5, endMs: 15, left: 153, right: 249.5 }] });
  const violations = evaluateCareerTimeline({
    timelines: [bad, { ...bad, selectorPath: '#second' }],
    canvasCount: 1,
  });
  assert.equal(violations.filter((v) => v.type === 'career-timeline-axis-misaligned').length, 2);
  assert.equal(violations.filter((v) => v.type === 'career-timeline-legacy-canvas').length, 1);
});

// --- plot-aspect (plan 39.1-37, event-chart-aspect; UI-SPEC §6.1 aspect <= 4:1) ---

function plotAspect() {
  const fn = guardLayoutCoreNs.evaluatePlotAspect;
  assert.equal(typeof fn, 'function', 'evaluatePlotAspect is exported');
  return fn;
}

test('plot-aspect: PLOT_ASPECT_MAX is 4 and PLOT_ASPECT_MIN_VIEWPORT_WIDTH_PX is 1024', () => {
  assert.equal(guardLayoutCoreNs.PLOT_ASPECT_MAX, 4);
  assert.equal(guardLayoutCoreNs.PLOT_ASPECT_MIN_VIEWPORT_WIDTH_PX, 1024);
});

test('plot-aspect: a 1390x288 surface at 1440x900 is one plot-aspect violation (4.83 > 4)', () => {
  const violations = plotAspect()({
    viewportWidth: 1440,
    surfaces: [{ selectorPath: '#trend', width: 1390, height: 288 }],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'plot-aspect');
  assert.equal(Math.round(violations[0].ratio * 100) / 100, 4.83);
});

test('plot-aspect: a 900x288 surface passes', () => {
  const violations = plotAspect()({
    viewportWidth: 1440,
    surfaces: [{ selectorPath: '#trend', width: 900, height: 288 }],
  });
  assert.equal(violations.length, 0);
});

test("plot-aspect: a 700x160 surface (the hero's compact trend, at or under CHART_H_COMPACT + 8) is exempt", () => {
  const violations = plotAspect()({
    viewportWidth: 1440,
    surfaces: [{ selectorPath: '#hero', width: 700, height: 160 }],
  });
  assert.equal(violations.length, 0);
});

test('plot-aspect: viewports under 1024 wide are not evaluated', () => {
  const violations = plotAspect()({
    viewportWidth: 390,
    surfaces: [{ selectorPath: '#trend', width: 1390, height: 288 }],
  });
  assert.equal(violations.length, 0);
});

test('plot-aspect: no surface at all on an opted route is plot-aspect-unmeasured', () => {
  const violations = plotAspect()({ viewportWidth: 1440, surfaces: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'plot-aspect-unmeasured');
});

// ---------------------------------------------------------------------------
// Plan 39.1-38: the page-frame oracle families — filter-row, stat-row-columns,
// placement, insight-order. Read through the namespace so a RED run fails on
// an assertion instead of a module-link error.
// ---------------------------------------------------------------------------

const ns38 = guardLayoutCoreNs;
function fn38(name) {
  const f = ns38[name];
  assert.equal(typeof f, 'function', `${name} is exported`);
  return f;
}
const cleanRow = (overrides = {}) => ({
  selectorPath: '#row',
  borderWidths: [0, 0, 0, 0],
  inCard: false,
  height: 56,
  ...overrides,
});

test('filter-row: a clean unboxed row at 1440 passes', () => {
  const evaluateFilterRow = fn38('evaluateFilterRow');
  const v = evaluateFilterRow({
    viewportWidth: 1440,
    maxHeightPx: 72,
    rows: [cleanRow({ ownedInside: ['h1', '[data-slot="horizon-switch"]'] })],
    owners: ['h1', '[data-slot="horizon-switch"]'],
    ownedInCards: [],
  });
  assert.deepEqual(v, []);
});

test('filter-row: any non-zero border width is filter-row-bordered', () => {
  const evaluateFilterRow = fn38('evaluateFilterRow');
  const v = evaluateFilterRow({
    viewportWidth: 1440,
    rows: [cleanRow({ borderWidths: [0, 0, 1, 0] })],
    ownedInCards: [],
  });
  assert.deepEqual(typesOf(v), ['filter-row-bordered']);
});

test('filter-row: a row inside a card is filter-row-in-card', () => {
  const evaluateFilterRow = fn38('evaluateFilterRow');
  const v = evaluateFilterRow({
    viewportWidth: 1440,
    rows: [cleanRow({ inCard: true })],
    ownedInCards: [],
  });
  assert.deepEqual(typesOf(v), ['filter-row-in-card']);
});

test('filter-row: a card holding the page h1 and one holding the horizon switch are title-in-card + switch-in-card', () => {
  const evaluateFilterRow = fn38('evaluateFilterRow');
  const v = evaluateFilterRow({
    viewportWidth: 1440,
    rows: [cleanRow()],
    ownedInCards: [
      { selector: 'h1', selectorPath: 'h1' },
      { selector: '[data-slot="horizon-switch"]', selectorPath: 'div' },
    ],
  });
  assert.deepEqual(typesOf(v), ['title-in-card', 'switch-in-card']);
});

test('filter-row: 72px at 1024 passes, 73px fails filter-row-tall, 73px at 1023 is not evaluated', () => {
  const evaluateFilterRow = fn38('evaluateFilterRow');
  const at = (viewportWidth, height) =>
    evaluateFilterRow({
      viewportWidth,
      maxHeightPx: 72,
      rows: [cleanRow({ height })],
      ownedInCards: [],
    });
  assert.deepEqual(at(1024, 72), []);
  assert.deepEqual(typesOf(at(1024, 73)), ['filter-row-tall']);
  assert.deepEqual(at(1023, 73), []);
});

test('filter-row: no maxHeightPx declared means no height limit', () => {
  const evaluateFilterRow = fn38('evaluateFilterRow');
  const v = evaluateFilterRow({
    viewportWidth: 1440,
    rows: [cleanRow({ height: 140 })],
    ownedInCards: [],
  });
  assert.deepEqual(v, []);
});

test('filter-row: two rows are filter-row-duplicate, and every offender on both rows is returned', () => {
  const evaluateFilterRow = fn38('evaluateFilterRow');
  const v = evaluateFilterRow({
    viewportWidth: 1440,
    rows: [
      cleanRow({ inCard: true }),
      cleanRow({ selectorPath: '#b', borderWidths: [1, 1, 1, 1] }),
    ],
    ownedInCards: [],
  });
  assert.deepEqual(
    typesOf(v).sort(),
    ['filter-row-bordered', 'filter-row-duplicate', 'filter-row-in-card'].sort(),
  );
});

test('filter-row: a declared owner rendered outside the row is filter-row-missing-owner', () => {
  const evaluateFilterRow = fn38('evaluateFilterRow');
  const v = evaluateFilterRow({
    viewportWidth: 1440,
    rows: [cleanRow({ ownedInside: ['[data-slot="horizon-switch"]'] })],
    owners: ['h1', '[data-slot="horizon-switch"]'],
    ownedInCards: [],
  });
  assert.deepEqual(typesOf(v), ['filter-row-missing-owner']);
  assert.equal(v[0].owner, 'h1');
});

test('filter-row: no row at all is exactly one filter-row-unmeasured (plus the in-card owners it did find)', () => {
  const evaluateFilterRow = fn38('evaluateFilterRow');
  assert.deepEqual(
    typesOf(evaluateFilterRow({ viewportWidth: 1440, rows: [], ownedInCards: [] })),
    ['filter-row-unmeasured'],
  );
  const v = evaluateFilterRow({
    viewportWidth: 1440,
    rows: [],
    owners: ['h1', '[data-slot="horizon-switch"]'],
    ownedInCards: [
      { selector: 'h1', selectorPath: 'h1' },
      { selector: '[data-slot="horizon-switch"]', selectorPath: 'div' },
    ],
  });
  assert.deepEqual(typesOf(v), ['filter-row-unmeasured', 'title-in-card', 'switch-in-card']);
});

const statRow = (lefts, overrides = {}) => ({
  selectorPath: '#stat',
  fixedColumns: false,
  leadSpan: false,
  rowWidth: 340,
  children: lefts.map((left) => ({ left, width: 158 })),
  ...overrides,
});

test('stat-row-columns: children at lefts 0 / 180 / 360 at 390 are one stat-row-columns violation (3 columns)', () => {
  const evaluateStatRowColumns = fn38('evaluateStatRowColumns');
  const v = evaluateStatRowColumns([statRow([0, 180, 360])]);
  assert.deepEqual(typesOf(v), ['stat-row-columns']);
  assert.equal(v[0].columns, 3);
});

test('stat-row-columns: a plain 2 x 2 grid (0 / 180 / 0 / 180) passes', () => {
  const evaluateStatRowColumns = fn38('evaluateStatRowColumns');
  assert.deepEqual(evaluateStatRowColumns([statRow([0, 180, 0, 180])]), []);
});

test('stat-row-columns: lefts within 2px are one column (0 / 181.5 / 1 / 180 passes)', () => {
  const evaluateStatRowColumns = fn38('evaluateStatRowColumns');
  assert.deepEqual(evaluateStatRowColumns([statRow([0, 181.5, 1, 180])]), []);
});

test('stat-row-columns: a data-fixed-columns row is skipped', () => {
  const evaluateStatRowColumns = fn38('evaluateStatRowColumns');
  assert.deepEqual(evaluateStatRowColumns([statRow([0, 110, 220], { fixedColumns: true })]), []);
});

test('stat-row-columns: a first child spanning the full row is stat-row-lead-span unless the row carries data-lead-span', () => {
  const evaluateStatRowColumns = fn38('evaluateStatRowColumns');
  const spanning = (leadSpan) =>
    statRow([0, 0, 180, 0, 180], { leadSpan }).children.map((c, i) =>
      i === 0 ? { ...c, width: 340 } : c,
    );
  const row = (leadSpan) => ({ ...statRow([], { leadSpan }), children: spanning(leadSpan) });
  assert.deepEqual(typesOf(evaluateStatRowColumns([row(false)])), ['stat-row-lead-span']);
  assert.deepEqual(evaluateStatRowColumns([row(true)]), []);
});

test('stat-row-columns: multi-offender input returns every offender; zero-width (hidden) children are ignored', () => {
  const evaluateStatRowColumns = fn38('evaluateStatRowColumns');
  const hidden = statRow([0, 180]);
  hidden.children.push({ left: 400, width: 0 });
  const v = evaluateStatRowColumns([
    statRow([0, 90, 180, 270], { selectorPath: '#a' }),
    statRow([0, 110, 220], { selectorPath: '#b' }),
    hidden,
  ]);
  assert.deepEqual(
    v.map((x) => x.selectorPath),
    ['#a', '#b'],
  );
});

test('stat-row-columns: no stat row at all is exactly one stat-row-columns-unmeasured', () => {
  const evaluateStatRowColumns = fn38('evaluateStatRowColumns');
  assert.deepEqual(typesOf(evaluateStatRowColumns([])), ['stat-row-columns-unmeasured']);
});

const rect = (left, right, top, bottom) => ({ left, right, top, bottom });

test('placement: a subject within 2px of its anchor column with a grid-gap top passes', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  const v = evaluatePlacement({
    viewportWidth: 1440,
    items: [
      {
        kind: 'within-column',
        subjectSelector: '#lists',
        subject: rect(26, 958, 616, 900),
        anchor: rect(25, 960, 100, 600),
        gapPx: 16,
      },
    ],
  });
  assert.deepEqual(v, []);
});

test('placement: 3px out of the anchor column is placement-column', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  const v = evaluatePlacement({
    viewportWidth: 1440,
    items: [
      {
        kind: 'within-column',
        subjectSelector: '#lists',
        subject: rect(25, 963, 616, 900),
        anchor: rect(25, 960, 100, 600),
        gapPx: 16,
      },
    ],
  });
  assert.deepEqual(typesOf(v), ['placement-column']);
});

test('placement: a full-width subject under an 8-col anchor with a larger gap is placement-column + placement-gap', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  const v = evaluatePlacement({
    viewportWidth: 1440,
    items: [
      {
        kind: 'within-column',
        subjectSelector: '#lists',
        subject: rect(25, 1415, 1200, 1500),
        anchor: rect(25, 960, 100, 600),
        gapPx: 16,
      },
    ],
  });
  assert.deepEqual(typesOf(v), ['placement-column', 'placement-gap']);
});

test('placement: gap 18 passes (16 plus 2), gap 18.5 fails placement-gap', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  const at = (top) =>
    evaluatePlacement({
      viewportWidth: 1440,
      items: [
        {
          kind: 'within-column',
          subjectSelector: '#lists',
          subject: rect(25, 960, top, top + 200),
          anchor: rect(25, 960, 100, 600),
          gapPx: 16,
        },
      ],
    });
  assert.deepEqual(at(618), []);
  assert.deepEqual(typesOf(at(618.5)), ['placement-gap']);
});

test('placement: two list cards with tops 2px apart pass, 3px apart fail placement-not-side-by-side (page at least 860)', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  const at = (secondTop, pageWidth) =>
    evaluatePlacement({
      viewportWidth: 1440,
      items: [
        {
          kind: 'side-by-side',
          parentSelector: '#lists',
          children: [rect(0, 400, 600, 800), rect(416, 816, secondTop, 900)],
          pageWidth,
          minPageWidthPx: 860,
        },
      ],
    });
  assert.deepEqual(at(602, 1390), []);
  assert.deepEqual(typesOf(at(603, 1390)), ['placement-not-side-by-side']);
  assert.deepEqual(at(1000, 859), []);
});

test('placement: under 1024 wide nothing is evaluated', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  const v = evaluatePlacement({
    viewportWidth: 390,
    items: [
      {
        kind: 'within-column',
        subjectSelector: '#lists',
        subject: rect(0, 390, 2000, 2400),
        anchor: rect(0, 390, 0, 600),
        gapPx: 16,
      },
    ],
  });
  assert.deepEqual(v, []);
});

test('placement: multi-offender input returns every offender', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  const v = evaluatePlacement({
    viewportWidth: 2560,
    items: [
      {
        kind: 'within-column',
        subjectSelector: '#lists',
        subject: rect(25, 1415, 1200, 1500),
        anchor: rect(25, 960, 100, 600),
        gapPx: 16,
      },
      {
        kind: 'side-by-side',
        parentSelector: '#lists',
        children: [rect(0, 400, 600, 800), rect(0, 400, 820, 900)],
        pageWidth: 1440,
        minPageWidthPx: 860,
      },
    ],
  });
  assert.deepEqual(typesOf(v), ['placement-column', 'placement-gap', 'placement-not-side-by-side']);
});

test('placement: a missing subject or anchor, or fewer than two side-by-side children, is placement-unmeasured; empty input is exactly one', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  assert.deepEqual(typesOf(evaluatePlacement({ viewportWidth: 1440, items: [] })), [
    'placement-unmeasured',
  ]);
  const v = evaluatePlacement({
    viewportWidth: 1440,
    items: [
      {
        kind: 'within-column',
        subjectSelector: '#lists',
        subject: null,
        anchor: rect(0, 1, 0, 1),
        gapPx: 16,
      },
      {
        kind: 'side-by-side',
        parentSelector: '#lists',
        children: [rect(0, 1, 0, 1)],
        pageWidth: 1440,
        minPageWidthPx: 860,
      },
    ],
  });
  assert.deepEqual(typesOf(v), ['placement-unmeasured', 'placement-unmeasured']);
});

test('insight-order: first.top greater than then.top is one insight-order violation', () => {
  const evaluateInsightOrder = fn38('evaluateInsightOrder');
  const v = evaluateInsightOrder([
    { first: '#reads', then: '#chart', firstTop: 900, thenTop: 400 },
  ]);
  assert.deepEqual(typesOf(v), ['insight-order']);
  assert.equal(v[0].first, '#reads');
});

test('insight-order: equal or smaller tops pass', () => {
  const evaluateInsightOrder = fn38('evaluateInsightOrder');
  assert.deepEqual(
    evaluateInsightOrder([
      { first: '#a', then: '#b', firstTop: 400, thenTop: 400 },
      { first: '#b', then: '#c', firstTop: 400, thenTop: 900 },
    ]),
    [],
  );
});

test('insight-order: multi-offender input returns every offender', () => {
  const evaluateInsightOrder = fn38('evaluateInsightOrder');
  const v = evaluateInsightOrder([
    { first: '#a', then: '#b', firstTop: 900, thenTop: 400 },
    { first: '#c', then: '#d', firstTop: 901, thenTop: 900 },
  ]);
  assert.deepEqual(typesOf(v), ['insight-order', 'insight-order']);
});

test('insight-order: a declared selector matching nothing is insight-order-unmeasured naming it; empty input is exactly one', () => {
  const evaluateInsightOrder = fn38('evaluateInsightOrder');
  const v = evaluateInsightOrder([
    { first: '#reads', then: '#chart', firstTop: null, thenTop: 10 },
  ]);
  assert.deepEqual(typesOf(v), ['insight-order-unmeasured']);
  assert.equal(v[0].missing, '#reads');
  assert.deepEqual(typesOf(evaluateInsightOrder([])), ['insight-order-unmeasured']);
});

// Plan 39.1-38 Task 3: placement `above` (the desktop composition kept by grid
// placement) and table-clip (nothing hidden behind a horizontal scroll at 390).

test('placement: above — first starting above then passes; level or below is placement-not-above', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  const at = (firstTop, thenTop) =>
    evaluatePlacement({
      viewportWidth: 1440,
      items: [
        {
          kind: 'above',
          firstSelector: '#timeline',
          thenSelector: '#reads',
          first: rect(0, 100, firstTop, firstTop + 50),
          then: rect(0, 100, thenTop, thenTop + 50),
        },
      ],
    });
  assert.deepEqual(at(100, 400), []);
  assert.deepEqual(typesOf(at(400, 400)), ['placement-not-above']);
  assert.deepEqual(typesOf(at(900, 400)), ['placement-not-above']);
});

test('placement: above — a missing element is placement-unmeasured naming it', () => {
  const evaluatePlacement = fn38('evaluatePlacement');
  const v = evaluatePlacement({
    viewportWidth: 1440,
    items: [
      {
        kind: 'above',
        firstSelector: '#t',
        thenSelector: '#r',
        first: null,
        then: rect(0, 1, 0, 1),
      },
    ],
  });
  assert.deepEqual(typesOf(v), ['placement-unmeasured']);
  assert.equal(v[0].selector, '#t');
});

test('table-clip: a target whose scroll container is 420 wide in a 326 box is one table-clipped violation', () => {
  const evaluateTableClip = fn38('evaluateTableClip');
  const v = evaluateTableClip([
    { selector: '#by-char', found: true, selectorPath: 'div', scrollWidth: 420, clientWidth: 326 },
  ]);
  assert.deepEqual(typesOf(v), ['table-clipped']);
  assert.equal(v[0].selector, '#by-char');
});

test('table-clip: 327 in a 326 box passes (1px tolerance)', () => {
  const evaluateTableClip = fn38('evaluateTableClip');
  assert.deepEqual(
    evaluateTableClip([
      {
        selector: '#by-char',
        found: true,
        selectorPath: 'div',
        scrollWidth: 327,
        clientWidth: 326,
      },
    ]),
    [],
  );
});

test('table-clip: a target with no clipping ancestor (null sizes) passes', () => {
  const evaluateTableClip = fn38('evaluateTableClip');
  assert.deepEqual(
    evaluateTableClip([
      {
        selector: '#by-char',
        found: true,
        selectorPath: null,
        scrollWidth: null,
        clientWidth: null,
      },
    ]),
    [],
  );
});

test('table-clip: two clipping targets are two violations', () => {
  const evaluateTableClip = fn38('evaluateTableClip');
  const v = evaluateTableClip([
    { selector: '#a', found: true, selectorPath: 'div', scrollWidth: 420, clientWidth: 326 },
    { selector: '#b', found: true, selectorPath: 'div', scrollWidth: 500, clientWidth: 300 },
  ]);
  assert.deepEqual(typesOf(v), ['table-clipped', 'table-clipped']);
});

test('table-clip: a declared target matching nothing is exactly one table-clip-unmeasured naming it; empty input is exactly one', () => {
  const evaluateTableClip = fn38('evaluateTableClip');
  const v = evaluateTableClip([{ selector: '#by-char', found: false }]);
  assert.deepEqual(typesOf(v), ['table-clip-unmeasured']);
  assert.equal(v[0].selector, '#by-char');
  assert.deepEqual(typesOf(evaluateTableClip([])), ['table-clip-unmeasured']);
});

// ---------------------------------------------------------------------------
// Plan 39.1-39: brand-red-text and record-fit (read through the namespace so
// a RED run fails on an assertion, not a module-link error).
// ---------------------------------------------------------------------------

const PROBE = 'oklch(0.577 0.245 27.325)';
const redEl = (overrides = {}) => ({
  tag: 'button',
  text: 'Show all',
  selectorPath: 'div > button',
  color: PROBE,
  ...overrides,
});

test('brand-red-text: every element whose colour equals the probe is one violation naming tag, text and selector', () => {
  const evaluateBrandRedText = fn38('evaluateBrandRedText');
  const v = evaluateBrandRedText({
    probe: PROBE,
    scanned: 40,
    elements: [redEl(), redEl({ tag: 'a', text: 'Genesis 9', selectorPath: 'td > a' })],
  });
  assert.deepEqual(typesOf(v), ['brand-red-text', 'brand-red-text']);
  assert.equal(v[0].tag, 'button');
  assert.equal(v[0].text, 'Show all');
  assert.equal(v[1].selectorPath, 'td > a');
});

test('brand-red-text: an rgb probe matches an rgb element exactly', () => {
  const evaluateBrandRedText = fn38('evaluateBrandRedText');
  const v = evaluateBrandRedText({
    probe: 'rgb(230, 0, 18)',
    scanned: 3,
    elements: [redEl({ color: 'rgb(230, 0, 18)' })],
  });
  assert.deepEqual(typesOf(v), ['brand-red-text']);
});

test('brand-red-text: an element one channel unit away from the probe is not a violation', () => {
  const evaluateBrandRedText = fn38('evaluateBrandRedText');
  const v = evaluateBrandRedText({
    probe: 'rgb(230, 0, 18)',
    scanned: 3,
    elements: [redEl({ color: 'rgb(230, 0, 19)' }), redEl({ color: 'rgb(229, 0, 18)' })],
  });
  assert.deepEqual(v, []);
});

test('brand-red-text: an empty or transparent probe is exactly one brand-red-text-unmeasured', () => {
  const evaluateBrandRedText = fn38('evaluateBrandRedText');
  for (const probe of ['', 'rgba(0, 0, 0, 0)', 'transparent', undefined]) {
    const v = evaluateBrandRedText({ probe, scanned: 12, elements: [redEl()] });
    assert.deepEqual(typesOf(v), ['brand-red-text-unmeasured'], String(probe));
  }
});

test('brand-red-text: zero scanned text elements is exactly one brand-red-text-unmeasured', () => {
  const evaluateBrandRedText = fn38('evaluateBrandRedText');
  assert.deepEqual(typesOf(evaluateBrandRedText({ probe: PROBE, scanned: 0, elements: [] })), [
    'brand-red-text-unmeasured',
  ]);
});

const recBox = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

test('record-fit: two record rects in one card that intersect are one record-overlap naming both texts', () => {
  const evaluateRecordFit = fn38('evaluateRecordFit');
  const v = evaluateRecordFit([
    {
      selectorPath: '#card',
      records: [
        {
          text: '1,026–184 · 85% · 1,210',
          rect: recBox(0, 0, 130, 16),
          cellRect: recBox(0, 0, 130, 60),
        },
        {
          text: '6–184 · 3% · 190',
          rect: recBox(120, 0, 100, 16),
          cellRect: recBox(120, 0, 100, 60),
        },
      ],
    },
  ]);
  assert.deepEqual(typesOf(v), ['record-overlap']);
  assert.deepEqual(v[0].texts, ['1,026–184 · 85% · 1,210', '6–184 · 3% · 190']);
});

test('record-fit: rects 1px apart are not an overlap', () => {
  const evaluateRecordFit = fn38('evaluateRecordFit');
  const v = evaluateRecordFit([
    {
      selectorPath: '#card',
      records: [
        { text: 'a', rect: recBox(0, 0, 100, 16), cellRect: recBox(0, 0, 100, 60) },
        { text: 'b', rect: recBox(101, 0, 100, 16), cellRect: recBox(101, 0, 100, 60) },
      ],
    },
  ]);
  assert.deepEqual(v, []);
});

test('record-fit: a record over its figure cell right edge by more than 0.5px is record-overflow; exactly at the edge passes', () => {
  const evaluateRecordFit = fn38('evaluateRecordFit');
  const over = evaluateRecordFit([
    {
      selectorPath: '#card',
      records: [{ text: 'a', rect: recBox(0, 0, 100.6, 16), cellRect: recBox(0, 0, 100, 60) }],
    },
  ]);
  assert.deepEqual(typesOf(over), ['record-overflow']);
  const edge = evaluateRecordFit([
    {
      selectorPath: '#card',
      records: [{ text: 'a', rect: recBox(0, 0, 100, 16), cellRect: recBox(0, 0, 100, 60) }],
    },
  ]);
  assert.deepEqual(edge, []);
});

test('record-fit: records in different cards are never compared', () => {
  const evaluateRecordFit = fn38('evaluateRecordFit');
  const v = evaluateRecordFit([
    {
      selectorPath: '#a',
      records: [{ text: 'a', rect: recBox(0, 0, 100, 16), cellRect: recBox(0, 0, 100, 60) }],
    },
    {
      selectorPath: '#b',
      records: [{ text: 'b', rect: recBox(50, 0, 100, 16), cellRect: recBox(50, 0, 100, 60) }],
    },
  ]);
  assert.deepEqual(v, []);
});

test('record-fit: a route that requested the family but collected no record is exactly one record-fit-unmeasured', () => {
  const evaluateRecordFit = fn38('evaluateRecordFit');
  assert.deepEqual(typesOf(evaluateRecordFit([])), ['record-fit-unmeasured']);
  assert.deepEqual(typesOf(evaluateRecordFit([{ selectorPath: '#a', records: [] }])), [
    'record-fit-unmeasured',
  ]);
  assert.deepEqual(typesOf(evaluateFamilyPresence('record-fit', [])), ['record-fit-unmeasured']);
});

// ---------------------------------------------------------------------------
// Plan 39.1-39: mark-count and matrix-hug (namespace reads — RED fails on an
// assertion, not a module-link error).
// ---------------------------------------------------------------------------

test('mark-count: a line with 150 point marks is one mark-count-over (count 150, limit 60)', () => {
  const evaluateMarkCount = fn38('evaluateMarkCount');
  const v = evaluateMarkCount([{ selectorPath: '#trend', count: 150 }]);
  assert.deepEqual(typesOf(v), ['mark-count-over']);
  assert.equal(v[0].count, 150);
  assert.equal(v[0].limit, 60);
});

test('mark-count: exactly 60 point marks passes', () => {
  const evaluateMarkCount = fn38('evaluateMarkCount');
  assert.deepEqual(evaluateMarkCount([{ selectorPath: '#trend', count: 60 }]), []);
});

test('mark-count: a route that requested the family but rendered no line is exactly one mark-count-unmeasured', () => {
  const evaluateMarkCount = fn38('evaluateMarkCount');
  assert.deepEqual(typesOf(evaluateMarkCount([])), ['mark-count-unmeasured']);
});

test('matrix-hug: a matrix table 200px right of its card content edge is one matrix-not-left-aligned', () => {
  const evaluateMatrixHug = fn38('evaluateMatrixHug');
  const v = evaluateMatrixHug({
    viewportWidth: 1440,
    tables: [{ selectorPath: '#m', left: 524, contentLeft: 324 }],
  });
  assert.deepEqual(typesOf(v), ['matrix-not-left-aligned']);
  assert.equal(v[0].offsetPx, 200);
});

test('matrix-hug: a table within 2px of the content edge passes', () => {
  const evaluateMatrixHug = fn38('evaluateMatrixHug');
  assert.deepEqual(
    evaluateMatrixHug({
      viewportWidth: 1440,
      tables: [{ selectorPath: '#m', left: 326, contentLeft: 324 }],
    }),
    [],
  );
});

test('matrix-hug: under 1024px the family is not evaluated', () => {
  const evaluateMatrixHug = fn38('evaluateMatrixHug');
  assert.deepEqual(
    evaluateMatrixHug({
      viewportWidth: 390,
      tables: [{ selectorPath: '#m', left: 524, contentLeft: 324 }],
    }),
    [],
  );
  assert.deepEqual(evaluateMatrixHug({ viewportWidth: 1023, tables: [] }), []);
});

test('matrix-hug: no matrix at 1024px and wider is exactly one matrix-hug-unmeasured', () => {
  const evaluateMatrixHug = fn38('evaluateMatrixHug');
  assert.deepEqual(typesOf(evaluateMatrixHug({ viewportWidth: 1024, tables: [] })), [
    'matrix-hug-unmeasured',
  ]);
});

// ---------------------------------------------------------------------------
// Plan 39.1-49: the all-route table-clip sweep, route prepare steps and the
// text-fit family. Read through the namespace (fn38) so a RED run fails on an
// assertion rather than a module-link error.
// ---------------------------------------------------------------------------

const sweepItem = (overrides = {}) => ({
  targetPath: 'ul',
  kind: 'ul',
  hidden: false,
  clipId: 0,
  clipPath: 'div.card',
  scrollWidth: 326,
  clientWidth: 326,
  ...overrides,
});
const sweepPage = { scrollWidth: 390, innerWidth: 390 };

test('table-clip: sweep — a candidate whose clip container is 420 wide in a 326 box is one table-clipped violation naming the container', () => {
  const evaluateTableClipSweep = fn38('evaluateTableClipSweep');
  const v = evaluateTableClipSweep({
    candidates: [sweepItem({ targetPath: 'table', clipPath: '#wrap', scrollWidth: 420 })],
    declared: [],
    page: sweepPage,
  });
  assert.deepEqual(typesOf(v), ['table-clipped']);
  assert.equal(v[0].selectorPath, '#wrap');
});

test('table-clip: sweep — 327 in a 326 box passes (1px tolerance); no clip container (null sizes) passes', () => {
  const evaluateTableClipSweep = fn38('evaluateTableClipSweep');
  assert.deepEqual(
    evaluateTableClipSweep({ candidates: [sweepItem({ scrollWidth: 327 })], page: sweepPage }),
    [],
  );
  assert.deepEqual(
    evaluateTableClipSweep({
      candidates: [
        sweepItem({ clipId: null, clipPath: null, scrollWidth: null, clientWidth: null }),
      ],
      page: sweepPage,
    }),
    [],
  );
});

test('table-clip: sweep — hidden candidates (sr-only, display:none, print-only) are skipped and not counted as scanned', () => {
  const evaluateTableClipSweep = fn38('evaluateTableClipSweep');
  const tableClipSweepScanned = fn38('tableClipSweepScanned');
  const input = {
    candidates: [
      sweepItem({ targetPath: 'ul.visible' }),
      sweepItem({ targetPath: 'ul.sr-only', hidden: true, clipId: 1, scrollWidth: 900 }),
      sweepItem({ targetPath: 'ul.none', hidden: true, clipId: 2, scrollWidth: 900 }),
      sweepItem({ targetPath: 'ul.print', hidden: true, clipId: 3, scrollWidth: 900 }),
    ],
    declared: [],
    page: sweepPage,
  };
  assert.deepEqual(evaluateTableClipSweep(input), []);
  assert.equal(tableClipSweepScanned(input), 1);
});

test('table-clip: sweep — three candidates sharing one clip container are ONE violation; two containers are two', () => {
  const evaluateTableClipSweep = fn38('evaluateTableClipSweep');
  const one = evaluateTableClipSweep({
    candidates: [
      sweepItem({ targetPath: 'table', clipId: 4, scrollWidth: 500 }),
      sweepItem({ targetPath: 'ul:nth-of-type(1)', clipId: 4, scrollWidth: 500 }),
      sweepItem({ targetPath: 'ul:nth-of-type(2)', clipId: 4, scrollWidth: 500 }),
    ],
    page: sweepPage,
  });
  assert.deepEqual(typesOf(one), ['table-clipped']);
  assert.equal(one[0].candidates.length, 3);
  const two = evaluateTableClipSweep({
    candidates: [
      sweepItem({ targetPath: 'table', clipId: 4, scrollWidth: 500 }),
      sweepItem({ targetPath: 'ol', clipId: 5, scrollWidth: 500 }),
    ],
    page: sweepPage,
  });
  assert.deepEqual(typesOf(two), ['table-clipped', 'table-clipped']);
});

test('table-clip: sweep — zero visible candidates is exactly one table-clip-unmeasured; a declared target matching nothing is unmeasured naming it; a declared target that clips is table-clipped', () => {
  const evaluateTableClipSweep = fn38('evaluateTableClipSweep');
  assert.deepEqual(
    typesOf(evaluateTableClipSweep({ candidates: [sweepItem({ hidden: true })], page: sweepPage })),
    ['table-clip-unmeasured'],
  );
  const missing = evaluateTableClipSweep({
    candidates: [sweepItem()],
    declared: [{ selector: '[data-slot="opponent-table"]', found: false }],
    page: sweepPage,
  });
  assert.deepEqual(typesOf(missing), ['table-clip-unmeasured']);
  assert.equal(missing[0].selector, '[data-slot="opponent-table"]');
  const clipping = evaluateTableClipSweep({
    candidates: [],
    declared: [
      sweepItem({
        selector: '[data-slot="match-table"]',
        found: true,
        targetPath: 'table',
        clipId: 9,
        clipPath: 'div.overflow-x-auto',
        scrollWidth: 980,
      }),
    ],
    page: sweepPage,
  });
  assert.deepEqual(typesOf(clipping), ['table-clipped']);
});

test('table-clip: sweep — a page scrollWidth more than 1 px over innerWidth is one sweep-page-overflow', () => {
  const evaluateTableClipSweep = fn38('evaluateTableClipSweep');
  assert.deepEqual(
    typesOf(
      evaluateTableClipSweep({
        candidates: [sweepItem()],
        page: { scrollWidth: 392, innerWidth: 390 },
      }),
    ),
    ['sweep-page-overflow'],
  );
  assert.deepEqual(
    evaluateTableClipSweep({
      candidates: [sweepItem()],
      page: { scrollWidth: 391, innerWidth: 390 },
    }),
    [],
  );
});

test('table-clip: sweep — routed mode reports table-clip-routed in place of table-clipped and sweep-page-overflow, and keeps table-clip-unmeasured', () => {
  const evaluateTableClipSweep = fn38('evaluateTableClipSweep');
  const v = evaluateTableClipSweep(
    {
      candidates: [sweepItem({ scrollWidth: 600 })],
      declared: [{ selector: '#gone', found: false }],
      page: { scrollWidth: 500, innerWidth: 390 },
    },
    { mode: 'routed' },
  );
  assert.deepEqual(typesOf(v).sort(), [
    'table-clip-routed',
    'table-clip-routed',
    'table-clip-unmeasured',
  ]);
  assert.deepEqual(
    v
      .filter((x) => x.type === 'table-clip-routed')
      .map((x) => x.routedType)
      .sort(),
    ['sweep-page-overflow', 'table-clipped'],
  );
});

test('table-clip: sweep — TABLE_CLIP_SCAN_SELECTOR matches a [role="tablist"] element (OOS-5); a tablist whose own box scrolls 520 in 326 is one table-clipped violation', () => {
  const selector = ns38.TABLE_CLIP_SCAN_SELECTOR;
  assert.equal(typeof selector, 'string');
  const parts = selector.split(',').map((part) => part.trim());
  for (const want of [
    'table',
    '[role="table"]',
    '[role="grid"]',
    '[role="tablist"]',
    'ul',
    'ol',
    '[role="list"]',
  ]) {
    assert.ok(parts.includes(want), `scan selector includes ${want}`);
  }
  const evaluateTableClipSweep = fn38('evaluateTableClipSweep');
  const v = evaluateTableClipSweep({
    candidates: [
      sweepItem({
        targetPath: 'div[role=tablist]',
        kind: 'tablist',
        clipId: 7,
        clipPath: 'div[role=tablist]',
        scrollWidth: 520,
        clientWidth: 326,
      }),
    ],
    page: sweepPage,
  });
  assert.deepEqual(typesOf(v), ['table-clipped']);
  assert.equal(v[0].kind, 'tablist');
});

test('table-clip: mode — matchups and matchups-sketch-deep are routed; match-data, fighter-analysis, scout, stage-detail are enforced (the match prefix trap)', () => {
  const tableClipModeForRoute = fn38('tableClipModeForRoute');
  assert.equal(tableClipModeForRoute('matchups'), 'routed');
  assert.equal(tableClipModeForRoute('matchups-sketch-deep'), 'routed');
  for (const id of ['match-data', 'fighter-analysis', 'scout', 'stage-detail']) {
    assert.equal(tableClipModeForRoute(id), 'enforce', id);
  }
});

test('table-clip: routes — tableClipSweepRoutes keeps every route except ids ending in -fixture, in input order', () => {
  const tableClipSweepRoutes = fn38('tableClipSweepRoutes');
  const routes = [
    { id: 'stretched-card-fixture' },
    { id: 'dashboard' },
    { id: 'period-axis-ticks-fixture' },
    { id: 'scout' },
    { id: 'gsp' },
    { id: 'fixture-like-but-real' },
  ];
  assert.deepEqual(
    tableClipSweepRoutes(routes).map((r) => r.id),
    ['dashboard', 'scout', 'gsp', 'fixture-like-but-real'],
  );
});

function fakePreparePage({ failSelector = null } = {}) {
  const calls = [];
  return {
    calls,
    async waitForSelector(selector, options) {
      calls.push(['wait', selector, options?.timeout]);
      if (selector === failSelector) throw new Error('Waiting failed: timeout exceeded');
    },
    async type(selector, text) {
      calls.push(['type', selector, text]);
    },
    async click(selector) {
      calls.push(['click', selector]);
    },
  };
}

test('prepare: runRoutePrepare runs type / click / wait steps in order, each waiting for its selector first', async () => {
  const runRoutePrepare = fn38('runRoutePrepare');
  const page = fakePreparePage();
  await runRoutePrepare(
    page,
    [
      { type: 'type', selector: 'form input', text: 'guard-scout' },
      { type: 'click', selector: 'form button[type="submit"]' },
      { type: 'wait', selector: '[data-slot="scout-full-analysis"]' },
    ],
    { timeoutMs: 1234 },
  );
  assert.deepEqual(page.calls, [
    ['wait', 'form input', 1234],
    ['type', 'form input', 'guard-scout'],
    ['wait', 'form button[type="submit"]', 1234],
    ['click', 'form button[type="submit"]'],
    ['wait', '[data-slot="scout-full-analysis"]', 1234],
  ]);
});

test('prepare: an unknown step type throws naming it', async () => {
  const runRoutePrepare = fn38('runRoutePrepare');
  await assert.rejects(
    runRoutePrepare(fakePreparePage(), [{ type: 'hover', selector: 'a' }]),
    /unknown step type "hover"/,
  );
});

test('prepare: a failing wait rejects naming the step index and selector', async () => {
  const runRoutePrepare = fn38('runRoutePrepare');
  await assert.rejects(
    runRoutePrepare(fakePreparePage({ failSelector: '#late' }), [
      { type: 'wait', selector: '#ok' },
      { type: 'click', selector: '#late' },
    ]),
    (error) => /step 1/.test(error.message) && error.message.includes('#late'),
  );
});

test('prepare: an empty list is a no-op', async () => {
  const runRoutePrepare = fn38('runRoutePrepare');
  const page = fakePreparePage();
  await runRoutePrepare(page, []);
  await runRoutePrepare(page);
  assert.deepEqual(page.calls, []);
});

const fitItem = (overrides = {}) => ({
  selectorPath: 'span.name',
  hidden: false,
  left: 40,
  right: 300,
  cardInnerLeft: 17,
  cardInnerRight: 373,
  hasText: true,
  clips: false,
  scrollWidth: 80,
  clientWidth: 80,
  scrollHeight: 20,
  clientHeight: 20,
  lineClamped: false,
  titled: false,
  ...overrides,
});
const fitTarget = (items, overrides = {}) => ({
  selector: '[data-slot="stage-breakdown"]',
  found: true,
  scanned: items.length,
  left: 33,
  right: 357,
  items,
  ...overrides,
});

test('text-fit: escape — a descendant 2 px past its card inner right edge is one content-escape naming the target and the offender; 1 px passes', () => {
  const evaluateTextFit = fn38('evaluateTextFit');
  const v = evaluateTextFit({
    targets: [fitTarget([fitItem({ selectorPath: 'span.figure', right: 375 })])],
  });
  assert.deepEqual(typesOf(v), ['content-escape']);
  assert.equal(v[0].target, '[data-slot="stage-breakdown"]');
  assert.equal(v[0].selectorPath, 'span.figure');
  assert.deepEqual(evaluateTextFit({ targets: [fitTarget([fitItem({ right: 374 })])] }), []);
});

test('text-fit: escape — the left edge is symmetric; a descendant with no card ancestor is measured against the target box', () => {
  const evaluateTextFit = fn38('evaluateTextFit');
  assert.deepEqual(typesOf(evaluateTextFit({ targets: [fitTarget([fitItem({ left: 15 })])] })), [
    'content-escape',
  ]);
  assert.deepEqual(evaluateTextFit({ targets: [fitTarget([fitItem({ left: 16 })])] }), []);
  const noCard = fitItem({ cardInnerLeft: null, cardInnerRight: null, left: 40, right: 360 });
  assert.deepEqual(
    typesOf(evaluateTextFit({ targets: [fitTarget([noCard], { left: 33, right: 357 })] })),
    ['content-escape'],
  );
  assert.deepEqual(
    evaluateTextFit({ targets: [fitTarget([noCard], { left: 33, right: 359 })] }),
    [],
  );
});

test('text-fit: cut — overflow hidden with scrollWidth 120 / clientWidth 80 and no title is one text-cut; titled at 80 px passes', () => {
  const evaluateTextFit = fn38('evaluateTextFit');
  const cut = fitItem({ clips: true, scrollWidth: 120, clientWidth: 80 });
  assert.deepEqual(typesOf(evaluateTextFit({ targets: [fitTarget([cut])] })), ['text-cut']);
  assert.deepEqual(evaluateTextFit({ targets: [fitTarget([{ ...cut, titled: true }])] }), []);
});

test('text-fit: cut — a titled box starved to 16 px, or to 0 px at full height, is a text-cut (MIN_TRUNCATED_LABEL_PX 48)', () => {
  const evaluateTextFit = fn38('evaluateTextFit');
  assert.equal(ns38.MIN_TRUNCATED_LABEL_PX, 48);
  const starved = fitItem({ clips: true, titled: true, scrollWidth: 120, clientWidth: 16 });
  assert.deepEqual(typesOf(evaluateTextFit({ targets: [fitTarget([starved])] })), ['text-cut']);
  const zero = fitItem({
    clips: true,
    titled: true,
    scrollWidth: 64,
    clientWidth: 0,
    left: 60,
    right: 60,
    clientHeight: 20,
    scrollHeight: 20,
  });
  assert.deepEqual(typesOf(evaluateTextFit({ targets: [fitTarget([zero])] })), ['text-cut']);
});

test('text-fit: cut — a line-clamped box with scrollHeight 40 / clientHeight 20 is a text-cut; overflow visible never is; a hidden (sr-only) box is skipped', () => {
  const evaluateTextFit = fn38('evaluateTextFit');
  const clamped = fitItem({ clips: true, lineClamped: true, scrollHeight: 40, clientHeight: 20 });
  assert.deepEqual(typesOf(evaluateTextFit({ targets: [fitTarget([clamped])] })), ['text-cut']);
  const visible = fitItem({ clips: false, scrollWidth: 300, clientWidth: 80 });
  assert.deepEqual(evaluateTextFit({ targets: [fitTarget([visible])] }), []);
  const srOnly = fitItem({ hidden: true, clips: true, scrollWidth: 300, clientWidth: 1 });
  assert.deepEqual(evaluateTextFit({ targets: [fitTarget([srOnly, fitItem()])] }), []);
});

test('text-fit: presence — a declared target with found=false is one text-fit-unmeasured naming its selector; zero scanned descendants is text-fit-unmeasured', () => {
  const evaluateTextFit = fn38('evaluateTextFit');
  const missing = evaluateTextFit({
    targets: [{ selector: '[data-slot="gsp-hero"]', found: false, scanned: 0, items: [] }],
  });
  assert.deepEqual(typesOf(missing), ['text-fit-unmeasured']);
  assert.equal(missing[0].selector, '[data-slot="gsp-hero"]');
  assert.deepEqual(typesOf(evaluateTextFit({ targets: [fitTarget([], { scanned: 0 })] })), [
    'text-fit-unmeasured',
  ]);
});

test('text-fit: routes — fitTargetsForViewport returns only the targets declaring the viewport; a route without fitTargets returns []', () => {
  const fitTargetsForViewport = fn38('fitTargetsForViewport');
  const route = {
    id: 'match-data',
    fitTargets: [
      { selector: '#a', viewports: ['390x844', '1440x900'] },
      { selector: '#b', viewports: ['390x844'] },
    ],
  };
  assert.deepEqual(
    fitTargetsForViewport(route, '1440x900').map((t) => t.selector),
    ['#a'],
  );
  assert.deepEqual(
    fitTargetsForViewport(route, '390x844').map((t) => t.selector),
    ['#a', '#b'],
  );
  assert.deepEqual(fitTargetsForViewport({ id: 'trends' }, '390x844'), []);
});

test('text-fit: routes — fitViewportsOutsideRoute names the declared fit viewports the route loop never measures (scout 1440), in viewport order', () => {
  const fitViewportsOutsideRoute = fn38('fitViewportsOutsideRoute');
  const scout = {
    id: 'scout',
    viewports: ['390x844'],
    fitTargets: [{ selector: '#events', viewports: ['390x844', '1440x900'] }],
  };
  assert.deepEqual(fitViewportsOutsideRoute(scout, ['390x844']), ['1440x900']);
  assert.deepEqual(fitViewportsOutsideRoute(scout, ['2560x1440', '1440x900', '390x844']), []);
  assert.deepEqual(fitViewportsOutsideRoute({ id: 'trends' }, ['390x844']), []);
});

// ---------------------------------------------------------------------------
// Plan 39.1-40: rail-cards family.
// ---------------------------------------------------------------------------

function railOf(cards, fallback = 0, selectorPath = 'div[data-slot="trends-reads-rail"]') {
  return { selectorPath, cards, fallback, templates: [] };
}

test('rail-cards: one card against a minimum of 2 is exactly one rail-cards-below-min', () => {
  const evaluateRailCards = fn38('evaluateRailCards');
  const violations = evaluateRailCards([railOf(1)], { minCards: 2 });
  assert.deepEqual(typesOf(violations), ['rail-cards-below-min']);
  assert.equal(violations[0].cards, 1);
  assert.equal(violations[0].minCards, 2);
});

test('rail-cards: two cards against a minimum of 2 passes (boundary)', () => {
  const evaluateRailCards = fn38('evaluateRailCards');
  assert.deepEqual(evaluateRailCards([railOf(2)], { minCards: 2 }), []);
});

test('rail-cards: three cards with one fallback card is exactly one rail-fallback-card', () => {
  const evaluateRailCards = fn38('evaluateRailCards');
  const violations = evaluateRailCards([railOf(3, 1)], { minCards: 2 });
  assert.deepEqual(typesOf(violations), ['rail-fallback-card']);
  assert.equal(violations[0].fallback, 1);
});

test('rail-cards: two offending rails are both reported, never only the first', () => {
  const evaluateRailCards = fn38('evaluateRailCards');
  const violations = evaluateRailCards([railOf(1, 0, '#a'), railOf(0, 1, '#b')], { minCards: 2 });
  assert.deepEqual(
    violations.map((v) => `${v.selectorPath}:${v.type}`),
    ['#a:rail-cards-below-min', '#b:rail-cards-below-min', '#b:rail-fallback-card'],
  );
});

test('rail-cards: an empty rail list is exactly one rail-cards-unmeasured', () => {
  assert.deepEqual(typesOf(evaluateFamilyPresence('rail-cards', [])), ['rail-cards-unmeasured']);
});

// --- insight-line-dash (plan 39.1-50, OOS-40-A) ---

function dashLine({ dashTop, glyphTop, dashRight = 8, glyphLeft = 16 }) {
  return {
    selectorPath: '[data-slot="insight-line"]',
    text: 'Setting — no notable online/offline gap',
    dash: { left: dashRight - 8, right: dashRight, top: dashTop, bottom: dashTop + 2 },
    firstGlyph: { left: glyphLeft, right: glyphLeft + 8, top: glyphTop, bottom: glyphTop + 17 },
  };
}

test('insight-line-dash: a dash alone on the line above its text fails', () => {
  // The flex-wrap door case: the dash's 20px line box, the text starts on the next line.
  const violations = guardLayoutCoreNs.evaluateInsightLineDash?.([
    dashLine({ dashTop: 9, glyphTop: 21.5, dashRight: 8, glyphLeft: 0 }),
  ]);
  assert.equal(violations?.length, 1);
  assert.equal(violations[0].type, 'insight-line-dash-orphan');
});

test('insight-line-dash: a dash centred across a wrapped two-line text fails', () => {
  // items-center over a 40px text block: the dash sits between the lines.
  const violations = guardLayoutCoreNs.evaluateInsightLineDash?.([
    dashLine({ dashTop: 19, glyphTop: 1.5 }),
  ]);
  assert.equal(violations?.length, 1);
});

test('insight-line-dash: a dash on the first text line, before the text, passes', () => {
  const violations = guardLayoutCoreNs.evaluateInsightLineDash?.([
    dashLine({ dashTop: 9, glyphTop: 1.5 }),
  ]);
  assert.deepEqual(violations, []);
});

test('insight-line-dash: a dash after its first glyph fails even on the same line', () => {
  const violations = guardLayoutCoreNs.evaluateInsightLineDash?.([
    dashLine({ dashTop: 9, glyphTop: 1.5, dashRight: 40, glyphLeft: 16 }),
  ]);
  assert.equal(violations?.length, 1);
  assert.equal(violations[0].precedes, false);
});

test('insight-line-dash: no measured line is exactly one insight-line-dash-unmeasured', () => {
  assert.deepEqual(evaluateFamilyPresence('insight-line-dash', []), [
    { type: 'insight-line-dash-unmeasured' },
  ]);
});

// ---------------------------------------------------------------------------
// Plan 39.1-51 (OOS-8): the last-row-visible family and the §6.3 terminus
// allowance. Read through the namespace so a RED run fails on an assertion.
// ---------------------------------------------------------------------------

function terminusList(overrides = {}) {
  return {
    selectorPath: 'div[data-slot="filtered-match-list"]',
    layout: 'table',
    mounted: 100,
    total: 300,
    contentPx: 3200,
    lastRow: { top: 3160, bottom: 3200 },
    clips: [],
    ...overrides,
  };
}

test('last-row-visible: a table last row 3 px below a clipping ancestor is one last-row-clipped naming the ancestor', () => {
  const violations = guardLayoutCoreNs.evaluateLastRowVisible([
    terminusList({
      lastRow: { top: 463, bottom: 503 },
      clips: [
        {
          selectorPath: 'div.clipper',
          overflowY: 'hidden',
          scrollHeight: 500,
          clientHeight: 500,
          visTop: 0,
          visBottom: 500,
        },
      ],
    }),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'last-row-clipped');
  assert.equal(violations[0].clipper, 'div.clipper');
});

test('last-row-visible: a last row 1 px past the visible bottom passes', () => {
  const violations = guardLayoutCoreNs.evaluateLastRowVisible([
    terminusList({
      lastRow: { top: 461, bottom: 501 },
      clips: [
        {
          selectorPath: 'div.clipper',
          overflowY: 'hidden',
          scrollHeight: 500,
          clientHeight: 500,
          visTop: 0,
          visBottom: 500,
        },
      ],
    }),
  ]);
  assert.deepEqual(violations, []);
});

test('last-row-visible: an overflow-y auto ancestor with scrollHeight 3200 over clientHeight 500 is one terminus-inner-scroller', () => {
  const violations = guardLayoutCoreNs.evaluateLastRowVisible([
    terminusList({
      lastRow: { top: 440, bottom: 480 },
      clips: [
        {
          selectorPath: 'div.scroller',
          overflowY: 'auto',
          scrollHeight: 3200,
          clientHeight: 500,
          visTop: 0,
          visBottom: 500,
        },
      ],
    }),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'terminus-inner-scroller');
  assert.equal(violations[0].scroller, 'div.scroller');
});

test('last-row-visible: a horizontal-only container (overflow-y auto, scrollHeight equal to clientHeight, the row inside) passes', () => {
  const violations = guardLayoutCoreNs.evaluateLastRowVisible([
    terminusList({
      clips: [
        {
          selectorPath: 'div[data-slot="table-container"]',
          overflowY: 'auto',
          scrollHeight: 3200,
          clientHeight: 3200,
          visTop: 0,
          visBottom: 3200,
        },
      ],
    }),
  ]);
  assert.deepEqual(violations, []);
});

test('last-row-visible: a stack list with no clipping ancestor passes', () => {
  const violations = guardLayoutCoreNs.evaluateLastRowVisible([
    terminusList({
      layout: 'stack',
      mounted: 20,
      contentPx: 1800,
      lastRow: { top: 1718, bottom: 1800 },
    }),
  ]);
  assert.deepEqual(violations, []);
});

test('last-row-visible: mounted 101 in table layout or 21 in stack layout is terminus-unbounded; 100 / 20 pass', () => {
  const table101 = guardLayoutCoreNs.evaluateLastRowVisible([terminusList({ mounted: 101 })]);
  assert.deepEqual(
    table101.map((v) => v.type),
    ['terminus-unbounded'],
  );
  const stack21 = guardLayoutCoreNs.evaluateLastRowVisible([
    terminusList({ layout: 'stack', mounted: 21 }),
  ]);
  assert.deepEqual(
    stack21.map((v) => v.type),
    ['terminus-unbounded'],
  );
  assert.deepEqual(guardLayoutCoreNs.evaluateLastRowVisible([terminusList({ mounted: 100 })]), []);
  assert.deepEqual(
    guardLayoutCoreNs.evaluateLastRowVisible([terminusList({ layout: 'stack', mounted: 20 })]),
    [],
  );
});

test('last-row-visible: 0 mounted rows or no measurable last row is last-row-visible-unmeasured', () => {
  assert.deepEqual(
    guardLayoutCoreNs
      .evaluateLastRowVisible([terminusList({ layout: 'empty', mounted: 0, lastRow: null })])
      .map((v) => v.type),
    ['last-row-visible-unmeasured'],
  );
  assert.deepEqual(
    guardLayoutCoreNs
      .evaluateLastRowVisible([terminusList({ mounted: 5, lastRow: null })])
      .map((v) => v.type),
    ['last-row-visible-unmeasured'],
  );
});

test('last-row-visible: no list root at all is exactly one last-row-visible-unmeasured (evaluateFamilyPresence)', () => {
  assert.deepEqual(guardLayoutCoreNs.evaluateFamilyPresence('last-row-visible', []), [
    { type: 'last-row-visible-unmeasured' },
  ]);
  assert.deepEqual(guardLayoutCoreNs.evaluateLastRowVisible([]), []);
});

test('terminus-budget: terminusBudgetExcessPx counts only the part of each table flow above 500 px', () => {
  assert.equal(guardLayoutCoreNs.TERMINUS_TABLE_ALLOWANCE_PX, 500);
  assert.equal(guardLayoutCoreNs.TERMINUS_TABLE_ROW_CAP, 100);
  assert.equal(guardLayoutCoreNs.TERMINUS_STACK_ROW_CAP, 20);
  assert.equal(guardLayoutCoreNs.terminusBudgetExcessPx([3200]), 2700);
  assert.equal(guardLayoutCoreNs.terminusBudgetExcessPx([480]), 0);
  assert.equal(guardLayoutCoreNs.terminusBudgetExcessPx([500]), 0);
  assert.equal(guardLayoutCoreNs.terminusBudgetExcessPx([3200, 900]), 3100);
  assert.equal(guardLayoutCoreNs.terminusBudgetExcessPx([]), 0);
});

test('terminus-budget: a 5500 px page with one 3200 px table flow passes 1440x900 with the allowance (2800 / 900) and fails without it (6.11 over 5)', () => {
  const page = { scrollHeight: 5500, innerHeight: 900, viewportName: '1440x900' };
  const excess = guardLayoutCoreNs.terminusBudgetExcessPx([3200]);
  assert.deepEqual(
    guardLayoutCoreNs.evaluateScrollBudget({ ...page, scrollHeight: page.scrollHeight - excess }),
    [],
  );
  const without = guardLayoutCoreNs.evaluateScrollBudget(page);
  assert.equal(without.length, 1);
  assert.equal(without[0].type, 'scroll-budget');
  assert.equal(Math.round(without[0].ratio * 100) / 100, 6.11);
  assert.equal(without[0].budget, 5);
});

// ---------------------------------------------------------------------------
// Plan 39.1-41: period-trend-marks (sketch 003 A — quarterly, tier dots, one
// data line, labels on the last / max / min joined quarters, fitted domain,
// "NN% all time"). The expected values are sketch 003's own derivation for
// the deep pairing (brief section 4), never re-derived here.
// ---------------------------------------------------------------------------

const DEEP_EXPECT = {
  state: 'drawn',
  yDomain: [20, 100],
  dotDiameters: [5, 7],
  valueLabels: ['100%', '33%', '60%'],
  referenceLabel: '63% all time',
};

function deepSurface(overrides = {}) {
  return {
    selectorPath: 'div[data-slot="trend-line-period"]',
    state: 'drawn',
    yDomain: [20, 100],
    dots: [
      { key: 'quarter:2021-Q1', diameter: 5, subFloor: true },
      { key: 'quarter:2023-Q1', diameter: 7, subFloor: false },
      { key: 'quarter:2024-Q1', diameter: 5, subFloor: false },
      { key: 'quarter:2024-Q2', diameter: 5, subFloor: false },
      { key: 'quarter:2026-Q1', diameter: 5, subFloor: false },
    ],
    valueLabels: [
      { key: 'quarter:2024-Q1', text: '100%' },
      { key: 'quarter:2024-Q2', text: '33%' },
      { key: 'quarter:2026-Q1', text: '60%' },
    ],
    strokedLineCount: 1,
    yTickTexts: ['20', '40', '60', '80', '100'],
    referenceLabel: '63% all time',
    ...overrides,
  };
}

function periodTrendTypes(surfaces, expect = DEEP_EXPECT) {
  return guardLayoutCoreNs.evaluatePeriodTrendMarks(surfaces, expect).map((v) => v.type);
}

test('period-trend-marks: the exact expected deep surface passes', () => {
  assert.deepEqual(periodTrendTypes([deepSurface()]), []);
});

test('period-trend-marks: no surface is exactly one period-trend-unmeasured', () => {
  assert.deepEqual(periodTrendTypes([]), ['period-trend-unmeasured']);
});

test('period-trend-marks: a locked surface expecting locked passes; a drawn one expecting locked fails', () => {
  const locked = {
    selectorPath: 'x',
    state: 'locked',
    dots: [],
    valueLabels: [],
    strokedLineCount: 0,
  };
  assert.deepEqual(periodTrendTypes([locked], { state: 'locked' }), []);
  assert.deepEqual(periodTrendTypes([deepSurface()], { state: 'locked' }), ['period-trend-state']);
  assert.deepEqual(periodTrendTypes([locked]), ['period-trend-state']);
});

test('period-trend-marks: two stroked lines (a context step series) is period-trend-context-series', () => {
  assert.deepEqual(periodTrendTypes([deepSurface({ strokedLineCount: 2 })]), [
    'period-trend-context-series',
  ]);
  assert.deepEqual(periodTrendTypes([deepSurface({ strokedLineCount: 0 })]), [
    'period-trend-context-series',
  ]);
});

test('period-trend-marks: a value label on a sub-floor dot is period-trend-subfloor-label', () => {
  const surface = deepSurface({
    valueLabels: [
      { key: 'quarter:2021-Q1', text: '100%' },
      { key: 'quarter:2024-Q2', text: '33%' },
      { key: 'quarter:2026-Q1', text: '60%' },
    ],
  });
  assert.deepEqual(periodTrendTypes([surface]), ['period-trend-subfloor-label']);
});

test('period-trend-marks: four value labels is period-trend-label-count (and the set differs)', () => {
  const surface = deepSurface({
    valueLabels: [...deepSurface().valueLabels, { key: 'quarter:2023-Q1', text: '63%' }],
  });
  assert.deepEqual(periodTrendTypes([surface]), [
    'period-trend-label-count',
    'period-trend-labels',
  ]);
});

test('period-trend-marks: label texts that differ from the expected set are period-trend-labels', () => {
  const surface = deepSurface({
    valueLabels: [
      { key: 'quarter:2024-Q1', text: '100%' },
      { key: 'quarter:2024-Q2', text: '0%' },
      { key: 'quarter:2026-Q1', text: '60%' },
    ],
  });
  assert.deepEqual(periodTrendTypes([surface]), ['period-trend-labels']);
});

test('period-trend-marks: distinct diameters other than the expected set, or outside {5,7,9}, are period-trend-dot-size', () => {
  const allFive = deepSurface({ dots: deepSurface().dots.map((d) => ({ ...d, diameter: 5 })) });
  assert.deepEqual(periodTrendTypes([allFive]), ['period-trend-dot-size']);
  const radiiAsDiameters = deepSurface({
    dots: deepSurface().dots.map((d) => ({ ...d, diameter: d.diameter * 2 })),
  });
  assert.deepEqual(periodTrendTypes([radiiAsDiameters]), ['period-trend-dot-size']);
  assert.deepEqual(
    periodTrendTypes([radiiAsDiameters], { state: 'drawn' }),
    ['period-trend-dot-size'],
    'outside {5,7,9} fails even without an expected set',
  );
});

test('period-trend-marks: a declared domain other than the expected one is period-trend-domain', () => {
  assert.deepEqual(
    periodTrendTypes([deepSurface({ yDomain: [0, 100], yTickTexts: ['0', '50', '100'] })]),
    ['period-trend-domain'],
  );
  assert.deepEqual(periodTrendTypes([deepSurface({ yDomain: null, yTickTexts: [] })]), [
    'period-trend-domain',
  ]);
});

test('period-trend-marks: a reference label other than the expected text is period-trend-reference-label', () => {
  assert.deepEqual(periodTrendTypes([deepSurface({ referenceLabel: '63%' })]), [
    'period-trend-reference-label',
  ]);
  assert.deepEqual(periodTrendTypes([deepSurface({ referenceLabel: null })]), [
    'period-trend-reference-label',
  ]);
});

test('period-trend-marks: a tick outside the domain, 0 while lo > 0 or 100 while hi < 100 is period-trend-axis-edge', () => {
  assert.deepEqual(periodTrendTypes([deepSurface({ yTickTexts: ['10', '20', '100'] })]), [
    'period-trend-axis-edge',
  ]);
  const fitted = { state: 'drawn' };
  assert.deepEqual(
    periodTrendTypes([deepSurface({ yDomain: [40, 70], yTickTexts: ['0', '40', '70'] })], fitted),
    ['period-trend-axis-edge'],
  );
  assert.deepEqual(
    periodTrendTypes([deepSurface({ yDomain: [40, 70], yTickTexts: ['40', '70', '100'] })], fitted),
    ['period-trend-axis-edge'],
  );
  assert.deepEqual(
    periodTrendTypes([deepSurface({ yDomain: [0, 100], yTickTexts: ['0', '50', '100'] })], fitted),
    [],
  );
});

// REWRITTEN by plan 39.1-43 (was: the line ended at `ref=`): the line now
// appends ` range=<rounded px>` (the measured value range, PD-43-3), `none`
// when the surface carries no measurable hairlines.
test('period-trend-marks: the PERIOD_TREND line prints state, domain, sorted distinct dots, labels, lines, ref and range', () => {
  assert.equal(
    guardLayoutCoreNs.formatPeriodTrendLine('matchups-sketch-deep', '1440x900', deepSurface()),
    'PERIOD_TREND route=matchups-sketch-deep viewport=1440x900 state=drawn domain=20,100 dots=5,7 labels=100%|33%|60% lines=1 ref=63%_all_time range=none',
  );
  assert.equal(
    guardLayoutCoreNs.formatPeriodTrendLine(
      'fighter-analysis',
      '390x844',
      deepSurface({ valueRangePx: 159.6 }),
    ),
    'PERIOD_TREND route=fighter-analysis viewport=390x844 state=drawn domain=20,100 dots=5,7 labels=100%|33%|60% lines=1 ref=63%_all_time range=160',
  );
  assert.equal(
    guardLayoutCoreNs.formatPeriodTrendLine('matchups-sketch-thin', '390x844', {
      state: 'locked',
      yDomain: null,
      dots: [],
      valueLabels: [],
      strokedLineCount: 0,
      referenceLabel: null,
    }),
    'PERIOD_TREND route=matchups-sketch-thin viewport=390x844 state=locked domain=none dots=none labels=none lines=0 ref=none range=none',
  );
});

// ---------------------------------------------------------------------------
// Plan 39.1-42 (sketch 003 `formStrip` / `fitStrips`, UI-SPEC §7.10 as amended
// 2026-09-25): the form-strip-labels family. One strip per
// `[data-slot="form-strip-root"]`: its `data-event-count`, and per shown
// `[data-slot="form-strip-event"]` its `data-event-order` plus the
// `[data-slot="form-strip-event-label"]` text and rect. Every case reads the
// module through the namespace so a missing export fails that case alone.
// ---------------------------------------------------------------------------

/** Sketch 003 at 390: three newest events, 76px minimum columns, 12px gaps. */
function sketchStrip(overrides = {}) {
  const column = (left, order, text) => ({
    order,
    labelText: text,
    labelRect: { left, right: left + 76, top: 400, bottom: 416, width: 76, height: 16 },
  });
  return {
    selectorPath: 'div[data-slot="form-strip-root"]',
    eventCount: 20,
    gameCount: 102,
    shownGames: 9,
    rootWidth: 326,
    events: [
      column(0, 17, 'Genesis 9 3–0'),
      column(88, 18, 'Battle of BC 8 0–2'),
      column(176, 19, 'Sessions · Jul 3 – Sep 20, 2026 2–2'),
    ],
    ...overrides,
  };
}

function formStripLabelTypes(strips) {
  return guardLayoutCoreNs.evaluateFormStripLabels(strips).map((v) => v.type);
}

test('form-strip-labels: the minimum label box is 72px', () => {
  assert.equal(guardLayoutCoreNs.FORM_STRIP_LABEL_MIN_WIDTH_PX, 72);
});

test('form-strip-labels: a sketch-shaped strip (three labelled newest events at 390 widths) passes', () => {
  assert.deepEqual(formStripLabelTypes([sketchStrip()]), []);
});

test('form-strip-labels: an opted route with no strip is exactly form-strip-labels-unmeasured', () => {
  assert.deepEqual(formStripLabelTypes([]), ['form-strip-labels-unmeasured']);
});

test('form-strip-labels: an event without label text, or whose label has no W–L token, is form-strip-label-missing', () => {
  const base = sketchStrip();
  const noText = { ...base.events[0], labelText: null, labelRect: null };
  const noRecord = { ...base.events[1], labelText: 'Battle of BC 8' };
  assert.deepEqual(
    formStripLabelTypes([sketchStrip({ events: [noText, noRecord, base.events[2]] })]),
    ['form-strip-label-missing', 'form-strip-label-missing'],
  );
});

test('form-strip-labels: a shipped caption-only root (no data-event-count, no label nodes) reports label-missing per event, never not-newest or unmeasured', () => {
  const legacy = {
    selectorPath: 'div[data-slot="form-strip-root"]',
    eventCount: null,
    gameCount: null,
    shownGames: 30,
    rootWidth: 900,
    events: [
      { order: null, labelText: null, labelRect: null },
      { order: null, labelText: null, labelRect: null },
    ],
  };
  assert.deepEqual(formStripLabelTypes([legacy]), [
    'form-strip-label-missing',
    'form-strip-label-missing',
  ]);
});

test('form-strip-labels: two intersecting label rects are form-strip-label-overlap', () => {
  const base = sketchStrip();
  const shifted = {
    ...base.events[1],
    labelRect: { left: 60, right: 136, top: 400, bottom: 416, width: 76, height: 16 },
  };
  assert.deepEqual(
    formStripLabelTypes([sketchStrip({ events: [base.events[0], shifted, base.events[2]] })]),
    ['form-strip-label-overlap'],
  );
});

test('form-strip-labels: shown orders that are not the contiguous run ending at data-event-count - 1 are form-strip-not-newest', () => {
  const base = sketchStrip();
  const gap = [base.events[0], { ...base.events[1], order: 16 }, base.events[2]];
  assert.deepEqual(formStripLabelTypes([sketchStrip({ events: gap })]), ['form-strip-not-newest']);
  assert.deepEqual(formStripLabelTypes([sketchStrip({ eventCount: 21 })]), [
    'form-strip-not-newest',
  ]);
  const missingOrder = [base.events[0], base.events[1], { ...base.events[2], order: null }];
  assert.deepEqual(formStripLabelTypes([sketchStrip({ events: missingOrder })]), [
    'form-strip-not-newest',
  ]);
});

test('form-strip-labels: a label box narrower than 72px is form-strip-label-squeezed; exactly 72px passes', () => {
  const base = sketchStrip();
  const squeezed = {
    ...base.events[2],
    labelRect: { left: 176, right: 247.5, top: 400, bottom: 416, width: 71.5, height: 16 },
  };
  assert.deepEqual(
    formStripLabelTypes([sketchStrip({ events: [base.events[0], base.events[1], squeezed] })]),
    ['form-strip-label-squeezed'],
  );
  const exact = {
    ...base.events[2],
    labelRect: { left: 176, right: 248, top: 400, bottom: 416, width: 72, height: 16 },
  };
  assert.deepEqual(
    formStripLabelTypes([sketchStrip({ events: [base.events[0], base.events[1], exact] })]),
    [],
  );
});

test('form-strip-labels: the FORM_STRIP line prints shown/count events, shown/total games and the labels', () => {
  assert.equal(
    guardLayoutCoreNs.formatFormStripLine('matchups-sketch-deep', '390x844', sketchStrip()),
    'FORM_STRIP route=matchups-sketch-deep viewport=390x844 events=3/20 games=9/102 labels=Genesis 9 3–0|Battle of BC 8 0–2|Sessions · Jul 3 – Sep 20, 2026 2–2 width=326',
  );
  assert.equal(
    guardLayoutCoreNs.formatFormStripLine('matchups', '1440x900', {
      eventCount: null,
      gameCount: null,
      shownGames: 30,
      rootWidth: 900,
      events: [{ order: null, labelText: null, labelRect: null }],
    }),
    'FORM_STRIP route=matchups viewport=1440x900 events=1/unknown games=30/unknown labels=none width=900',
  );
});

// ---------------------------------------------------------------------------
// Plan 39.1-43 (PD-43-3, sketch 001-C / 003 `trend()`: the 160px trend box is
// the VALUE range): every periodTrendExpect field is optional, and
// `valueRangePx: [min, max]` bounds the measured hairline span.
// ---------------------------------------------------------------------------

test('period-trend-marks: value range — a measured 160px span inside [158, 162] passes', () => {
  assert.deepEqual(
    periodTrendTypes([deepSurface({ valueRangePx: 160 })], { valueRangePx: [158, 162] }),
    [],
  );
});

test('period-trend-marks: value range — the shipped 80px compact span is one period-trend-value-range', () => {
  const violations = guardLayoutCoreNs.evaluatePeriodTrendMarks(
    [deepSurface({ valueRangePx: 80 })],
    {
      state: 'drawn',
      valueRangePx: [158, 162],
    },
  );
  assert.deepEqual(
    violations.map((v) => v.type),
    ['period-trend-value-range'],
  );
  assert.equal(violations[0].valueRangePx, 80);
  assert.deepEqual(violations[0].expected, [158, 162]);
});

test('period-trend-marks: value range — a drawn surface with no measurable hairlines is period-trend-value-range-unmeasured', () => {
  assert.deepEqual(
    periodTrendTypes([deepSurface({ valueRangePx: null })], { valueRangePx: [158, 162] }),
    ['period-trend-value-range-unmeasured'],
  );
  assert.deepEqual(periodTrendTypes([deepSurface()], { valueRangePx: [158, 162] }), [
    'period-trend-value-range-unmeasured',
  ]);
});

test('period-trend-marks: value range — a locked surface is never measured for its range; no expectation, no check', () => {
  const locked = {
    selectorPath: 'x',
    state: 'locked',
    dots: [],
    valueLabels: [],
    strokedLineCount: 0,
  };
  assert.deepEqual(periodTrendTypes([locked], { state: 'locked', valueRangePx: [158, 162] }), []);
  assert.deepEqual(periodTrendTypes([deepSurface({ valueRangePx: 80 })], { state: 'drawn' }), []);
});

test('period-trend-marks: every expectation field is optional — an empty expectation checks only the kit invariants', () => {
  assert.deepEqual(periodTrendTypes([deepSurface()], {}), []);
  assert.deepEqual(periodTrendTypes([deepSurface({ strokedLineCount: 2 })], {}), [
    'period-trend-context-series',
  ]);
});

// ---------------------------------------------------------------------------
// Plan 39.1-43 (OOS-6, 39.1-39 whole-page review): the all-time reference
// label must clear every drawn period dot — its box plus sketch 001-C's 2px
// `.pt` surface halo — not only the value labels.
// ---------------------------------------------------------------------------

test('axis-ticks: reference-label-dot-collision — a reference label meeting a dot expanded by the 2px halo is one violation naming the label and the dot', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      referenceLabels: [{ left: 560, right: 640, top: 100, bottom: 116, text: '48% all time' }],
      // The dot's own box ends 1px above the label; its 2px halo reaches into it.
      dots: [
        {
          selectorPath: '#dot-last',
          key: 'week:2026-W30',
          left: 600,
          right: 605,
          top: 94,
          bottom: 99,
        },
      ],
    }),
  ]);
  const hits = violations.filter((v) => v.type === 'reference-label-dot-collision');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reference, '48% all time');
  assert.equal(hits[0].dot, '#dot-last');
  assert.equal(hits[0].key, 'week:2026-W30');
});

test('axis-ticks: reference-label-dot-collision — a 2.5px gap between the label and the dot passes', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      referenceLabels: [{ left: 560, right: 640, top: 100, bottom: 116, text: '48% all time' }],
      dots: [{ selectorPath: '#dot', left: 600, right: 605, top: 92.5, bottom: 97.5 }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'reference-label-dot-collision').length, 0);
});

test('axis-ticks: reference-label-dot-collision — a hollow sub-floor dot counts, and every overlapping pair is reported', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      referenceLabels: [{ left: 560, right: 640, top: 100, bottom: 116, text: '48% all time' }],
      dots: [
        { selectorPath: '#hollow', subFloor: true, left: 570, right: 575, top: 104, bottom: 109 },
        { selectorPath: '#filled', left: 620, right: 627, top: 110, bottom: 117 },
        { selectorPath: '#clear', left: 300, right: 305, top: 104, bottom: 109 },
      ],
    }),
  ]);
  const hits = violations.filter((v) => v.type === 'reference-label-dot-collision');
  assert.deepEqual(
    hits.map((v) => v.dot),
    ['#hollow', '#filled'],
  );
});

test('axis-ticks: reference-label-dot-collision — a surface with dots and no reference label is not a violation', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      dots: [{ selectorPath: '#dot', left: 600, right: 605, top: 100, bottom: 105 }],
    }),
  ]);
  assert.equal(violations.filter((v) => v.type === 'reference-label-dot-collision').length, 0);
});

test('axis-ticks: reference-label-dot-collision — the value-label reference-label-collision check is kept beside it', () => {
  const violations = evaluateAxisTicks([
    makeSurface({
      valueLabels: [{ left: 600, right: 621, top: 100, bottom: 112, text: '52%' }],
      referenceLabels: [{ left: 560, right: 640, top: 104, bottom: 120, text: '48% all time' }],
      dots: [{ selectorPath: '#dot', left: 610, right: 615, top: 112, bottom: 117 }],
    }),
  ]);
  const types = violations.map((v) => v.type).sort();
  assert.deepEqual(types, ['reference-label-collision', 'reference-label-dot-collision']);
});

// Plan 39.1-43 (OOS-6 fallback, UI-SPEC 7.13 as amended): when every label
// slot is taken the kit draws no direct reference label and its head's
// reference legend item states the rate — the collector then reports the
// legend item's text with source 'legend', and the PERIOD_TREND line marks it.
test('period-trend-marks: a legend-sourced reference label (OOS-6 fallback) prints as ref=legend:<text> and still meets the expected text', () => {
  const surface = deepSurface({ referenceLabelSource: 'legend', valueRangePx: 160 });
  assert.equal(
    guardLayoutCoreNs.formatPeriodTrendLine('matchups-sketch-deep', '390x844', surface),
    'PERIOD_TREND route=matchups-sketch-deep viewport=390x844 state=drawn domain=20,100 dots=5,7 labels=100%|33%|60% lines=1 ref=legend:63%_all_time range=160',
  );
  assert.deepEqual(periodTrendTypes([surface]), []);
  assert.deepEqual(
    periodTrendTypes([
      deepSurface({ referenceLabelSource: 'legend', referenceLabel: '62% all time' }),
    ]),
    ['period-trend-reference-label'],
  );
});

// ---------------------------------------------------------------------------
// Plan 39.1-43b (fidelity follow-up): period-trend-axis — the period trend's
// axis against sketch 003 A / 001-C's `trend()` CSS: 10px muted ticks on the
// sketch's 20-step (span > 50) grid, 10px x labels, 10px / 600 foreground
// value labels, a 26px gutter with a 6px tick gap, horizontal hairlines only.
// ---------------------------------------------------------------------------

const SKETCH_AXIS_EXPECT = {
  tickValues: [20, 40, 60, 80, 100],
  tickFontPx: 10,
  tickColorToken: 'muted-foreground',
  xFontPx: 10,
  xColorToken: 'muted-foreground',
  valueLabelFontPx: 10,
  valueLabelWeight: 600,
  valueLabelColorToken: 'foreground',
  referenceLabelFontPx: 10,
  gutterPx: 26,
  tickGapPx: 6,
  verticalGridLines: 0,
  axisLines: 0,
  strayHairlines: 0,
};

function sketchAxisSurface(axisOverrides = {}, overrides = {}) {
  return {
    selectorPath: 'div > div',
    state: 'drawn',
    axis: {
      yTickValues: [20, 40, 60, 80, 100],
      yTickFontPx: [10, 10, 10, 10, 10],
      yTickColorTokens: ['muted-foreground'],
      xTickFontPx: [10, 10],
      xTickColorTokens: ['muted-foreground'],
      valueLabelFontPx: [10, 10, 10],
      valueLabelWeights: [600, 600, 600],
      valueLabelColorTokens: ['foreground'],
      referenceLabelFontPx: [10],
      gutterPx: 26,
      tickGapPx: 6,
      verticalGridLines: 0,
      axisLines: 0,
      strayHairlines: 0,
      ...axisOverrides,
    },
    ...overrides,
  };
}

/** The shipped 39.1-43 axis (dbc886ab): 10-step ticks, 12px everywhere, a 65px gutter. */
function shippedAxisSurface() {
  return sketchAxisSurface({
    yTickValues: [20, 30, 40, 50, 60, 70, 80, 90, 100],
    yTickFontPx: [12],
    xTickFontPx: [12],
    valueLabelFontPx: [12],
    valueLabelColorTokens: ['muted-foreground'],
    referenceLabelFontPx: [12],
    gutterPx: 65,
    tickGapPx: 8,
    verticalGridLines: 8,
    axisLines: 4,
    strayHairlines: 2,
  });
}

function axisTypes(surfaces, expect = SKETCH_AXIS_EXPECT) {
  const fn = guardLayoutCoreNs.evaluatePeriodTrendAxis;
  assert.equal(typeof fn, 'function', 'evaluatePeriodTrendAxis is exported');
  return fn(surfaces, expect).map((v) => v.type);
}

test('period-trend-axis: a surface drawn exactly to the sketch CSS passes', () => {
  assert.deepEqual(axisTypes([sketchAxisSurface()]), []);
});

test('period-trend-axis: the shipped 39.1-43 axis fails every sketch rule it breaks', () => {
  assert.deepEqual(axisTypes([shippedAxisSurface()]).sort(), [
    'period-trend-axis-axis-line',
    'period-trend-axis-gutter',
    'period-trend-axis-reference-label-font',
    'period-trend-axis-stray-hairline',
    'period-trend-axis-tick-font',
    'period-trend-axis-tick-gap',
    'period-trend-axis-ticks',
    'period-trend-axis-value-label-color',
    'period-trend-axis-value-label-font',
    'period-trend-axis-vertical-grid',
    'period-trend-axis-x-font',
  ]);
});

test('period-trend-axis: each rule fails alone (one proven failing case per assertion)', () => {
  const cases = [
    [{ yTickValues: [20, 30, 40, 50, 60, 70, 80, 90, 100] }, 'period-trend-axis-ticks'],
    [{ yTickValues: [20, 40, 60, 80] }, 'period-trend-axis-ticks'],
    [{ yTickFontPx: [12] }, 'period-trend-axis-tick-font'],
    [{ yTickFontPx: [10, 12] }, 'period-trend-axis-tick-font'],
    [{ yTickColorTokens: ['foreground'] }, 'period-trend-axis-tick-color'],
    [{ xTickFontPx: [12] }, 'period-trend-axis-x-font'],
    [{ xTickColorTokens: ['oklch(1 0 0)'] }, 'period-trend-axis-x-color'],
    [{ valueLabelFontPx: [12] }, 'period-trend-axis-value-label-font'],
    [{ valueLabelWeights: [700] }, 'period-trend-axis-value-label-weight'],
    [{ valueLabelColorTokens: ['muted-foreground'] }, 'period-trend-axis-value-label-color'],
    [{ referenceLabelFontPx: [12] }, 'period-trend-axis-reference-label-font'],
    [{ gutterPx: 65 }, 'period-trend-axis-gutter'],
    [{ gutterPx: 27.5 }, 'period-trend-axis-gutter'],
    [{ tickGapPx: 8 }, 'period-trend-axis-tick-gap'],
    [{ verticalGridLines: 1 }, 'period-trend-axis-vertical-grid'],
    [{ axisLines: 1 }, 'period-trend-axis-axis-line'],
    [{ strayHairlines: 1 }, 'period-trend-axis-stray-hairline'],
  ];
  for (const [override, type] of cases) {
    assert.deepEqual(axisTypes([sketchAxisSurface(override)]), [type], JSON.stringify(override));
  }
  // Inside the 1px tolerance passes.
  assert.deepEqual(axisTypes([sketchAxisSurface({ gutterPx: 26.8, tickGapPx: 5.2 })]), []);
});

test('period-trend-axis: non-vacuity — no drawn surface, no axis record, or missing elements are unmeasured', () => {
  assert.deepEqual(axisTypes([]), ['period-trend-axis-unmeasured']);
  assert.deepEqual(axisTypes([{ selectorPath: 'x', state: 'locked' }]), [
    'period-trend-axis-unmeasured',
  ]);
  assert.deepEqual(axisTypes([{ selectorPath: 'x', state: 'drawn' }]), [
    'period-trend-axis-unmeasured',
  ]);
  const fn = guardLayoutCoreNs.evaluatePeriodTrendAxis;
  const missing = fn(
    [
      sketchAxisSurface({
        yTickValues: [],
        yTickFontPx: [],
        valueLabelFontPx: [],
        gutterPx: null,
      }),
    ],
    SKETCH_AXIS_EXPECT,
  );
  assert.deepEqual(
    missing.map((v) => `${v.type}:${v.field}`),
    [
      'period-trend-axis-unmeasured:ticks',
      'period-trend-axis-unmeasured:tickFont',
      'period-trend-axis-unmeasured:valueLabelFont',
      'period-trend-axis-unmeasured:gutter',
    ],
  );
});

test('period-trend-axis: a locked surface beside a drawn one is skipped; the OOS-6 fallback (no direct reference label) skips only the reference font', () => {
  assert.deepEqual(axisTypes([{ selectorPath: 'x', state: 'locked' }, sketchAxisSurface()]), []);
  assert.deepEqual(axisTypes([sketchAxisSurface({ referenceLabelFontPx: [] })]), []);
});

test('period-trend-axis: every expectation field is optional', () => {
  assert.deepEqual(axisTypes([shippedAxisSurface()], {}), []);
});

test('period-trend-axis: sketchPeriodTickValues is sketch 003 `trend()` — step 20 over a span above 50, else 10', () => {
  const fn = guardLayoutCoreNs.sketchPeriodTickValues;
  assert.equal(typeof fn, 'function');
  assert.deepEqual(fn([20, 100]), [20, 40, 60, 80, 100]);
  assert.deepEqual(fn([20, 90]), [20, 40, 60, 80]);
  assert.deepEqual(fn([50, 90]), [50, 60, 70, 80, 90]);
  assert.deepEqual(fn([40, 90]), [40, 50, 60, 70, 80, 90]);
});

test('period-trend-axis: periodValueRangeFromTicks scales the hairline span to the declared domain', () => {
  const fn = guardLayoutCoreNs.periodValueRangeFromTicks;
  assert.equal(typeof fn, 'function');
  // [20, 90] drawn over 160px with 20-step hairlines (top hairline at 80).
  const y = (v) => 29 + (1 - (v - 20) / 70) * 160;
  const ticks = [20, 40, 60, 80].map((value) => ({ value, y: y(value) }));
  assert.ok(Math.abs(fn(ticks, [20, 90]) - 160) < 1e-9);
  // The shipped 80px compact span still measures 80 (the RED case stays red).
  const y80 = (v) => 29 + (1 - (v - 20) / 80) * 80;
  assert.ok(
    Math.abs(
      fn(
        [20, 40, 60, 80, 100].map((v) => ({ value: v, y: y80(v) })),
        [20, 100],
      ) - 80,
    ) < 1e-9,
  );
  // No declared domain: the plain hairline span.
  assert.ok(Math.abs(fn(ticks, null) - (y(20) - y(80))) < 1e-9);
  assert.equal(fn([{ value: 20, y: 10 }], [20, 90]), null);
  assert.equal(fn([], [20, 90]), null);
});

test('period-trend-axis: the PERIOD_TREND_AXIS line prints every measured value', () => {
  const fn = guardLayoutCoreNs.formatPeriodTrendAxisLine;
  assert.equal(typeof fn, 'function');
  assert.equal(
    fn('matchups-sketch-deep', '1440x900', sketchAxisSurface()),
    'PERIOD_TREND_AXIS route=matchups-sketch-deep viewport=1440x900 state=drawn step=20 ticks=20,40,60,80,100 count=5 tickFont=10 tickColor=muted-foreground xFont=10 xColor=muted-foreground valueFont=10 valueWeight=600 valueColor=foreground refFont=10 gutter=26.0 tickGap=6.0 vgrid=0 axisLines=0 strayHairlines=0',
  );
});

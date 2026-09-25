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

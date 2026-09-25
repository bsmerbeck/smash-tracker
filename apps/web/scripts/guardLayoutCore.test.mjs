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

test('picker-alignment: a stacked vs box sharing control 0\'s row fails picker-vs-misplaced', () => {
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
    { selectorPath: '#tag', text: 'synthopp15', scrollWidth: 75, clientWidth: 50, rowContentWidth: 294 },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'tag-truncated');
});

test('row-tag-legibility: the same truncation with clientWidth 270 (share 0.92) passes — a tag owning its line may truncate', () => {
  const violations = evaluateRowTagLegibility([
    { selectorPath: '#tag', text: 'synthopp15', scrollWidth: 280, clientWidth: 270, rowContentWidth: 294 },
  ]);
  assert.equal(violations.length, 0);
});

test('row-tag-legibility: scrollWidth equal to clientWidth + 1 passes', () => {
  const violations = evaluateRowTagLegibility([
    { selectorPath: '#tag', text: 'synthopp15', scrollWidth: 51, clientWidth: 50, rowContentWidth: 294 },
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
    cards: [{ marker: '[data-slot="matchup-chart-body"]', selectorPath: '#card', height: 1204, maxViewportHeights: 1 }],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'card-height-ceiling');
  assert.equal(violations[0].height, 1204);
  assert.equal(violations[0].limitPx, 844);
});

test('card-height-ceiling: a 664px card passes', () => {
  const violations = evaluateCardHeightCeilings({
    innerHeight: 844,
    cards: [{ marker: '[data-slot="matchup-chart-body"]', selectorPath: '#card', height: 664, maxViewportHeights: 1 }],
  });
  assert.equal(violations.length, 0);
});

test('card-height-ceiling: exactly 844px (the limit) passes', () => {
  const violations = evaluateCardHeightCeilings({
    innerHeight: 844,
    cards: [{ marker: '[data-slot="matchup-chart-body"]', selectorPath: '#card', height: 844, maxViewportHeights: 1 }],
  });
  assert.equal(violations.length, 0);
});

test('card-height-ceiling: 845px (0.01 over the limit) fails', () => {
  const violations = evaluateCardHeightCeilings({
    innerHeight: 844,
    cards: [{ marker: '[data-slot="matchup-chart-body"]', selectorPath: '#card', height: 845, maxViewportHeights: 1 }],
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
    cards: [{ marker: '[data-slot="matchup-chart-body"]', selectorPath: null, height: null, maxViewportHeights: 1 }],
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

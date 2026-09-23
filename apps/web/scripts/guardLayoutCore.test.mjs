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
  EXTRA_ORACLE_VIEWPORTS,
  ORPHAN_HALF_MIN_RATIO,
  HEADER_SQUEEZE_MIN_SHARE,
  MIN_TICK_GAP_PX,
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

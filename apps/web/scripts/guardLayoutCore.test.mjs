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
  evaluateStretch,
  evaluateScrollBudget,
  evaluateHorizontalOverflow,
  evaluateTruncation,
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

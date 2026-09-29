/**
 * quick-260929-g80: pins the CI test-sharding invariants in
 * `.github/workflows/ci.yml`.
 *
 * The web and api vitest suites run as `--shard=i/N` matrices, with N taken
 * from `strategy.job-total`. A mis-sized matrix (a gap in the shard list, an
 * extra matrix dimension, an include/exclude) silently drops a slice of test
 * files while every job stays green. These tests make that a red test: the
 * real workflow must satisfy `checkTestSharding`, and each of eight mutations
 * of it must be reported with its expected violation code (so the checks are
 * proven able to fail, and no fixture can silently do nothing).
 *
 * Plain Node test, run via `node --test` alongside the other guard tests
 * (`pnpm --filter @smash-tracker/web test:guards`); excluded from vitest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkTestSharding } from './ciWorkflowCore.mjs';

const ciPath = fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url));
const ci = readFileSync(ciPath, 'utf8');

const SHARED_BUILD_STEP =
  '      - name: Build shared\n        run: pnpm --filter @smash-tracker/shared build\n\n';

/**
 * Replaces the first `from` at or after the `after` marker, and fails if the
 * text did not change (a mutation that matches nothing proves nothing).
 */
function mutate(from, to, after = '') {
  const start = after === '' ? 0 : ci.indexOf(after);
  assert.notEqual(start, -1, `mutation anchor not found: ${after}`);
  const at = ci.indexOf(from, start);
  assert.notEqual(at, -1, `mutation target not found: ${from}`);
  const mutated = ci.slice(0, at) + to + ci.slice(at + from.length);
  assert.notEqual(mutated, ci, 'mutation did not change the workflow');
  return mutated;
}

function violationsOf(text) {
  return checkTestSharding(text);
}

function expectViolation(text, prefix) {
  const violations = violationsOf(text);
  assert.ok(
    violations.some((v) => v.startsWith(prefix)),
    `expected a violation starting ${prefix}, got ${JSON.stringify(violations)}`,
  );
  return violations;
}

test('the real ci.yml satisfies every sharding invariant', () => {
  assert.deepEqual(violationsOf(ci), []);
});

test('M1: a gap in the web shard list is rejected', () => {
  expectViolation(
    mutate('shard: [1, 2, 3, 4]', 'shard: [1, 2, 4]'),
    'SHARD_MATRIX_NOT_CONTIGUOUS:test-web',
  );
});

test('M2: an extra matrix dimension on the web job is rejected', () => {
  expectViolation(
    mutate('shard: [1, 2, 3, 4]', 'shard: [1, 2, 3, 4]\n        node: [22, 24]'),
    'SHARD_MATRIX_EXTRA_KEY:test-web',
  );
});

test('M3: removing fail-fast: false from test-api is rejected', () => {
  expectViolation(
    mutate('      fail-fast: false\n', '', '  test-api:'),
    'SHARD_FAIL_FAST:test-api',
  );
});

test('M4: dropping test-web from the aggregate needs is rejected', () => {
  const violations = expectViolation(
    mutate(
      'needs: [checks, test-shared, test-api, test-web]',
      'needs: [checks, test-shared, test-api]',
    ),
    'GATE_NEEDS:',
  );
  assert.ok(violations.some((v) => v.startsWith('GATE_NEEDS:') && v.includes('test-web')));
});

test('M5: a hardcoded web shard denominator is rejected', () => {
  expectViolation(
    mutate(
      'web exec vitest run --shard=${{ matrix.shard }}/${{ strategy.job-total }}',
      'web exec vitest run --shard=${{ matrix.shard }}/3',
    ),
    'SHARD_CMD:web',
  );
});

test('M6: running the web node guards twice is rejected', () => {
  expectViolation(
    mutate(
      '        run: pnpm build\n',
      '        run: pnpm build\n\n      - name: Guards again\n        run: pnpm --filter @smash-tracker/web test:guards\n',
    ),
    'RUN_ONCE:',
  );
});

test('M7: removing the shared build from test-api is rejected', () => {
  expectViolation(mutate(SHARED_BUILD_STEP, '', '  test-api:'), 'SHARD_SHARED_BUILD:test-api');
});

test('M8: removing if: always() from the aggregate gate is rejected', () => {
  expectViolation(mutate('    if: always()\n', ''), 'GATE_ALWAYS');
});

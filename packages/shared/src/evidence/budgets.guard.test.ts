import { describe, expect, it } from 'vitest';
import { SCL_01_BUDGETS } from './budgets.js';

/**
 * WR-04-i3 (36-REVIEW.md iteration 3): a COMMITTED, falsifiable regression
 * guard for `budgets.ts`'s own "never-loosen / append-only" contract
 * (D-19, `.planning/phases/36-evidence-engine-foundation-scale-gate/36-CONTEXT.md`).
 *
 * Before this file, that contract was enforced by nothing but a doc comment
 * in `budgets.ts` plus a one-off `node -e "..."` shell check described in
 * `36-06-PLAN.md`'s `<verify>` block — a check that ran exactly once, by
 * hand, during that plan's own execution, and left no trace anywhere a
 * future contributor (or CI) could re-run. Per this project's own convention
 * ("acceptance oracles must be committed and falsifiable"), that is not an
 * oracle. This file is: it pins the five D-19 target values by id as a
 * literal snapshot, so a PR that loosens a target, renames/removes an id, or
 * reorders the five relative to one another turns this test red, while a PR
 * that TIGHTENS a target (or appends a genuinely new id after them, per the
 * append-only rule) stays green.
 *
 * Deliberately named `*.guard.test.ts` (NOT `*.budget.test.ts`) — this is a
 * pure, instant structural assertion over five numbers, not a timing
 * measurement, so unlike the actual budget-measurement suites it belongs in
 * the DEFAULT `pnpm test` run (see `vitest.config.ts`'s exclude list, which
 * only excludes `**\/*.budget.test.ts`).
 *
 * Proof this guard is genuinely falsifiable (run by hand while fixing
 * WR-04-i3, not committed as a test): temporarily loosening
 * `engine-recompute-p95-8k`'s target from 100 to 101 turned both assertions
 * below red (id-loop failure naming the exact id, in the expected direction)
 * before the value was restored — see `36-REVIEW-FIX.md`'s Iteration 3
 * section for the transcript.
 */
const PINNED_D19_TARGETS: ReadonlyArray<{
  id: string;
  target: number;
  unit: 'ms' | 'MB' | 'bytes';
}> = [
  { id: 'engine-recompute-p95-8k', target: 100, unit: 'ms' },
  { id: 'engine-recompute-p95-50k', target: 400, unit: 'ms' },
  { id: 'filter-change-to-paint-8k', target: 200, unit: 'ms' },
  { id: 'heap-delta-50k', target: 150, unit: 'MB' },
  { id: 'matches-gzip-payload-8k', target: 1_500_000, unit: 'bytes' },
];

describe('SCL_01_BUDGETS — never-loosen / append-only guard (D-19, WR-04-i3)', () => {
  it('every pinned D-19 budget id is still present, with its unit unchanged and its target at least as strict as pinned', () => {
    for (const pinned of PINNED_D19_TARGETS) {
      const live = SCL_01_BUDGETS.find((budget) => budget.id === pinned.id);
      expect(live, `budget id "${pinned.id}" must not be removed or renamed`).toBeDefined();
      expect(live!.unit, `budget id "${pinned.id}" must not change unit`).toBe(pinned.unit);
      // ms/MB/bytes are all "smaller is better" quantities in this module,
      // so "at least as strict as pinned" is uniformly "<=" — no per-unit
      // branch needed.
      expect(
        live!.target,
        `budget id "${pinned.id}" target must never LOOSEN past its pinned D-19 value ` +
          `(${pinned.target}${pinned.unit}); current value is ${live!.target}${live!.unit}`,
      ).toBeLessThanOrEqual(pinned.target);
    }
  });

  it('preserves the five pinned D-19 ids in their original relative order (append-only: new ids may follow, none of the five may be reordered, removed, or renamed)', () => {
    const liveIds = SCL_01_BUDGETS.map((budget) => budget.id);
    const pinnedIndices = PINNED_D19_TARGETS.map((pinned) => liveIds.indexOf(pinned.id));

    expect(pinnedIndices.every((index) => index !== -1)).toBe(true);

    const sortedIndices = [...pinnedIndices].sort((a, b) => a - b);
    expect(pinnedIndices).toEqual(sortedIndices);
  });
});

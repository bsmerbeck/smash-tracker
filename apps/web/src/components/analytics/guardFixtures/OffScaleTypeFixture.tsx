/**
 * The type-scale guard's own deliberately-broken failing case (UI-SPEC
 * §13.16, Phase 39.1 Plan 09): the sketches' `text-[13px]` door label and a
 * `font-bold` figure — two of §13.16's five violation classes at once
 * (an off-scale arbitrary size literal, and a weight outside
 * `font-normal|font-medium|font-semibold`). Never rendered by any real page
 * — this component exists only so `typeScale.test.ts` has a proven,
 * reproducible bad input to scan. Deliberately excluded from the guard's
 * own live scan (see `typeScale.test.ts`'s `guardFixtures/` exclusion) so
 * the default suite stays green; the guard's "positive control" test scans
 * this file's raw source directly, bypassing that exclusion, to prove the
 * violation-detection logic actually fires on it.
 */
export function OffScaleTypeFixture() {
  return (
    <div>
      <span className="text-[13px] text-muted-foreground">Off-scale door label</span>
      <span className="font-bold">Off-scale figure weight</span>
    </div>
  );
}

import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The layout oracle's own deliberately-broken failing case (UI-SPEC §13.1,
 * Phase 39.1 Plan 09). A `PageGrid` row holding one short card next to a
 * tall sibling. `PageGrid`'s `items-start` (hardcoded, never a prop) means a
 * plain `GridCell` never inherits its row's height, so `h-full` alone has no
 * effect here — this fixture gives the short card's `GridCell` an explicit
 * height (`h-[300px]`, always present) so `h-full` on the CARD has a
 * definite ancestor to resolve its percentage against, reproducing exactly
 * the "card pulled to a fixed box far taller than its own content" defect
 * UIX-01 bans, without the fixture needing to defeat `items-start` itself.
 *
 * When `VITE_GUARD_LAYOUT_STRETCH_FIXTURE` is set to `'1'` the short card is
 * given `h-full` — the exact stretch class UIX-01 bans — pulling it to the
 * full 300px box height, far more than the oracle's 24px tolerance above its
 * own (much shorter) content height. Left unset (the COMMITTED state of
 * this plan), the card has no height class and sizes to its own content as
 * normal — the explicit-height `GridCell` box has slack space below an
 * unstretched card, which the oracle does not measure (it measures the
 * `Card`, never its `GridCell`), so `guard:layout` is green. The flag lets
 * plan 39.1-20 re-arm this exact failing case on demand without
 * re-authoring the defect.
 */
const STRETCH_FLAG_ENABLED = import.meta.env.VITE_GUARD_LAYOUT_STRETCH_FIXTURE === '1';

export function StretchedCardFixture() {
  return (
    <div id="guard-layout-fixture-root" data-guard-loaded="stretched-card-fixture">
      <PageGrid>
        <GridCell span={4} className="h-[300px]">
          <Card
            data-testid="guard-fixture-short-card"
            className={STRETCH_FLAG_ENABLED ? 'h-full' : undefined}
          >
            <CardHeader>
              <CardTitle>Short card</CardTitle>
            </CardHeader>
            <CardContent>
              <p>One short line of content.</p>
            </CardContent>
          </Card>
        </GridCell>
        <GridCell span={4}>
          <Card data-testid="guard-fixture-tall-card">
            <CardHeader>
              <CardTitle>Tall card</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p>A tall sibling with several lines of content, so its natural</p>
              <p>height is much greater than the short card&apos;s natural height —</p>
              <p>enough that a stretched short card would clear the oracle&apos;s</p>
              <p>24px tolerance by a wide margin whenever the stretch flag is set.</p>
              <p>Line five of the tall sibling&apos;s content.</p>
              <p>Line six of the tall sibling&apos;s content.</p>
            </CardContent>
          </Card>
        </GridCell>
      </PageGrid>
    </div>
  );
}

import type { Match } from '@smash-tracker/shared';
import { RatingCurve } from './RatingCurve';
import { MonthlyPerformance } from './MonthlyPerformance';

export interface CareerTimelineSlotProps {
  matches: Match[];
}

/**
 * The Pro desk's interim career-timeline slot (UI-SPEC §8.2 Row 2, D-02,
 * D-13): a full-width wrapper holding the EXISTING `RatingCurve` and
 * `MonthlyPerformance` charts, 6 + 6 at >= 1024px and stacked below,
 * carrying a stable `data-slot` for the chart-rollout phase to find this
 * mount point. No footer note, no placeholder or coming-soon copy renders
 * inside it — the honest statement that owner notes 4 and 6 are answered
 * for LAYOUT in this phase and for chart FORM only after the chart-rollout
 * phase belongs in VERIFICATION and the owner walkthrough, never on a
 * user's screen. Both children charts stay on the chart.js legacy-canvas
 * allowlist (they are not rebuilt here) but draw their data ink in the
 * tokenised series colour (DD-11/UIX-05), not brand red.
 *
 * Phase 41's binding target contract for this slot is UI-SPEC §12.1 (the
 * career-timeline chart) — recorded verbatim in this plan's SUMMARY, not
 * built here.
 */
export function CareerTimelineSlot({ matches }: CareerTimelineSlotProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-slot="career-timeline-interim">
      <RatingCurve matches={matches} />
      <MonthlyPerformance matches={matches} />
    </div>
  );
}

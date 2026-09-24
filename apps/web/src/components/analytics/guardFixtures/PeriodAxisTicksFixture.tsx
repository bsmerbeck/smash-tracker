import type { PeriodGrain, PeriodPoint } from '@smash-tracker/shared';
import { TrendLine, type TrendLinePeriodLabels } from '@/components/charts/TrendLine';

/**
 * CR-01 (39.1-REVIEW.md) real-Chrome failing cases for guard:layout's
 * `axis-ticks` family. The Matchups route measures only the ONE period
 * series its fixture account happens to produce, which never lands on a
 * series length where the period axis's tick selection and its renderer
 * disagreed about label anchors — so the family passed while real accounts
 * smeared. This fixture pins the review's two reproduced lengths at their
 * exact plot widths (explicit `width` = plot width + the period chart's
 * 60px y-axis + 2×16px x padding, so the viewport never changes them):
 *   - month grain, 17 points, 262px plot (a ~390px phone card);
 *   - game grain, 10 points, 829px plot (a desktop card).
 * Measured at one viewport only (`guardLayout.mjs`), because both charts
 * are fixed-width by construction.
 */
const PERIOD_Y_AXIS_AND_PADDING_PX = 60 + 16 * 2;

const FIXTURE_LABELS: TrendLinePeriodLabels = {
  lockedSentence: 'Period trend locked.',
  lockedCountLabel: '0 of 8',
  tableToggle: 'View as table',
  tableHeaders: { period: 'Period', record: 'Record', rate: 'Rate', sample: 'Sample' },
};

/** Deterministic, gently varying rates so value labels and dots sit well above the axis. */
function fixtureRate(i: number): number {
  return 0.45 + 0.1 * Math.sin(i);
}

function fixtureSeries(grain: PeriodGrain, count: number): PeriodPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const startMs = grain === 'month' ? Date.UTC(2022, i, 1) : Date.UTC(2023, 10, 1 + i, 12);
    const rate = fixtureRate(i);
    const total = 10;
    const wins = Math.round(rate * total);
    return {
      grain,
      key: `${grain}:guard-fixture:${i}`,
      label: grain === 'month' ? `m${i}` : new Date(startMs).toISOString(),
      startMs,
      endMs: startMs + 1,
      wins,
      losses: total - wins,
      total,
      rate: wins / total,
      subFloor: false,
      matchIds: [],
    };
  });
}

const FIXTURE_CASES: { id: string; grain: PeriodGrain; count: number; plotWidthPx: number }[] = [
  { id: 'month-17-at-262', grain: 'month', count: 17, plotWidthPx: 262 },
  { id: 'game-10-at-829', grain: 'game', count: 10, plotWidthPx: 829 },
];

export function PeriodAxisTicksFixture() {
  return (
    <div
      id="guard-layout-fixture-root"
      data-guard-loaded="period-axis-ticks-fixture"
      className="flex flex-col gap-8 p-4"
    >
      {FIXTURE_CASES.map((fixtureCase) => (
        <div key={fixtureCase.id} data-fixture-case={fixtureCase.id}>
          <TrendLine
            mode="period"
            points={fixtureSeries(fixtureCase.grain, fixtureCase.count)}
            width={fixtureCase.plotWidthPx + PERIOD_Y_AXIS_AND_PADDING_PX}
            height={240}
            labels={FIXTURE_LABELS}
          />
        </div>
      ))}
    </div>
  );
}

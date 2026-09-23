import type { PeriodGrain, PeriodPoint } from '@smash-tracker/shared';

/**
 * STUB (plan 39.1-30 Task 1, RED phase): every export below keeps TODAY's
 * behaviour byte-for-byte — the formatters return the engine's raw
 * `point.label` unchanged, and the selector returns exactly the grain-rule
 * candidates `TrendLine.tsx`'s own `selectPeriodXAxisTicks` computes today.
 * This exists ONLY so `periodTicks.test.ts` fails on ASSERTIONS (the new
 * human-readable formatting the test file expects), never on an import
 * crash. The GREEN phase replaces every body here with the real
 * implementation described in the plan's action block — no signature below
 * changes.
 */

export function formatPeriodTickLabel(point: PeriodPoint, locale: string): string {
  void locale;
  return point.label;
}

export function formatPeriodRowLabel(point: PeriodPoint, locale: string): string {
  void locale;
  return point.label;
}

export function estimateTickLabelWidthPx(label: string): number {
  return label.length * 7;
}

function grainRuleCandidateKeys(points: PeriodPoint[]): string[] {
  const grain: PeriodGrain | undefined = points[0]?.grain;
  if (grain === 'quarter' || grain === 'year') {
    const seenYears = new Set<string>();
    return points
      .filter((point) => {
        const year = String(new Date(point.startMs).getUTCFullYear());
        if (seenYears.has(year)) return false;
        seenYears.add(year);
        return true;
      })
      .map((point) => point.key);
  }
  if (grain === 'week') {
    const seenMonths = new Set<string>();
    return points
      .filter((point) => {
        const d = new Date(point.startMs);
        const tickMonthGroup = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
        if (seenMonths.has(tickMonthGroup)) return false;
        seenMonths.add(tickMonthGroup);
        return true;
      })
      .map((point) => point.key);
  }
  return points.filter((_, i) => i % 4 === 0).map((point) => point.key);
}

export function selectPeriodTicks(
  points: PeriodPoint[],
  opts: { plotWidthPx: number; locale: string },
): string[] {
  void opts;
  if (points.length === 0) return [];
  return grainRuleCandidateKeys(points);
}

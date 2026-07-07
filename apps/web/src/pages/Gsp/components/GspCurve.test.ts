import { describe, expect, it } from 'vitest';
import type { GspPoint } from '@smash-tracker/shared';
import { buildGspCurveData } from './GspCurve';

describe('buildGspCurveData', () => {
  it('builds a GSP dataset and a flat threshold line of the same length', () => {
    const series: GspPoint[] = [
      { time: 1, gsp: 9_000_000, win: true },
      { time: 2, gsp: 9_100_000, win: true },
    ];

    const data = buildGspCurveData(series, 10_000_000);

    expect(data.labels).toHaveLength(2);
    expect(data.datasets[0]!.data).toEqual([9_000_000, 9_100_000]);
    expect(data.datasets[1]!.data).toEqual([10_000_000, 10_000_000]);
    expect(data.datasets[1]!.label).toBe('Elite threshold');
  });

  it('handles an empty series', () => {
    const data = buildGspCurveData([], 10_000_000);
    expect(data.labels).toEqual([]);
    expect(data.datasets[0]!.data).toEqual([]);
    expect(data.datasets[1]!.data).toEqual([]);
  });
});

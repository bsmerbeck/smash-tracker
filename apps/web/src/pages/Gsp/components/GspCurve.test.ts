import { describe, expect, it } from 'vitest';
import type { GspPoint, GspSettings } from '@smash-tracker/shared';
import { GSP_MODEL, estimateT, mmrToGsp } from '@smash-tracker/shared';
import { buildGspCurveData, buildMmrCurveData } from './GspCurve';

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

describe('buildMmrCurveData', () => {
  const neverSaved: GspSettings = { eliteThreshold: 10_000_000, updatedAt: 0 };

  it('converts readings to rounded MMR and draws the Elite line at the fixed Elite MMR', () => {
    // Construct GSP readings that decode to exactly MMR 1000 and 1100 at
    // their own log-time t, so the converted series is fully deterministic.
    const t0Ms = GSP_MODEL.T_ANCHOR.atMs;
    const t1Ms = t0Ms + 60 * 60 * 1000;
    const series: GspPoint[] = [
      { time: t0Ms, gsp: Math.round(mmrToGsp(1000, estimateT(t0Ms))), win: true },
      { time: t1Ms, gsp: Math.round(mmrToGsp(1100, estimateT(t1Ms))), win: true },
    ];

    const data = buildMmrCurveData(series, neverSaved);

    expect(data.labels).toHaveLength(2);
    expect(data.datasets[0]!.label).toBe('Est. MMR');
    expect(data.datasets[0]!.data).toEqual([1000, 1100]);
    expect(data.datasets[1]!.label).toBe(`Elite (MMR ${GSP_MODEL.ELITE_MMR})`);
    expect(data.datasets[1]!.data).toEqual([GSP_MODEL.ELITE_MMR, GSP_MODEL.ELITE_MMR]);
  });

  it('a flat-skill series renders flat in MMR even though its GSP inflated', () => {
    const t0Ms = GSP_MODEL.T_ANCHOR.atMs;
    const t1Ms = t0Ms + 14 * 24 * 60 * 60 * 1000; // two weeks of ceiling drift
    const series: GspPoint[] = [
      { time: t0Ms, gsp: Math.round(mmrToGsp(1050, estimateT(t0Ms))), win: true },
      { time: t1Ms, gsp: Math.round(mmrToGsp(1050, estimateT(t1Ms))), win: true },
    ];
    expect(series[1]!.gsp).toBeGreaterThan(series[0]!.gsp);

    const data = buildMmrCurveData(series, neverSaved);
    expect(data.datasets[0]!.data).toEqual([1050, 1050]);
  });

  it('handles an empty series', () => {
    const data = buildMmrCurveData([], neverSaved);
    expect(data.labels).toEqual([]);
    expect(data.datasets[0]!.data).toEqual([]);
    expect(data.datasets[1]!.data).toEqual([]);
  });
});

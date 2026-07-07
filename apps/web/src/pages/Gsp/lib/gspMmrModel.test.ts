import { describe, expect, it } from 'vitest';
import type { GspPoint, GspSettings } from '@smash-tracker/shared';
import { GSP_MODEL, eliteThresholdGsp, estimateT, gspToMmr, mmrToGsp } from '@smash-tracker/shared';
import {
  calibrationFromSettings,
  computedEliteThreshold,
  estimateMmrAt,
  toMmrSeries,
} from './gspMmrModel';

describe('calibrationFromSettings', () => {
  it('returns undefined for the never-saved sentinel (updatedAt 0)', () => {
    const settings: GspSettings = { eliteThreshold: 10_300_000, updatedAt: 0 };
    expect(calibrationFromSettings(settings)).toBeUndefined();
  });

  it('maps a saved setting to a TCalibration (value + timestamp)', () => {
    const settings: GspSettings = { eliteThreshold: 14_720_247, updatedAt: 1_780_000_000_000 };
    expect(calibrationFromSettings(settings)).toEqual({
      eliteThresholdGsp: 14_720_247,
      atMs: 1_780_000_000_000,
    });
  });
});

describe('computedEliteThreshold', () => {
  it('without a calibration, equals the model threshold at estimateT(now), rounded', () => {
    const nowMs = GSP_MODEL.T_ANCHOR.atMs + 5 * 60 * 60 * 1000;
    expect(computedEliteThreshold(nowMs)).toBe(Math.round(eliteThresholdGsp(estimateT(nowMs))));
  });

  it('reproduces (approximately) a calibration reading at the calibration instant', () => {
    // Save "the threshold is X right now" and immediately recompute: the
    // computed value must come back to X (within rounding of the t-solve).
    const atMs = GSP_MODEL.T_ANCHOR.atMs + 10 * 24 * 60 * 60 * 1000;
    const observed = 14_800_000;
    const computed = computedEliteThreshold(atMs, { eliteThresholdGsp: observed, atMs });
    expect(Math.abs(computed - observed)).toBeLessThanOrEqual(1);
  });

  it('drifts upward as time passes the calibration', () => {
    const atMs = GSP_MODEL.T_ANCHOR.atMs;
    const calibration = { eliteThresholdGsp: 14_720_247, atMs };
    const aWeekLater = atMs + 7 * 24 * 60 * 60 * 1000;
    expect(computedEliteThreshold(aWeekLater, calibration)).toBeGreaterThan(
      computedEliteThreshold(atMs, calibration),
    );
  });
});

describe('estimateMmrAt', () => {
  it('converts a GSP reading at the t of the given time', () => {
    const atMs = GSP_MODEL.T_ANCHOR.atMs;
    const t = estimateT(atMs);
    const gsp = mmrToGsp(1100, t);
    const result = estimateMmrAt(gsp, atMs);
    expect(result.zone).toBe('main');
    expect(result.mmr).toBeCloseTo(1100, 3);
  });

  it('flags tail readings via zone', () => {
    const atMs = GSP_MODEL.T_ANCHOR.atMs;
    const t = estimateT(atMs);
    expect(estimateMmrAt(mmrToGsp(1500, t), atMs).zone).toBe('top');
    expect(estimateMmrAt(mmrToGsp(500, t), atMs).zone).toBe('bottom');
  });
});

describe('toMmrSeries', () => {
  it('converts each reading at its OWN log time — flat skill stays flat despite GSP inflation', () => {
    // Two readings a week apart, both at exactly MMR 1100 "in reality":
    // the GSP for the same MMR is HIGHER a week later (the ceiling rose),
    // yet the MMR series comes back flat.
    const t0Ms = GSP_MODEL.T_ANCHOR.atMs;
    const t1Ms = t0Ms + 7 * 24 * 60 * 60 * 1000;
    const series: GspPoint[] = [
      { time: t0Ms, gsp: Math.round(mmrToGsp(1100, estimateT(t0Ms))), win: true },
      { time: t1Ms, gsp: Math.round(mmrToGsp(1100, estimateT(t1Ms))), win: true },
    ];
    expect(series[1]!.gsp).toBeGreaterThan(series[0]!.gsp); // GSP inflated...
    const mmrSeries = toMmrSeries(series);
    expect(Math.round(mmrSeries[0]!.mmr)).toBe(1100); // ...but MMR is flat.
    expect(Math.round(mmrSeries[1]!.mmr)).toBe(1100);
  });

  it('preserves time/win and carries the zone through', () => {
    const atMs = GSP_MODEL.T_ANCHOR.atMs;
    const t = estimateT(atMs);
    const series: GspPoint[] = [
      { time: atMs, gsp: Math.round(mmrToGsp(1000, t)), win: true },
      { time: atMs + 1000, gsp: Math.round(mmrToGsp(1600, estimateT(atMs + 1000))), win: false },
    ];
    const mmrSeries = toMmrSeries(series);
    expect(mmrSeries[0]).toMatchObject({ time: atMs, win: true, zone: 'main' });
    expect(mmrSeries[1]).toMatchObject({ time: atMs + 1000, win: false, zone: 'top' });
  });

  it('uses the calibration when provided (matches a direct gspToMmr at the calibrated t)', () => {
    const atMs = GSP_MODEL.T_ANCHOR.atMs + 30 * 24 * 60 * 60 * 1000;
    const calibration = { eliteThresholdGsp: 15_000_000, atMs };
    const gsp = 12_000_000;
    const expected = gspToMmr(gsp, estimateT(atMs, calibration));
    const [point] = toMmrSeries([{ time: atMs, gsp, win: true }], calibration);
    expect(point!.mmr).toBeCloseTo(expected.mmr, 8);
    expect(point!.zone).toBe(expected.zone);
  });

  it('returns an empty array for an empty series', () => {
    expect(toMmrSeries([])).toEqual([]);
  });
});

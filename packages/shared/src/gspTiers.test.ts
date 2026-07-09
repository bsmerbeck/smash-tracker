import { describe, expect, it } from 'vitest';
import { estimateMaxGsp, estimateT } from './gspMmr.js';
import { GSP_TIER_FRACTIONS, getGspTierLadder, getGspTierPosition } from './gspTiers.js';

/**
 * The gsptiers.com observation the ladder (and `MAX_GSP_OVER_CEILING`) was
 * captured against on 2026-07-09: max 16,368,515 / elite 14,813,136 at
 * 2026-07-09T13:45:11.528Z. Solving t from that elite reading makes the test
 * deterministic and self-consistent regardless of when it runs.
 */
const CAPTURE = {
  max: 16_368_515,
  elite: 14_813_136,
  atMs: Date.parse('2026-07-09T13:45:11.528Z'),
};
const tAtCapture = estimateT(CAPTURE.atMs, {
  eliteThresholdGsp: CAPTURE.elite,
  atMs: CAPTURE.atMs,
});

describe('estimateMaxGsp', () => {
  it('reproduces the captured gsptiers.com max within rounding of the observed ratio', () => {
    // The ratio constant is stored to 5 decimals; at ~16M GSP that is a
    // few-hundred-GSP quantization, so allow 1,000.
    expect(Math.abs(estimateMaxGsp(tAtCapture) - CAPTURE.max)).toBeLessThan(1_000);
  });
});

describe('getGspTierLadder', () => {
  const ladder = getGspTierLadder(tAtCapture);

  it('has one row per fraction tier plus the Elite row, strictly descending', () => {
    expect(ladder).toHaveLength(GSP_TIER_FRACTIONS.length + 1);
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i]!.gsp).toBeLessThan(ladder[i - 1]!.gsp);
    }
  });

  it('slots Elite between top 5% and top 20% at the captured calibration', () => {
    const ids = ladder.map((row) => row.id);
    const elite = ids.indexOf('elite');
    expect(ids[elite - 1]).toBe('top5');
    expect(ids[elite + 1]).toBe('top20');
  });

  it('reproduces the captured boundaries: Elite at the live threshold, fractions of max', () => {
    const byId = new Map(ladder.map((row) => [row.id, row]));
    expect(Math.abs(byId.get('elite')!.gsp - CAPTURE.elite)).toBeLessThan(2);
    // Fraction rows inherit estimateMaxGsp's ~1,000-GSP ratio quantization.
    expect(Math.abs(byId.get('god')!.gsp - CAPTURE.max)).toBeLessThan(1_000);
    expect(Math.abs(byId.get('top50')!.gsp - CAPTURE.max * 0.5)).toBeLessThan(1_000);
  });

  it('computes the elite percent from the live threshold (~9.5% at capture)', () => {
    const elite = ladder.find((row) => row.id === 'elite')!;
    expect(elite.topPercent).toBeCloseTo(9.5, 1);
    expect(ladder.find((row) => row.id === 'god')!.topPercent).toBe(0);
    expect(ladder.find((row) => row.id === 'legend')!.topPercent).toBe(0.2);
    expect(ladder.find((row) => row.id === 'top90')!.topPercent).toBe(90);
  });
});

describe('getGspTierPosition', () => {
  const ladder = getGspTierLadder(tAtCapture);
  const boundary = (id: string) => ladder.find((row) => row.id === id)!.gsp;

  it('places a mid-ladder reading with progress toward the next tier up', () => {
    const halfway = Math.round((boundary('top30') + boundary('top20')) / 2);
    const position = getGspTierPosition(halfway, ladder);

    expect(position.current.id).toBe('top30');
    expect(position.next!.id).toBe('top20');
    expect(position.gspToNext).toBe(boundary('top20') - halfway);
    expect(position.progressToNext).toBeCloseTo(0.5, 1);
  });

  it('treats a reading exactly on a boundary as inside that tier', () => {
    const position = getGspTierPosition(boundary('elite'), ladder);

    expect(position.current.id).toBe('elite');
    expect(position.next!.id).toBe('top5');
    expect(position.progressToNext).toBe(0);
  });

  it('caps out at god with no next tier', () => {
    const position = getGspTierPosition(boundary('god') + 123_456, ladder);

    expect(position.current.id).toBe('god');
    expect(position.next).toBeNull();
    expect(position.gspToNext).toBeNull();
    expect(position.progressToNext).toBeNull();
  });

  it('returns the below sentinel under the last row, still pointing at top90', () => {
    const position = getGspTierPosition(Math.round(boundary('top90') / 2), ladder);

    expect(position.current.id).toBe('below');
    expect(position.next!.id).toBe('top90');
    expect(position.gspToNext).toBeGreaterThan(0);
    expect(position.progressToNext).toBeGreaterThan(0);
    expect(position.progressToNext).toBeLessThan(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  GSP_MODEL,
  MAX_PROJECTED_MATCHES,
  MMR_POINTS_TABLE,
  ASSUMED_MMR_POINTS_PER_MATCH,
  eloExpectedPointsForWin,
  estimateT,
  eliteThresholdGsp,
  gspToMmr,
  mmrToGsp,
  mmrPointsForWin,
  mmrPointsForWinDetailed,
  normCdf,
  normInv,
  projectMatchesToEliteMmr,
} from './gspMmr.js';

describe('normCdf', () => {
  it('Φ(0) = 0.5', () => {
    // The Numerical Recipes erfc approximation has a documented fractional
    // error < 1.2e-7 (see module doc) — precision expectations throughout
    // this file are set at 6-7 decimal places to match that floor, not
    // machine epsilon.
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
  });

  it('Φ(1.2909...) ≈ 0.9016 (this model’s Elite z-score)', () => {
    expect(normCdf((1142 - 1000) / 110)).toBeCloseTo(0.9016323928886333, 6);
  });

  it('is symmetric: Φ(-z) = 1 - Φ(z)', () => {
    expect(normCdf(-1.5)).toBeCloseTo(1 - normCdf(1.5), 10);
  });

  it('matches known standard-normal reference values', () => {
    expect(normCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normCdf(-1)).toBeCloseTo(0.1586553, 6);
  });
});

describe('normInv', () => {
  it('Φ⁻¹(0.5) = 0', () => {
    expect(normInv(0.5)).toBeCloseTo(0, 8);
  });

  it('is the inverse of normCdf across the main range', () => {
    for (const z of [-2.5, -1.29, -0.5, 0.1, 0.9, 1.2909090909, 2.2]) {
      expect(normInv(normCdf(z))).toBeCloseTo(z, 6);
    }
  });

  it('matches a known reference value (97.5th percentile ≈ 1.95996)', () => {
    expect(normInv(0.975)).toBeCloseTo(1.959963985, 6);
  });

  it('clamps to +/-Infinity outside (0, 1)', () => {
    expect(normInv(0)).toBe(-Infinity);
    expect(normInv(1)).toBe(Infinity);
    expect(normInv(-0.1)).toBe(-Infinity);
    expect(normInv(1.1)).toBe(Infinity);
  });
});

describe('GSP_MODEL constants', () => {
  it('matches the reverse-engineered doc verbatim', () => {
    expect(GSP_MODEL.A).toBe(1_995_587);
    expect(GSP_MODEL.K).toBe(16_058_300);
    expect(GSP_MODEL.T_ANCHOR).toEqual({ t: 502, atMs: Date.UTC(2026, 5, 11, 19, 21) });
    expect(GSP_MODEL.T_PER_HOUR).toBe(0.98);
    expect(GSP_MODEL.CENTER).toBe(1000);
    expect(GSP_MODEL.SIGMA).toBe(110);
    expect(GSP_MODEL.ELITE_MMR).toBe(1142);
    expect(GSP_MODEL.SLOPE_TOP).toBe(220.5);
    expect(GSP_MODEL.SLOPE_BOTTOM).toBe(248.8);
    expect(GSP_MODEL.MAIN_MIN).toBe(600);
    expect(GSP_MODEL.MAIN_MAX).toBe(1400);
  });

  it('anchor timestamp is exactly 2026-06-11T19:21:00Z', () => {
    expect(new Date(GSP_MODEL.T_ANCHOR.atMs).toISOString()).toBe('2026-06-11T19:21:00.000Z');
  });
});

describe('estimateT', () => {
  it('returns the anchor t at the anchor time with no calibration', () => {
    expect(estimateT(GSP_MODEL.T_ANCHOR.atMs)).toBeCloseTo(502, 8);
  });

  it('advances at 0.98/hour from the anchor', () => {
    const oneHourLater = GSP_MODEL.T_ANCHOR.atMs + 60 * 60 * 1000;
    expect(estimateT(oneHourLater)).toBeCloseTo(502.98, 6);
    const oneDayLater = GSP_MODEL.T_ANCHOR.atMs + 24 * 60 * 60 * 1000;
    expect(estimateT(oneDayLater)).toBeCloseTo(502 + 24 * 0.98, 6);
  });

  it('goes backward in time correctly too', () => {
    const oneHourBefore = GSP_MODEL.T_ANCHOR.atMs - 60 * 60 * 1000;
    expect(estimateT(oneHourBefore)).toBeCloseTo(502 - 0.98, 6);
  });

  it('with a calibration exactly reproducing the anchor, recovers the anchor t going forward', () => {
    const calibration = {
      eliteThresholdGsp: eliteThresholdGsp(502),
      atMs: GSP_MODEL.T_ANCHOR.atMs,
    };
    expect(estimateT(GSP_MODEL.T_ANCHOR.atMs, calibration)).toBeCloseTo(502, 4);
    const oneHourLater = GSP_MODEL.T_ANCHOR.atMs + 60 * 60 * 1000;
    expect(estimateT(oneHourLater, calibration)).toBeCloseTo(502.98, 4);
  });

  it('recalibrates from a DIFFERENT t: a later, higher threshold reading resets the drift basis', () => {
    const laterMs = GSP_MODEL.T_ANCHOR.atMs + 10 * 24 * 60 * 60 * 1000; // 10 days later
    const realTAtLater = estimateT(laterMs); // ~502 + 240*0.98
    const calibration = { eliteThresholdGsp: eliteThresholdGsp(realTAtLater), atMs: laterMs };
    expect(estimateT(laterMs, calibration)).toBeCloseTo(realTAtLater, 4);

    // Project a further day forward from the calibration and confirm the
    // drift keeps advancing from the recalibrated basis, not the original anchor.
    const twoDaysAfterCalibration = laterMs + 24 * 60 * 60 * 1000;
    expect(estimateT(twoDaysAfterCalibration, calibration)).toBeCloseTo(
      realTAtLater + 0.98 * 24,
      3,
    );
  });
});

describe('eliteThresholdGsp — the doc’s worked example', () => {
  it('t=502 ⇒ Elite threshold ≈ 14,720,247 (within ±1 GSP, per the doc)', () => {
    const gsp = eliteThresholdGsp(502);
    expect(gsp).toBeCloseTo(14_720_246.6, 0);
    expect(Math.round(gsp)).toBe(14_720_247);
  });
});

describe('mmrToGsp / gspToMmr — main curve', () => {
  const t = 502;

  it('round-trips across the main curve (MMR 600-1400)', () => {
    for (const mmr of [600, 650, 800, 950, 1000, 1050, 1142, 1200, 1350, 1400]) {
      const gsp = mmrToGsp(mmr, t);
      const back = gspToMmr(gsp, t);
      expect(back.zone).toBe('main');
      expect(back.mmr).toBeCloseTo(mmr, 4);
    }
  });

  it('MMR 1000 (center) maps to the midpoint between A and the ceiling', () => {
    const gsp = mmrToGsp(1000, t);
    const ceiling = GSP_MODEL.K + 100 * t;
    // Loosened to match the erfc approximation's precision floor (see
    // normCdf's module doc) rather than exact machine precision.
    expect(gsp).toBeCloseTo((GSP_MODEL.A + ceiling) / 2, 0);
  });

  it('Elite MMR (1142) maps to eliteThresholdGsp(t)', () => {
    expect(mmrToGsp(1142, t)).toBeCloseTo(eliteThresholdGsp(t), 6);
  });

  it('is monotonically increasing across the main range', () => {
    let prev = mmrToGsp(600, t);
    for (let mmr = 610; mmr <= 1400; mmr += 10) {
      const gsp = mmrToGsp(mmr, t);
      expect(gsp).toBeGreaterThan(prev);
      prev = gsp;
    }
  });
});

describe('mmrToGsp / gspToMmr — top tail (MMR > 1400)', () => {
  const t = 502;

  it('is linear beyond MMR 1400 with slope SLOPE_TOP', () => {
    const base = mmrToGsp(1400, t);
    const at1450 = mmrToGsp(1450, t);
    expect(at1450 - base).toBeCloseTo(50 * GSP_MODEL.SLOPE_TOP, 6);
  });

  it('round-trips and labels the zone "top"', () => {
    for (const mmr of [1401, 1500, 1800, 2500]) {
      const gsp = mmrToGsp(mmr, t);
      const back = gspToMmr(gsp, t);
      expect(back.zone).toBe('top');
      expect(back.mmr).toBeCloseTo(mmr, 4);
    }
  });

  it('a GSP just above gsp(1400) is classified into the top tail', () => {
    const boundaryGsp = mmrToGsp(1400, t);
    const result = gspToMmr(boundaryGsp + 1000, t);
    expect(result.zone).toBe('top');
    expect(result.mmr).toBeGreaterThan(1400);
  });
});

describe('mmrToGsp / gspToMmr — bottom tail (MMR < 600)', () => {
  const t = 502;

  it('is linear below MMR 600 with slope SLOPE_BOTTOM', () => {
    const base = mmrToGsp(600, t);
    const at550 = mmrToGsp(550, t);
    expect(base - at550).toBeCloseTo(50 * GSP_MODEL.SLOPE_BOTTOM, 6);
  });

  it('round-trips and labels the zone "bottom"', () => {
    for (const mmr of [599, 500, 200, 0]) {
      const gsp = mmrToGsp(mmr, t);
      const back = gspToMmr(gsp, t);
      expect(back.zone).toBe('bottom');
      expect(back.mmr).toBeCloseTo(mmr, 4);
    }
  });

  it('a GSP just below gsp(600) is classified into the bottom tail', () => {
    const boundaryGsp = mmrToGsp(600, t);
    const result = gspToMmr(boundaryGsp - 1000, t);
    expect(result.zone).toBe('bottom');
    expect(result.mmr).toBeLessThan(600);
  });

  it('floors t at T_MIN so degenerate t values cannot flip the curve inside out', () => {
    // A wildly-negative t (e.g. from converting an epoch-0-ish timestamp, or
    // a garbage calibration) would make ceiling(t) < A without the floor.
    const insaneT = -500_000;
    const gspAtFloor = mmrToGsp(1000, GSP_MODEL.T_MIN);
    expect(mmrToGsp(1000, insaneT)).toBeCloseTo(gspAtFloor, 6);
    const back = gspToMmr(gspAtFloor, insaneT);
    expect(back.zone).toBe('main');
    expect(back.mmr).toBeCloseTo(1000, 4);
    // Elite threshold stays sane (above A, below the t=T_MIN ceiling).
    const threshold = eliteThresholdGsp(insaneT);
    expect(threshold).toBeGreaterThan(GSP_MODEL.A);
    expect(threshold).toBeLessThan(GSP_MODEL.K);
  });

  it('handles extreme/out-of-range GSP gracefully (no throw, finite result)', () => {
    expect(() => gspToMmr(-1_000_000, t)).not.toThrow();
    expect(() => gspToMmr(0, t)).not.toThrow();
    expect(() => gspToMmr(1e12, t)).not.toThrow();
    const veryLow = gspToMmr(-1_000_000, t);
    expect(Number.isFinite(veryLow.mmr)).toBe(true);
    expect(veryLow.zone).toBe('bottom');
    const veryHigh = gspToMmr(1e12, t);
    expect(Number.isFinite(veryHigh.mmr)).toBe(true);
    expect(veryHigh.zone).toBe('top');
  });
});

describe('mmrPointsForWin / mmrPointsForWinDetailed', () => {
  it('matches every observed breakpoint from the doc verbatim', () => {
    const cases: Array<[number, number]> = [
      [600, 0], // > 533
      [533, 0],
      [500, 1], // 523..411
      [411, 1],
      [523, 1],
      [370, 2], // 394..333
      [333, 2],
      [394, 2],
      [280, 3], // 313..253
      [253, 3],
      [313, 3],
      [220, 4], // 242..207
      [207, 4],
      [242, 4],
      [175, 5], // 177..170
      [170, 5],
      [177, 5],
      [140, 6], // ~140
      [100, 7], // 108..87
      [87, 7],
      [108, 7],
      [60, 8], // 85..44
      [44, 8],
      [85, 8],
      [20, 9], // 40..7
      [7, 9],
      [40, 9],
      [0, 10], // 5..-28
      [5, 10],
      [-28, 10],
      [-45, 11], // -30..-60
      [-30, 11],
      [-60, 11],
      [-80, 12], // -68..-97
      [-68, 12],
      [-97, 12],
      [-115, 13], // ..-130
      [-130, 13],
      [-150, 14], // ..-165
      [-165, 14],
      [-200, 15], // ~-200
      [-240, 16], // -233..-251
      [-233, 16],
      [-251, 16],
      [-290, 17], // ~-290
      [-350, 18], // ..-390
    ];
    for (const [diff, expected] of cases) {
      expect(mmrPointsForWin(diff)).toBe(expected);
    }
  });

  it('reports "observed" as the source for diffs covered by the verbatim table', () => {
    expect(mmrPointsForWinDetailed(0).source).toBe('observed');
    expect(mmrPointsForWinDetailed(533).source).toBe('observed');
    expect(mmrPointsForWinDetailed(-390).source).toBe('observed');
  });

  it('the observed table takes precedence over the Elo fill where they disagree', () => {
    // At diff 533 the continuous Elo K=20 expectation is ~0.91, which would
    // round to 1 — but the doc observed 0, and observed wins.
    expect(Math.round(eloExpectedPointsForWin(533))).toBe(1);
    expect(mmrPointsForWin(533)).toBe(0);
    expect(mmrPointsForWinDetailed(533).source).toBe('observed');
  });

  it('falls back to rounded Elo K=20 and reports "elo-fill" for gaps between bands', () => {
    // -200 to -233 (exclusive) is a gap in the observed table (which only
    // has a single-point sample at -200).
    const gapDiff = -210;
    const isInObservedRow = MMR_POINTS_TABLE.some(
      (row) => gapDiff >= row.diffMin && gapDiff <= row.diffMax,
    );
    expect(isInObservedRow).toBe(false);
    const result = mmrPointsForWinDetailed(gapDiff);
    expect(result.source).toBe('elo-fill');
    expect(result.points).toBe(Math.round(eloExpectedPointsForWin(gapDiff)));
    expect(result.points).toBe(15);
  });

  it('produces 19 and 20 for huge upsets via the Elo fill (the doc gave no explicit bands)', () => {
    // The doc's tail shorthand ("..−390→18, →19, →20") has no diff ranges
    // for 19/20, so those come from the logistic fill: 19 from ~-437, 20
    // from ~-637.
    expect(mmrPointsForWin(-391)).toBe(18); // still ~18.09 on the Elo curve
    expect(mmrPointsForWinDetailed(-391).source).toBe('elo-fill');
    expect(mmrPointsForWin(-450)).toBe(19);
    expect(mmrPointsForWin(-700)).toBe(20);
  });

  it('is naturally bounded to [0, 20] for extreme diffs (logistic asymptotes)', () => {
    expect(mmrPointsForWin(100_000)).toBe(0);
    expect(mmrPointsForWin(-100_000)).toBe(20);
  });

  it('ASSUMED_MMR_POINTS_PER_MATCH is mmrPointsForWin(0) = 10 (Elo K/2 at diff 0)', () => {
    expect(ASSUMED_MMR_POINTS_PER_MATCH).toBe(mmrPointsForWin(0));
    expect(ASSUMED_MMR_POINTS_PER_MATCH).toBe(10);
    expect(eloExpectedPointsForWin(0)).toBeCloseTo(10, 10);
  });
});

describe('eloExpectedPointsForWin', () => {
  it('is exactly K/2 = 10 at diff 0', () => {
    expect(eloExpectedPointsForWin(0)).toBeCloseTo(10, 12);
  });

  it('is monotonically decreasing in diff', () => {
    let prev = eloExpectedPointsForWin(-800);
    for (let diff = -750; diff <= 800; diff += 50) {
      const val = eloExpectedPointsForWin(diff);
      expect(val).toBeLessThan(prev);
      prev = val;
    }
  });

  it('is zero-sum symmetric: elo(diff) + elo(-diff) = K', () => {
    for (const diff of [-400, -137, 0, 55, 233, 519]) {
      expect(eloExpectedPointsForWin(diff) + eloExpectedPointsForWin(-diff)).toBeCloseTo(20, 10);
    }
  });

  it('stays within 1 point of every observed table row midpoint (the validation claim)', () => {
    // The coordinator-validated claim: every observed row is within 0.9
    // points of the continuous Elo value. Check against each band midpoint
    // (using the finite edge for the half-open 0-points band).
    for (const row of MMR_POINTS_TABLE) {
      const probe = Number.isFinite(row.diffMax) ? (row.diffMin + row.diffMax) / 2 : row.diffMin;
      expect(Math.abs(eloExpectedPointsForWin(probe) - row.points)).toBeLessThan(1);
    }
  });
});

describe('projectMatchesToEliteMmr', () => {
  it('returns already-elite when currentMmr >= ELITE_MMR', () => {
    expect(projectMatchesToEliteMmr(1142, 0.6)).toEqual({ status: 'already-elite' });
    expect(projectMatchesToEliteMmr(1200, 0.9)).toEqual({ status: 'already-elite' });
  });

  it('returns equilibrium for a <=50% win rate (honest, not an error)', () => {
    expect(projectMatchesToEliteMmr(1000, 0.5)).toEqual({ status: 'equilibrium' });
    expect(projectMatchesToEliteMmr(1000, 0.4)).toEqual({ status: 'equilibrium' });
    expect(projectMatchesToEliteMmr(1000, 0)).toEqual({ status: 'equilibrium' });
  });

  it('projects a finite match count for a >50% win rate', () => {
    const result = projectMatchesToEliteMmr(1100, 0.6);
    expect(result.status).toBe('projected');
    if (result.status === 'projected') {
      // Expected net per match = (2*0.6-1)*10 ~= 2 (floating-point puts it
      // fractionally under 2, so 42 MMR needed rounds up to 22 matches via
      // Math.ceil rather than the mathematically-idealized 21).
      expect(result.matchesNeeded).toBe(22);
    }
  });

  it('caps at MAX_PROJECTED_MATCHES for a barely-above-50% win rate on a big gap', () => {
    // Very close to 50%, so expected net per match is tiny.
    const result = projectMatchesToEliteMmr(600, 0.501);
    expect(result.status).toBe('capped');
  });

  it('MAX_PROJECTED_MATCHES matches the documented cap of 2000', () => {
    expect(MAX_PROJECTED_MATCHES).toBe(2000);
  });

  it('a 100% win rate projects the fastest (fewest matches) for the same gap', () => {
    const slower = projectMatchesToEliteMmr(1100, 0.55);
    const faster = projectMatchesToEliteMmr(1100, 0.9);
    expect(slower.status).toBe('projected');
    expect(faster.status).toBe('projected');
    if (slower.status === 'projected' && faster.status === 'projected') {
      expect(faster.matchesNeeded).toBeLessThan(slower.matchesNeeded);
    }
  });
});

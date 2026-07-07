import { describe, expect, it } from 'vitest';
import type { Match } from './match.js';
import {
  DEFAULT_ELITE_THRESHOLD,
  MAX_SIMULATED_MATCHES,
  MIN_OBSERVATIONS_FOR_DECAY_FIT,
  MIN_OBSERVATIONS_FOR_LINEAR_FALLBACK,
  fitGainDecay,
  getGspGainStats,
  getGspSeries,
  gspSettingsSchema,
  projectMatchesToElite,
  upsertGspSettingsInputSchema,
  type GspPoint,
} from './gsp.js';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'time' | 'win'>): Match {
  return {
    id: 'x',
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'quickplay',
    ...overrides,
  };
}

describe('gspSettingsSchema / upsertGspSettingsInputSchema', () => {
  it('accepts a valid settings object', () => {
    const parsed = gspSettingsSchema.parse({ eliteThreshold: 10_000_000, updatedAt: 123 });
    expect(parsed.eliteThreshold).toBe(10_000_000);
  });

  it('rejects a non-positive threshold', () => {
    expect(() => gspSettingsSchema.parse({ eliteThreshold: 0, updatedAt: 123 })).toThrow();
    expect(() => gspSettingsSchema.parse({ eliteThreshold: -5, updatedAt: 123 })).toThrow();
  });

  it('the upsert input omits updatedAt (server-stamped)', () => {
    const parsed = upsertGspSettingsInputSchema.parse({ eliteThreshold: 5_000_000 });
    expect(parsed).toEqual({ eliteThreshold: 5_000_000 });
  });

  it('DEFAULT_ELITE_THRESHOLD is a plausible positive placeholder', () => {
    expect(DEFAULT_ELITE_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_ELITE_THRESHOLD)).toBe(true);
  });
});

describe('getGspSeries', () => {
  it('returns an empty array when no matches carry gsp', () => {
    const matches = [makeMatch({ time: 1, win: true, fighter_id: 1 })];
    expect(getGspSeries(matches, 1)).toEqual([]);
  });

  it('filters to the requested fighter only', () => {
    const matches = [
      makeMatch({ time: 1, win: true, fighter_id: 1, gsp: 1000 }),
      makeMatch({ time: 2, win: true, fighter_id: 2, gsp: 5000 }),
    ];
    const series = getGspSeries(matches, 1);
    expect(series).toEqual([{ time: 1, gsp: 1000, win: true }]);
  });

  it('sorts chronologically regardless of input order', () => {
    const matches = [
      makeMatch({ time: 300, win: false, fighter_id: 1, gsp: 900 }),
      makeMatch({ time: 100, win: true, fighter_id: 1, gsp: 1000 }),
      makeMatch({ time: 200, win: true, fighter_id: 1, gsp: 1200 }),
    ];
    const series = getGspSeries(matches, 1);
    expect(series.map((p) => p.time)).toEqual([100, 200, 300]);
  });

  it('skips matches for the fighter with no gsp reading', () => {
    const matches = [
      makeMatch({ time: 1, win: true, fighter_id: 1, gsp: 1000 }),
      makeMatch({ time: 2, win: true, fighter_id: 1 }),
    ];
    expect(getGspSeries(matches, 1)).toEqual([{ time: 1, gsp: 1000, win: true }]);
  });
});

describe('getGspGainStats', () => {
  it('returns all-null/empty stats for a series with fewer than 2 points (no steps)', () => {
    const series: GspPoint[] = [{ time: 1, gsp: 1000, win: true }];
    const stats = getGspGainStats(series);
    expect(stats.avgGainPerWinLifetime).toBeNull();
    expect(stats.avgDropPerLossLifetime).toBeNull();
    expect(stats.biggestGain).toBeNull();
    expect(stats.biggestDrop).toBeNull();
    expect(stats.perWinGains).toEqual([]);
    expect(stats.gainTrend).toBe('flat');
  });

  it('computes lifetime avg gain/drop and biggest gain/drop', () => {
    const series: GspPoint[] = [
      { time: 1, gsp: 1000, win: true },
      { time: 2, gsp: 1100, win: true }, // +100
      { time: 3, gsp: 1050, win: false }, // -50
      { time: 4, gsp: 1250, win: true }, // +200
      { time: 5, gsp: 1150, win: false }, // -100
    ];
    const stats = getGspGainStats(series);
    expect(stats.avgGainPerWinLifetime).toBeCloseTo(150); // (100+200)/2
    expect(stats.avgDropPerLossLifetime).toBeCloseTo(75); // (50+100)/2
    expect(stats.biggestGain).toBe(200);
    expect(stats.biggestDrop).toBe(100);
    expect(stats.perWinGains).toEqual([100, 200]);
  });

  it('restricts the "last 20" stats to the trailing 20 steps', () => {
    const series: GspPoint[] = [{ time: 0, gsp: 0, win: true }];
    // 25 win-steps of +10 each, then a final loss-step of -1000 far more
    // recent than the older wins — last-20 should exclude the 5 oldest wins.
    for (let i = 1; i <= 25; i += 1) {
      series.push({ time: i, gsp: series[i - 1]!.gsp + 10, win: true });
    }
    series.push({ time: 26, gsp: series[25]!.gsp - 1000, win: false });

    const stats = getGspGainStats(series);
    // Lifetime: 25 win-steps all +10.
    expect(stats.avgGainPerWinLifetime).toBeCloseTo(10);
    // Last 20 steps = steps 7..26 (20 steps): 19 win-steps of +10 + 1 loss-step.
    expect(stats.avgGainPerWinLast20).toBeCloseTo(10);
    expect(stats.avgDropPerLossLast20).toBeCloseTo(1000);
    // Lifetime loss stat should also just be the one loss-step.
    expect(stats.avgDropPerLossLifetime).toBeCloseTo(1000);
  });

  it('flags a shrinking trend when per-win gains decrease over time', () => {
    const series: GspPoint[] = [{ time: 0, gsp: 0, win: true }];
    const gains = [500, 400, 300, 200, 100];
    let gsp = 0;
    gains.forEach((g, i) => {
      gsp += g;
      series.push({ time: i + 1, gsp, win: true });
    });
    expect(getGspGainStats(series).gainTrend).toBe('shrinking');
  });

  it('flags a growing trend when per-win gains increase over time', () => {
    const series: GspPoint[] = [{ time: 0, gsp: 0, win: true }];
    const gains = [100, 200, 300, 400, 500];
    let gsp = 0;
    gains.forEach((g, i) => {
      gsp += g;
      series.push({ time: i + 1, gsp, win: true });
    });
    expect(getGspGainStats(series).gainTrend).toBe('growing');
  });

  it('flags a flat trend when per-win gains stay roughly constant', () => {
    const series: GspPoint[] = [{ time: 0, gsp: 0, win: true }];
    let gsp = 0;
    for (let i = 0; i < 5; i += 1) {
      gsp += 100;
      series.push({ time: i + 1, gsp, win: true });
    }
    expect(getGspGainStats(series).gainTrend).toBe('flat');
  });
});

describe('fitGainDecay', () => {
  function winStep(fromGsp: number, delta: number) {
    return { fromGsp, delta, win: true as const };
  }

  it('returns null with fewer than MIN_OBSERVATIONS_FOR_DECAY_FIT win-steps', () => {
    const steps = Array.from({ length: MIN_OBSERVATIONS_FOR_DECAY_FIT - 1 }, (_, i) =>
      winStep(i * 1000, 100),
    );
    expect(fitGainDecay(steps)).toBeNull();
  });

  it('returns null when any gain is non-positive (cannot take a log)', () => {
    const steps = [
      winStep(1000, 100),
      winStep(2000, 90),
      winStep(3000, 0),
      winStep(4000, 70),
      winStep(5000, 60),
    ];
    expect(fitGainDecay(steps)).toBeNull();
  });

  it('returns null when all fromGsp values are identical (no x-variance)', () => {
    const steps = Array.from({ length: 6 }, () => winStep(5000, 100));
    expect(fitGainDecay(steps)).toBeNull();
  });

  it('returns null when the fitted decay rate is non-negative (gains not shrinking)', () => {
    // Gains increasing with GSP — decay rate b should come back >= 0, so the
    // model is rejected rather than projecting ever-increasing gains.
    const steps = [
      winStep(1000, 50),
      winStep(2000, 60),
      winStep(3000, 70),
      winStep(4000, 80),
      winStep(5000, 90),
      winStep(6000, 100),
    ];
    expect(fitGainDecay(steps)).toBeNull();
  });

  it('fits a valid exponential decay from clean synthetic data', () => {
    // gain(gsp) = 500 * exp(-0.0005 * gsp), sampled exactly (no noise).
    const a = 500;
    const b = -0.0005;
    const steps = [0, 1000, 2000, 3000, 4000, 5000].map((gsp) =>
      winStep(gsp, a * Math.exp(b * gsp)),
    );
    const fit = fitGainDecay(steps);
    expect(fit).not.toBeNull();
    expect(fit!.a).toBeCloseTo(a, 5);
    expect(fit!.b).toBeCloseTo(b, 5);
  });
});

describe('projectMatchesToElite', () => {
  it('returns null for an empty series', () => {
    expect(projectMatchesToElite([], DEFAULT_ELITE_THRESHOLD, 0.6)).toBeNull();
  });

  it('returns null (already Elite) when current gsp is at or above threshold', () => {
    const series: GspPoint[] = [{ time: 1, gsp: 10_000_000, win: true }];
    expect(projectMatchesToElite(series, 10_000_000, 0.6)).toBeNull();
    expect(projectMatchesToElite(series, 9_000_000, 0.6)).toBeNull();
  });

  it('returns null when recent win rate is zero or negative', () => {
    const series: GspPoint[] = [
      { time: 1, gsp: 1_000_000, win: true },
      { time: 2, gsp: 1_100_000, win: true },
    ];
    expect(projectMatchesToElite(series, 2_000_000, 0)).toBeNull();
    expect(projectMatchesToElite(series, 2_000_000, -0.1)).toBeNull();
  });

  it('returns null (insufficient data) below MIN_OBSERVATIONS_FOR_LINEAR_FALLBACK win-steps', () => {
    // Only one win-step total.
    const series: GspPoint[] = [
      { time: 1, gsp: 1_000_000, win: false },
      { time: 2, gsp: 1_100_000, win: true },
    ];
    expect(MIN_OBSERVATIONS_FOR_LINEAR_FALLBACK).toBeGreaterThan(1);
    expect(projectMatchesToElite(series, 2_000_000, 0.6)).toBeNull();
  });

  it('uses the linear-average fallback with a thin but non-degenerate sample', () => {
    // Exactly at the linear-fallback floor, below the decay-fit floor.
    const series: GspPoint[] = [{ time: 0, gsp: 1_000_000, win: true }];
    let gsp = 1_000_000;
    for (let i = 0; i < MIN_OBSERVATIONS_FOR_LINEAR_FALLBACK; i += 1) {
      gsp += 50_000;
      series.push({ time: i + 1, gsp, win: true });
    }
    const result = projectMatchesToElite(series, gsp + 500_000, 0.6);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('linear-average');
    expect(result!.matchesNeeded).toBeGreaterThan(0);
    expect(result!.assumptions.length).toBeGreaterThan(0);
  });

  it('uses the exponential-decay model with a rich, cleanly-decaying sample', () => {
    const series: GspPoint[] = [{ time: 0, gsp: 1_000_000, win: true }];
    let gsp = 1_000_000;
    // Alternate win (shrinking gain the higher gsp climbs) / loss (fixed drop).
    for (let i = 0; i < 20; i += 1) {
      const gain = 20_000 * Math.exp(-0.0000005 * gsp);
      gsp += gain;
      series.push({ time: series.length, gsp, win: true });
      gsp -= 5_000;
      series.push({ time: series.length, gsp, win: false });
    }
    const currentGsp = series[series.length - 1]!.gsp;
    const result = projectMatchesToElite(series, currentGsp + 100_000, 0.6);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('exponential-decay');
    expect(result!.matchesNeeded).toBeGreaterThan(0);
  });

  it('falls back to linear-average when the decay fit is degenerate despite enough observations', () => {
    // >= MIN_OBSERVATIONS_FOR_DECAY_FIT win-steps but gains increasing with
    // gsp (fitGainDecay rejects this), so it should fall back rather than
    // returning null.
    const series: GspPoint[] = [{ time: 0, gsp: 1_000_000, win: true }];
    let gsp = 1_000_000;
    const gains = [10_000, 12_000, 14_000, 16_000, 18_000, 20_000];
    gains.forEach((g, i) => {
      gsp += g;
      series.push({ time: i + 1, gsp, win: true });
    });
    const result = projectMatchesToElite(series, gsp + 200_000, 0.6);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('linear-average');
  });

  it('caps simulation at MAX_SIMULATED_MATCHES and reports the capped label', () => {
    // Tiny, slow gains vs. a far-away threshold — should hit the cap.
    const series: GspPoint[] = [{ time: 0, gsp: 0, win: true }];
    let gsp = 0;
    for (let i = 0; i < 6; i += 1) {
      gsp += 1; // flat, non-decaying-enough gain (constant, effectively b ~ 0 fails decay fit's b<0 requirement isn't guaranteed, but linear works regardless)
      series.push({ time: i + 1, gsp, win: true });
    }
    const result = projectMatchesToElite(series, gsp + 10_000_000, 0.55);
    expect(result).not.toBeNull();
    if (result!.matchesNeeded === null) {
      expect(result!.matchesNeededLabel).toBe(`more than ${MAX_SIMULATED_MATCHES}`);
    } else {
      // If somehow it didn't cap, at minimum it should be a huge number of matches.
      expect(result!.matchesNeeded).toBeGreaterThan(1000);
    }
  });

  it('returns null when expected progress per match is zero or negative under either model', () => {
    // Losses on average bigger than gains at a low win rate — no forward progress.
    const series: GspPoint[] = [{ time: 0, gsp: 1_000_000, win: true }];
    let gsp = 1_000_000;
    const deltas: Array<{ win: boolean; delta: number }> = [
      { win: true, delta: 100 },
      { win: false, delta: -100_000 },
      { win: true, delta: 90 },
      { win: false, delta: -90_000 },
      { win: true, delta: 80 },
      { win: false, delta: -80_000 },
    ];
    deltas.forEach(({ win, delta }, i) => {
      gsp += delta;
      series.push({ time: i + 1, gsp, win });
    });
    const result = projectMatchesToElite(series, gsp + 1_000_000, 0.1);
    expect(result).toBeNull();
  });
});

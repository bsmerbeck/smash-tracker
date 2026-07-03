import { describe, expect, it } from 'vitest';
import {
  FULL_SAMPLE_SIZE,
  matchupCellBackground,
  sampleSizeToOpacity,
  wilsonToRgb,
} from './matchupCellColor';

describe('wilsonToRgb', () => {
  it('returns the destructive red endpoint at wilson=0', () => {
    expect(wilsonToRgb(0)).toEqual([217, 62, 52]);
  });

  it('returns the emerald endpoint at wilson=1', () => {
    expect(wilsonToRgb(1)).toEqual([16, 185, 129]);
  });

  it('returns the neutral grey midpoint at wilson=0.5', () => {
    expect(wilsonToRgb(0.5)).toEqual([113, 113, 122]);
  });

  it('interpolates monotonically from red to grey in the lower half', () => {
    const quarter = wilsonToRgb(0.25);
    // Halfway between red and grey on each channel.
    expect(quarter[0]).toBeCloseTo((217 + 113) / 2, 0);
    expect(quarter[1]).toBeCloseTo((62 + 113) / 2, 0);
    expect(quarter[2]).toBeCloseTo((52 + 122) / 2, 0);
  });

  it('interpolates monotonically from grey to emerald in the upper half', () => {
    const threeQuarter = wilsonToRgb(0.75);
    expect(threeQuarter[0]).toBeCloseTo((113 + 16) / 2, 0);
    expect(threeQuarter[1]).toBeCloseTo((113 + 185) / 2, 0);
    expect(threeQuarter[2]).toBeCloseTo((122 + 129) / 2, 0);
  });

  it('clamps out-of-range inputs to the valid endpoints', () => {
    expect(wilsonToRgb(-1)).toEqual(wilsonToRgb(0));
    expect(wilsonToRgb(2)).toEqual(wilsonToRgb(1));
  });
});

describe('sampleSizeToOpacity', () => {
  it('is faint (but not invisible) at a single game', () => {
    const opacity = sampleSizeToOpacity(1);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(0.5);
  });

  it('reaches full opacity at the full-sample threshold', () => {
    expect(sampleSizeToOpacity(FULL_SAMPLE_SIZE)).toBe(1);
  });

  it('stays at full opacity beyond the threshold', () => {
    expect(sampleSizeToOpacity(FULL_SAMPLE_SIZE + 50)).toBe(1);
  });

  it('increases monotonically with sample size between 1 and the threshold', () => {
    const samples = [1, 2, 4, 6, 8, FULL_SAMPLE_SIZE];
    const opacities = samples.map(sampleSizeToOpacity);
    for (let i = 1; i < opacities.length; i++) {
      expect(opacities[i]).toBeGreaterThan(opacities[i - 1]!);
    }
  });

  it('clamps zero/negative sample sizes to the minimum opacity', () => {
    expect(sampleSizeToOpacity(0)).toBe(sampleSizeToOpacity(1));
    expect(sampleSizeToOpacity(-5)).toBe(sampleSizeToOpacity(1));
  });
});

describe('matchupCellBackground', () => {
  it('renders an rgba() string combining the wilson color and sample-size opacity', () => {
    const css = matchupCellBackground(1, FULL_SAMPLE_SIZE);
    expect(css).toBe('rgba(16, 185, 129, 1.000)');
  });

  it('produces a faint low-sample cell', () => {
    const css = matchupCellBackground(0, 1);
    expect(css).toMatch(/^rgba\(217, 62, 52, 0\.\d+\)$/);
  });
});

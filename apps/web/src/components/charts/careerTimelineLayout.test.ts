import { describe, expect, it } from 'vitest';
import { CHART_TOKENS } from './tokens';
import {
  careerGamesFill,
  careerStripFill,
  careerTimelineSvgHeight,
  careerTimelineYDomain,
  clampReadoutLeft,
} from './careerTimelineLayout';

/**
 * Plan 39.1-34 (UI-SPEC §12.1, sketch 002-C `drawRating`): the timeline's
 * pure layout helpers — the fitted y-domain on 100-point hairlines (200 when
 * the span exceeds 600 or the plot is narrow), the derived strip fills and the
 * SVG height.
 */
describe('careerTimelineYDomain', () => {
  it('fits floor(min(r - rd)) .. ceil(max(r + rd)) to 100s, on 100-point steps when the span is at most 600', () => {
    const domain = careerTimelineYDomain(
      [
        { rating: 1700, rd: 80 },
        { rating: 1900, rd: 60 },
      ],
      { narrow: false },
    );
    expect(domain).toEqual({
      lo: 1600,
      hi: 2000,
      step: 100,
      ticks: [1600, 1700, 1800, 1900, 2000],
    });
  });

  it('steps by 200 when the span exceeds 600', () => {
    const domain = careerTimelineYDomain(
      [
        { rating: 1500, rd: 200 },
        { rating: 2100, rd: 50 },
      ],
      { narrow: false },
    );
    expect(domain.lo).toBe(1300);
    expect(domain.hi).toBe(2200);
    expect(domain.step).toBe(200);
    expect(domain.ticks).toEqual([1300, 1500, 1700, 1900, 2100]);
  });

  it('steps by 200 on a narrow plot even when the span is small', () => {
    const domain = careerTimelineYDomain(
      [
        { rating: 1700, rd: 80 },
        { rating: 1900, rd: 60 },
      ],
      { narrow: true },
    );
    expect(domain.step).toBe(200);
    expect(domain.ticks).toEqual([1600, 1800, 2000]);
  });
});

describe('careerStripFill / careerGamesFill — derived fills, never new tokens', () => {
  it('steps +1..+4 mix series1 at 22/42/66/94% into the surface', () => {
    [22, 42, 66, 94].forEach((percent, i) => {
      const fill = careerStripFill(i + 1);
      expect(fill).toMatch(/^color-mix\(/);
      expect(fill).toContain(`${CHART_TOKENS.series1} ${percent}%`);
      expect(fill).toContain(CHART_TOKENS.surface);
    });
  });

  it('steps -1..-4 mix series2 at the same shares', () => {
    [22, 42, 66, 94].forEach((percent, i) => {
      expect(careerStripFill(-(i + 1))).toContain(`${CHART_TOKENS.series2} ${percent}%`);
    });
  });

  it('step 0 is the neutral midpoint, derived from deemphasisStrong', () => {
    const fill = careerStripFill(0);
    expect(fill).toContain(CHART_TOKENS.deemphasisStrong);
    expect(fill).not.toContain(CHART_TOKENS.series1);
    expect(fill).not.toContain(CHART_TOKENS.series2);
  });

  it('games steps 1..5 mix series1 at 14/30/50/72/95%', () => {
    [14, 30, 50, 72, 95].forEach((percent, i) => {
      expect(careerGamesFill(i + 1)).toContain(`${CHART_TOKENS.series1} ${percent}%`);
    });
  });
});

describe('careerTimelineSvgHeight — sketch 002-C: plot bottom + strip band 48 + axis band 26', () => {
  it('294 wide / 244 narrow with strips; 246 / 196 without', () => {
    expect(careerTimelineSvgHeight({ narrow: false, strips: true })).toBe(294);
    expect(careerTimelineSvgHeight({ narrow: true, strips: true })).toBe(244);
    expect(careerTimelineSvgHeight({ narrow: false, strips: false })).toBe(246);
    expect(careerTimelineSvgHeight({ narrow: true, strips: false })).toBe(196);
  });
});

describe('clampReadoutLeft (plan 39.1-35) — the readout never leaves the card', () => {
  it('places the readout right of the anchor when it fits', () => {
    const left = clampReadoutLeft({ anchorX: 50, readoutWidth: 200, containerWidth: 400 });
    expect(left).toBeGreaterThan(50);
    expect(left + 200).toBeLessThanOrEqual(400);
  });

  it('flips it left of the anchor near the right edge', () => {
    const left = clampReadoutLeft({ anchorX: 350, readoutWidth: 200, containerWidth: 400 });
    expect(left + 200).toBeLessThan(350);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it('clamps inside the container when neither side fits', () => {
    const left = clampReadoutLeft({ anchorX: 150, readoutWidth: 280, containerWidth: 320 });
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + 280).toBeLessThanOrEqual(320);
  });

  it('a readout wider than the container clamps to 0', () => {
    expect(clampReadoutLeft({ anchorX: 200, readoutWidth: 500, containerWidth: 400 })).toBe(0);
  });
});

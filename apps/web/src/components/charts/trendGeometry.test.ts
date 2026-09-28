import { describe, expect, it } from 'vitest';

/**
 * Plan 39.1-37 (VIZ-01, UI-SPEC §7.13, sketch 001-C `trend()`; fitted-period-trend):
 * the pure geometry behind the period trend — the fitted rate domain, the
 * reference-label placement rule and the dot diameters. The module is
 * imported dynamically inside each test body so the RED run fails on an
 * assertion, not at file import (the module does not exist before GREEN).
 */
const MODULE_SPECIFIER = './trendGeometry';

type TrendGeometry = typeof import('./trendGeometry');

async function loadGeometry(): Promise<TrendGeometry> {
  // A non-literal specifier keeps Vite's import analysis from failing the
  // whole file at transform time while the module does not exist yet.
  const mod = (await import(/* @vite-ignore */ MODULE_SPECIFIER).catch(
    () => null,
  )) as TrendGeometry | null;
  expect(mod, 'trendGeometry module exists').not.toBeNull();
  return mod!;
}

describe('fitRateDomain — UI-SPEC §7.13: ± 4 pts, snapped to 10s, minimum span 20, clamped 0-100', () => {
  it('fits [48, 52, 55] to [40, 60]', async () => {
    const { fitRateDomain } = await loadGeometry();
    expect(fitRateDomain([48, 52, 55])).toEqual([40, 60]);
  });

  it('fits a single value to a 20-point span that contains it', async () => {
    const { fitRateDomain } = await loadGeometry();
    const [lo, hi] = fitRateDomain([48]);
    expect(hi - lo).toBe(20);
    expect(lo).toBeLessThanOrEqual(48);
    expect(hi).toBeGreaterThanOrEqual(48);
  });

  it('fits [2, 97] to the full [0, 100]', async () => {
    const { fitRateDomain } = await loadGeometry();
    expect(fitRateDomain([2, 97])).toEqual([0, 100]);
  });

  it('an empty input returns [0, 100]', async () => {
    const { fitRateDomain } = await loadGeometry();
    expect(fitRateDomain([])).toEqual([0, 100]);
  });

  it('widens a short span downward first, the way sketch 001-C does ([98, 99] -> [80, 100])', async () => {
    const { fitRateDomain } = await loadGeometry();
    expect(fitRateDomain([98, 99])).toEqual([80, 100]);
  });

  it('widens upward when the floor is already 0 ([1, 3] -> [0, 20])', async () => {
    const { fitRateDomain } = await loadGeometry();
    expect(fitRateDomain([1, 3])).toEqual([0, 20]);
  });

  it('clamps out-of-range input to 0-100', async () => {
    const { fitRateDomain } = await loadGeometry();
    expect(fitRateDomain([-5, 120])).toEqual([0, 100]);
  });

  it('every result is snapped to 10s, spans at least 20 and contains every input (sweep)', async () => {
    const { fitRateDomain } = await loadGeometry();
    for (let a = 0; a <= 100; a += 7) {
      for (let b = a; b <= 100; b += 11) {
        const [lo, hi] = fitRateDomain([a, b]);
        expect(lo % 10, `[${a}, ${b}] lo`).toBe(0);
        expect(hi % 10, `[${a}, ${b}] hi`).toBe(0);
        expect(hi - lo, `[${a}, ${b}] span`).toBeGreaterThanOrEqual(20);
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(hi).toBeLessThanOrEqual(100);
        expect(lo).toBeLessThanOrEqual(a);
        expect(hi).toBeGreaterThanOrEqual(b);
      }
    }
  });
});

describe('rateDomainTicks — a hairline every 10 pts, coarsened only when the plot is too short', () => {
  it('[40, 60] on a 80px value range ticks 40 / 50 / 60', async () => {
    const { rateDomainTicks } = await loadGeometry();
    expect(rateDomainTicks([40, 60], 80)).toEqual([40, 50, 60]);
  });

  it('[0, 100] on a 80px value range coarsens so no two ticks sit closer than 14px', async () => {
    const { rateDomainTicks } = await loadGeometry();
    const ticks = rateDomainTicks([0, 100], 80);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(100);
    const stepPx = (80 * (ticks[1]! - ticks[0]!)) / 100;
    expect(stepPx).toBeGreaterThanOrEqual(14);
  });
});

describe('dot diameters — owner decision 2026-09-25: sketch 001-C draws 5 / 7 / 9 px dots', () => {
  it('exports diameters 5 / 7 / 9 and the 16px reference-label clearance', async () => {
    const g = await loadGeometry();
    expect(g.PERIOD_DOT_DIAMETER_SMALL).toBe(5);
    expect(g.PERIOD_DOT_DIAMETER_MEDIUM).toBe(7);
    expect(g.PERIOD_DOT_DIAMETER_LARGE).toBe(9);
    expect(g.PERIOD_REFERENCE_LABEL_CLEARANCE_PX).toBe(16);
  });

  it('periodDotDiameter steps at 50 and 150 games', async () => {
    const { periodDotDiameter } = await loadGeometry();
    expect(periodDotDiameter(20)).toBe(5);
    expect(periodDotDiameter(49)).toBe(5);
    expect(periodDotDiameter(50)).toBe(7);
    expect(periodDotDiameter(149)).toBe(7);
    expect(periodDotDiameter(150)).toBe(9);
  });
});

/**
 * Geometry used below (a 640 x 160 hero trend): plot 65..635, the reference
 * label 21px wide ("55%"), every value label 21px wide centred on its dot and
 * drawn with its baseline 12px above the dot.
 */
const PLOT = { plotLeftPx: 65, plotRightPx: 635 };
const REF_LABEL_WIDTH = 21;

describe('placeReferenceLabel — the all-time label never overprints a value label', () => {
  it('no value label near the reference line keeps the sketch placement (right, under the line)', async () => {
    const { placeReferenceLabel } = await loadGeometry();
    expect(
      placeReferenceLabel({
        ...PLOT,
        referenceYPx: 49,
        referenceLabelWidthPx: REF_LABEL_WIDTH,
        labelledPoints: [
          { xPx: 234, yPx: 45, labelWidthPx: 21 },
          { xPx: 619, yPx: 49, labelWidthPx: 21 },
        ],
      }),
    ).toBe('insideTopRight');
  });

  it("the last labelled point's value label rising into the under-the-line slot moves the label above the line", async () => {
    const { placeReferenceLabel } = await loadGeometry();
    expect(
      placeReferenceLabel({
        ...PLOT,
        referenceYPx: 49,
        referenceLabelWidthPx: REF_LABEL_WIDTH,
        labelledPoints: [{ xPx: 619, yPx: 77, labelWidthPx: 21 }],
      }),
    ).toBe('insideBottomRight');
  });

  it('a value label straddling the line (both right slots blocked) moves the label to the left', async () => {
    const { placeReferenceLabel } = await loadGeometry();
    expect(
      placeReferenceLabel({
        ...PLOT,
        referenceYPx: 49,
        referenceLabelWidthPx: REF_LABEL_WIDTH,
        labelledPoints: [{ xPx: 619, yPx: 65, labelWidthPx: 21 }],
      }),
    ).toBe('insideTopLeft');
  });

  it('a value label at the same height but far from the right edge does not move it', async () => {
    const { placeReferenceLabel } = await loadGeometry();
    expect(
      placeReferenceLabel({
        ...PLOT,
        referenceYPx: 49,
        referenceLabelWidthPx: REF_LABEL_WIDTH,
        labelledPoints: [{ xPx: 300, yPx: 65, labelWidthPx: 21 }],
      }),
    ).toBe('insideTopRight');
  });
});

describe('rateDomainTicks — design-fidelity loop (plan 39.1-37 Task 3)', () => {
  it('never appends an off-step top tick that crowds its neighbour ([20, 90] on 80px -> 20 / 40 / 60 / 80)', async () => {
    const { rateDomainTicks } = await loadGeometry();
    expect(rateDomainTicks([20, 90], 80)).toEqual([20, 40, 60, 80]);
  });
});

/**
 * Plan 39.1-41 (PD-41-2, sketch 003 `dotSize`): scoped trends size a period
 * dot by its CONFIDENCE TIER (3-7 / 8-19 / 20+ games, the shared
 * `confidenceTierFor`) onto the module's own three diameters; the games rule
 * above (`periodDotDiameter`, the Fighter hero's) is unchanged.
 */
describe('periodDotDiameterForTier — sketch 003 dotSize (plan 39.1-41)', () => {
  it('returns 5 / 5 / 7 / 9 for totals 2 / 5 / 8 / 20, from the module diameter constants', async () => {
    const geometry = await loadGeometry();
    const {
      periodDotDiameterForTier,
      PERIOD_DOT_DIAMETER_SMALL,
      PERIOD_DOT_DIAMETER_MEDIUM,
      PERIOD_DOT_DIAMETER_LARGE,
    } = geometry;
    expect(typeof periodDotDiameterForTier).toBe('function');
    expect([2, 5, 8, 20].map((total) => periodDotDiameterForTier(total))).toEqual([
      PERIOD_DOT_DIAMETER_SMALL,
      PERIOD_DOT_DIAMETER_SMALL,
      PERIOD_DOT_DIAMETER_MEDIUM,
      PERIOD_DOT_DIAMETER_LARGE,
    ]);
    expect([2, 5, 8, 20].map((total) => periodDotDiameterForTier(total))).toEqual([5, 5, 7, 9]);
    expect(periodDotDiameterForTier(7)).toBe(5);
    expect(periodDotDiameterForTier(19)).toBe(7);
  });

  it('leaves periodDotDiameter (games thresholds) unchanged: 5 / 5 / 5 / 5 for the same totals', async () => {
    const { periodDotDiameter } = await loadGeometry();
    expect([2, 5, 8, 20].map((total) => periodDotDiameter(total))).toEqual([5, 5, 5, 5]);
  });
});

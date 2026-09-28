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

/**
 * Plan 39.1-41 fidelity loop (sketch 003 `trend()` 797-800 and CSS `.val`,
 * sketch 001-C `trend()` 475): the min label sits BELOW its dot (unless it
 * is also the max or the last), and a label whose dot is within 14/160 of
 * the value range of its top flips below and one that close to its bottom
 * flips above. Labels stay centred (the `.val.end` flip is not ported — see
 * the rewritten case below).
 */
describe('periodValueLabelPlacement — sketch 003 value labels (plan 39.1-41)', () => {
  const base = {
    valueTopPx: 29,
    valueBottomPx: 109,
    isMin: false,
    isMax: false,
    isLast: false,
  };

  it('min below, max and last above', async () => {
    const { periodValueLabelPlacement } = await loadGeometry();
    expect(periodValueLabelPlacement({ ...base, yPx: 70, isMin: true })).toEqual({
      below: true,
    });
    expect(periodValueLabelPlacement({ ...base, yPx: 70, isMax: true }).below).toBe(false);
    expect(periodValueLabelPlacement({ ...base, yPx: 70, isLast: true }).below).toBe(false);
    // A last min keeps sketch 001-C's rule (above); a min that is also the max stays above.
    expect(periodValueLabelPlacement({ ...base, yPx: 70, isMin: true, isLast: true }).below).toBe(
      false,
    );
    expect(periodValueLabelPlacement({ ...base, yPx: 70, isMin: true, isMax: true }).below).toBe(
      false,
    );
  });

  // The sketch's 14px of its 160px box, scaled: 7px on this 80px value range, 14px on 160px.
  it('flips below near the value top and above near the value bottom (14/160 of the value range)', async () => {
    const { periodValueLabelPlacement } = await loadGeometry();
    expect(periodValueLabelPlacement({ ...base, yPx: 29, isMax: true }).below).toBe(true);
    expect(periodValueLabelPlacement({ ...base, yPx: 35, isMax: true }).below).toBe(true);
    expect(periodValueLabelPlacement({ ...base, yPx: 37, isMax: true }).below).toBe(false);
    expect(periodValueLabelPlacement({ ...base, yPx: 109, isMin: true }).below).toBe(false);
    expect(periodValueLabelPlacement({ ...base, yPx: 103, isMin: true }).below).toBe(false);
    expect(periodValueLabelPlacement({ ...base, yPx: 101, isMin: true }).below).toBe(true);
    const tall = { ...base, valueTopPx: 29, valueBottomPx: 189 };
    expect(periodValueLabelPlacement({ ...tall, yPx: 42, isMax: true }).below).toBe(true);
    expect(periodValueLabelPlacement({ ...tall, yPx: 44, isMax: true }).below).toBe(false);
  });

  // REWRITTEN by plan 39.1-41's own fidelity loop (after 540912a0): the
  // sketch's `.val.end` flips labels in the last two CALENDAR slots, which on
  // sketch 003's deep data (two empty quarters at the end) leaves the 60%
  // label centred. Ported to the app's categorical periods it right-aligned
  // the 60% label across the recent band's left edge. The x-axis padding
  // already keeps a centred last label inside the plot, so labels stay
  // centred on their dots.
  it('keeps every label centred on its dot — the last periods included', async () => {
    const { periodValueLabelPlacement } = await loadGeometry();
    expect(periodValueLabelPlacement({ ...base, yPx: 70, isLast: true })).toEqual({ below: false });
    expect(Object.keys(periodValueLabelPlacement({ ...base, yPx: 70 }))).toEqual(['below']);
  });

  it('placeReferenceLabel models a below label under its dot', async () => {
    const { placeReferenceLabel } = await loadGeometry();
    // Reference at y 49: its default slot (under, right-aligned) is y 54..70.
    // A BELOW label whose dot sits at y 40 occupies y 44..60 — the slot is taken.
    expect(
      placeReferenceLabel({
        referenceYPx: 49,
        referenceLabelWidthPx: 21,
        plotLeftPx: 65,
        plotRightPx: 635,
        labelledPoints: [{ xPx: 619, yPx: 40, labelWidthPx: 21, below: true }],
      }),
    ).not.toBe('insideTopRight');
    // The same dot's label ABOVE it (y 12..28) leaves the slot free.
    expect(
      placeReferenceLabel({
        referenceYPx: 49,
        referenceLabelWidthPx: 21,
        plotLeftPx: 65,
        plotRightPx: 635,
        labelledPoints: [{ xPx: 619, yPx: 40, labelWidthPx: 21 }],
      }),
    ).toBe('insideTopRight');
  });
});

/**
 * Plan 39.1-43 (PD-43-3, sketch 001-C `trend()` / sketch 003
 * `trend(d, { height: 160 })`: the 160px trend box IS the value range, axis
 * labels outside it): plan 37's plot model moves here from TrendLine.tsx.
 */
describe('periodPlotModel / periodChartHeightForValueRange — the hero value range (plan 39.1-43)', () => {
  it('a chart sized for a 160px value range draws exactly 160px between the domain edges (240px outer box)', async () => {
    const { periodPlotModel, periodChartHeightForValueRange, PERIOD_HERO_VALUE_RANGE_PX } =
      await loadGeometry();
    expect(PERIOD_HERO_VALUE_RANGE_PX).toBe(160);
    expect(periodChartHeightForValueRange(160)).toBe(240);
    expect(periodPlotModel(periodChartHeightForValueRange(160)).valueRangePx).toBe(160);
  });

  it("pins today's CHART_H_COMPACT (160px) value range at 80px — the owner-visible flat hero trend", async () => {
    const { periodPlotModel } = await loadGeometry();
    const { CHART_H_COMPACT } = await import('./tokens');
    expect(periodPlotModel(CHART_H_COMPACT).valueRangePx).toBe(80);
  });

  it('equals the constants TrendLine used before the move for any height (top 5 + 24, bottom h - 5 - 30 - 16)', async () => {
    const { periodPlotModel, periodChartHeightForValueRange } = await loadGeometry();
    for (const height of [120, 160, 200, 240, 288, 400]) {
      const model = periodPlotModel(height);
      expect(model.valueTopPx).toBe(29);
      expect(model.valueBottomPx).toBe(height - 51);
      expect(model.valueRangePx).toBe(height - 80);
      expect(periodChartHeightForValueRange(model.valueRangePx)).toBe(height);
    }
  });
});

/**
 * Plan 39.1-43 (OOS-6, 39.1-39 whole-page review): the reference label must
 * clear every DRAWN dot — its box (centre ± (diameter / 2 + the sketch's 2px
 * `.pt` surface halo)) — as well as every value label; four slots are tried
 * (under-right, above-right, under-left, above-left) and 'none' is returned
 * when all four are taken (the head legend states the rate).
 * Geometry: the 640 x 160 PLOT above, reference at y 49, label 72px wide
 * ("48% all time"): the under-right slot is x 558..630, y 54..70; the
 * above-right x 558..630, y 28..44; the under-left x 70..142, y 54..70; the
 * above-left x 70..142, y 28..44.
 */
describe('placeReferenceLabel — dot-aware, four slots, legend fallback (plan 39.1-43, OOS-6)', () => {
  const base = {
    ...PLOT,
    referenceYPx: 49,
    referenceLabelWidthPx: 72,
    labelledPoints: [],
  };

  it('a dot meeting the under-right slot with NO value label anywhere moves the label (was insideTopRight, the observed defect)', async () => {
    const { placeReferenceLabel } = await loadGeometry();
    const position = placeReferenceLabel({
      ...base,
      dots: [{ xPx: 619, yPx: 57, diameterPx: 5 }],
    });
    expect(position).not.toBe('insideTopRight');
    expect(position).toBe('insideBottomRight');
  });

  it("the dot's 2px halo counts: a dot whose own box stops 1px short of the slot still blocks it", async () => {
    const { placeReferenceLabel } = await loadGeometry();
    // Dot 619, 50.5 (diameter 5): own box bottom 53 (the slot starts at 54), halo bottom 55.
    expect(
      placeReferenceLabel({ ...base, dots: [{ xPx: 619, yPx: 50.5, diameterPx: 5 }] }),
    ).not.toBe('insideTopRight');
    // 3px further up the halo clears it.
    expect(placeReferenceLabel({ ...base, dots: [{ xPx: 619, yPx: 47.4, diameterPx: 5 }] })).toBe(
      'insideTopRight',
    );
  });

  it('tries the slots in order: under-right, above-right, under-left, then above-left', async () => {
    const { placeReferenceLabel } = await loadGeometry();
    const underRight = { xPx: 600, yPx: 60, diameterPx: 5 };
    const aboveRight = { xPx: 600, yPx: 36, diameterPx: 5 };
    const underLeft = { xPx: 100, yPx: 60, diameterPx: 5 };
    expect(placeReferenceLabel({ ...base, dots: [underRight, aboveRight] })).toBe('insideTopLeft');
    expect(placeReferenceLabel({ ...base, dots: [underRight, aboveRight, underLeft] })).toBe(
      'insideBottomLeft',
    );
  });

  it("dots blocking all four slots return 'none'", async () => {
    const { placeReferenceLabel } = await loadGeometry();
    expect(
      placeReferenceLabel({
        ...base,
        dots: [
          { xPx: 600, yPx: 60, diameterPx: 5 },
          { xPx: 600, yPx: 36, diameterPx: 5 },
          { xPx: 100, yPx: 60, diameterPx: 5 },
          { xPx: 100, yPx: 36, diameterPx: 7 },
        ],
      }),
    ).toBe('none');
  });

  it('a hollow sub-floor dot blocks like a filled one', async () => {
    const { placeReferenceLabel } = await loadGeometry();
    const filled = placeReferenceLabel({ ...base, dots: [{ xPx: 619, yPx: 57, diameterPx: 5 }] });
    const hollow = placeReferenceLabel({
      ...base,
      dots: [{ xPx: 619, yPx: 57, diameterPx: 5, subFloor: true }],
    });
    expect(hollow).toBe(filled);
    expect(hollow).not.toBe('insideTopRight');
  });

  it('value labels and dots combine: a value label above-right and a dot under-right leave the left slot', async () => {
    const { placeReferenceLabel } = await loadGeometry();
    expect(
      placeReferenceLabel({
        ...base,
        labelledPoints: [{ xPx: 600, yPx: 50, labelWidthPx: 21 }],
        dots: [{ xPx: 600, yPx: 60, diameterPx: 5 }],
      }),
    ).toBe('insideTopLeft');
  });
});

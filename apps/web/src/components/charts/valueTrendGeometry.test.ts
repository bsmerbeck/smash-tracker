import { describe, expect, it } from 'vitest';
import {
  GUTTER_PAD_PX,
  buildValueYAxis,
  fitValueDomain,
  measureYGutterPx,
  nearestPointIndex,
  placeValueLabels,
  referencePlacement,
  valueLabelRoles,
  valueMarkKind,
} from './valueTrendGeometry';

describe('fitValueDomain (UI-SPEC §7.1)', () => {
  it('snaps the data ± 4% outward to a 1-2-5 step carrying 4–6 hairlines', () => {
    const fit = fitValueDomain([9_000_000, 9_400_000])!;
    expect(fit.ticks.length).toBeGreaterThanOrEqual(4);
    expect(fit.ticks.length).toBeLessThanOrEqual(6);
    expect(fit.domain[0]).toBeLessThanOrEqual(9_000_000 - 0.04 * 400_000 + 1e-6);
    expect(fit.domain[1]).toBeGreaterThanOrEqual(9_400_000 + 0.04 * 400_000 - 1e-6);
    expect([1, 2, 5].map((m) => m * 10 ** Math.floor(Math.log10(fit.step)))).toContain(fit.step);
    fit.ticks.forEach((tick) =>
      expect(Math.abs(tick / fit.step - Math.round(tick / fit.step))).toBeLessThan(1e-9),
    );
  });

  it('always lands 4–6 hairlines over a wide sweep of ranges (never 3 or 7)', () => {
    for (let k = 0; k < 600; k++) {
      const lo = 9_000_000 + ((k * 7919) % 2_000_000);
      const span = 10 ** ((k % 60) / 10 - 1);
      const fit = fitValueDomain([lo, lo + span])!;
      expect(fit.ticks.length, `lo=${lo} span=${span}`).toBeGreaterThanOrEqual(4);
      expect(fit.ticks.length, `lo=${lo} span=${span}`).toBeLessThanOrEqual(6);
      expect(fit.domain[0]).toBeLessThanOrEqual(lo);
      expect(fit.domain[1]).toBeGreaterThanOrEqual(lo + span);
    }
  });

  it('lets a line-placed reference join the domain and ignores an out-of-range one', () => {
    const values = [9_000_000, 9_400_000];
    const joined = fitValueDomain(values, { value: 10_300_000, placement: 'line' })!;
    expect(joined.domain[1]).toBeGreaterThanOrEqual(10_300_000);
    const outside = fitValueDomain(values, { value: 20_000_000, placement: 'above-range' })!;
    expect(outside.domain[1]).toBeLessThan(10_000_000);
  });

  it('ignores non-finite values and returns null when none are left (T-41-05)', () => {
    const fit = fitValueDomain([Number.NaN, 5, Number.POSITIVE_INFINITY, 9])!;
    expect(fit.domain[0]).toBeLessThanOrEqual(5);
    expect(fit.domain[1]).toBeGreaterThanOrEqual(9);
    expect(Number.isFinite(fit.step)).toBe(true);
    expect(fitValueDomain([Number.NaN, Number.NEGATIVE_INFINITY])).toBeNull();
    expect(fitValueDomain([])).toBeNull();
  });

  it('gives a flat series a band so the line sits inside the plot', () => {
    const fit = fitValueDomain([7_000_000, 7_000_000])!;
    expect(fit.domain[0]).toBeLessThan(7_000_000);
    expect(fit.domain[1]).toBeGreaterThan(7_000_000);
  });
});

describe('referencePlacement (DD-41-13)', () => {
  it("is 'line' only within 2x the data span of the nearest data edge", () => {
    expect(referencePlacement([9e6, 9.4e6], 9.6e6)).toBe('line');
    expect(referencePlacement([2e6, 2.1e6], 10e6)).toBe('above-range');
    expect(referencePlacement([11e6, 11.2e6], 10.3e6)).toBe('below-range');
  });

  it('keeps a reference inside the data range as a line and treats the 2x boundary as inclusive', () => {
    expect(referencePlacement([9e6, 9.4e6], 9.2e6)).toBe('line');
    expect(referencePlacement([0, 10], 30)).toBe('line');
    expect(referencePlacement([0, 10], 30.0001)).toBe('above-range');
  });

  it('ignores non-finite values', () => {
    expect(referencePlacement([Number.NaN], 5)).toBe('line');
    expect(referencePlacement([9e6, Number.NaN, 9.4e6], 9.6e6)).toBe('line');
  });
});

describe('measureYGutterPx (DD-41-14)', () => {
  it('grows with the longest formatted tick, plus the pad', () => {
    const short = measureYGutterPx(['9M', '10M']);
    const long = measureYGutterPx(['9.25M', '10.25M']);
    expect(long).toBeGreaterThan(short);
    expect(measureYGutterPx([])).toBe(GUTTER_PAD_PX);
    // 7px per ASCII character + the 8px pad.
    expect(measureYGutterPx(['10.25M'])).toBe(6 * 7 + GUTTER_PAD_PX);
  });

  it('measures ja compact ticks from the formatted strings: 1088万 is the widest and widens the gutter', () => {
    const en = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
    const ja = new Intl.NumberFormat('ja', { notation: 'compact', maximumFractionDigits: 1 });
    const values = [9_500_000, 10_880_000];
    const enTicks = values.map((v) => en.format(v));
    const jaTicks = values.map((v) => ja.format(v));
    expect(jaTicks).toContain('1088万');
    const enGutter = measureYGutterPx(enTicks);
    const jaGutter = measureYGutterPx(jaTicks);
    expect(jaGutter).toBeGreaterThan(enGutter);
    // The wider string alone decides: adding a short tick changes nothing.
    expect(measureYGutterPx([...jaTicks, '1万'])).toBe(jaGutter);
  });

  it('buildValueYAxis hands back the formatted ticks and their measured gutter', () => {
    const axis = buildValueYAxis([9_000_000, 9_400_000], (n) => `${n / 1e6}M`)!;
    expect(axis.tickLabels).toHaveLength(axis.ticks.length);
    expect(axis.gutterPx).toBe(measureYGutterPx(axis.tickLabels));
    expect(buildValueYAxis([], (n) => String(n))).toBeNull();
  });
});

describe('marks and labels', () => {
  it('draws no dot on an ordinary reading, a dot on the last, a diamond for a calibration', () => {
    const plain = { kind: 'reading' as const, containsCalibration: false };
    const calibration = { kind: 'calibration' as const, containsCalibration: true };
    expect(valueMarkKind(plain, { isLast: false, grain: 'reading' })).toBeNull();
    expect(valueMarkKind(plain, { isLast: true, grain: 'reading' })).toBe('dot');
    expect(valueMarkKind(calibration, { isLast: false, grain: 'reading' })).toBe('diamond');
    expect(valueMarkKind(calibration, { isLast: true, grain: 'reading' })).toBe('diamond');
  });

  it('draws a dot per close at a coarser grain and a diamond when the close holds a calibration', () => {
    const close = { kind: 'close' as const, containsCalibration: false };
    const withCal = { kind: 'close' as const, containsCalibration: true };
    expect(valueMarkKind(close, { isLast: false, grain: 'month' })).toBe('dot');
    expect(valueMarkKind(withCal, { isLast: false, grain: 'week' })).toBe('diamond');
  });

  it('finds the nearest point by x, earlier point on a tie', () => {
    const points = [{ xMs: 0 }, { xMs: 10 }, { xMs: 20 }];
    expect(nearestPointIndex(points, 4)).toBe(0);
    expect(nearestPointIndex(points, 5)).toBe(0);
    expect(nearestPointIndex(points, 16)).toBe(2);
    expect(nearestPointIndex([], 3)).toBe(-1);
  });

  it('labels the last always; peak and low only when distinct from last and at 3+ points', () => {
    expect(valueLabelRoles([1, 5, 2], 'last')).toEqual([{ role: 'last', index: 2 }]);
    expect(valueLabelRoles([1, 5, 2], 'last-peak-low')).toEqual([
      { role: 'last', index: 2 },
      { role: 'peak', index: 1 },
      { role: 'low', index: 0 },
    ]);
    // The last IS the peak: no second label for it; two points: no peak / low at all.
    expect(valueLabelRoles([1, 2, 5], 'last-peak-low')).toEqual([
      { role: 'last', index: 2 },
      { role: 'low', index: 0 },
    ]);
    expect(valueLabelRoles([1, 5], 'last-peak-low')).toEqual([{ role: 'last', index: 1 }]);
    expect(valueLabelRoles([], 'last')).toEqual([]);
  });

  it('drops a label that collides with an already placed one, never overlapping it', () => {
    const placed = placeValueLabels({
      candidates: [
        { role: 'last', xPx: 200, yPx: 100, text: '10,880,284' },
        { role: 'peak', xPx: 205, yPx: 100, text: '10,900,000' },
      ],
      plotLeftPx: 40,
      plotRightPx: 400,
      plotBottomPx: 200,
    });
    // `last` takes the slot above; `peak` falls to the slot below its dot; a third on the same dot has nowhere left.
    expect(placed.map((label) => label.role)).toEqual(['last', 'peak']);
    expect(placed[0]!.below).toBe(false);
    expect(placed[1]!.below).toBe(true);
    const none = placeValueLabels({
      candidates: [
        { role: 'last', xPx: 200, yPx: 100, text: '10,880,284' },
        { role: 'peak', xPx: 205, yPx: 100, text: '10,900,000' },
        { role: 'low', xPx: 210, yPx: 100, text: '10,700,000' },
      ],
      plotLeftPx: 40,
      plotRightPx: 400,
      plotBottomPx: 200,
    });
    expect(none.map((label) => label.role)).toEqual(['last', 'peak']);
  });

  it('clamps a label inside the plot edges and drops one that would leave the chart', () => {
    const [edge] = placeValueLabels({
      candidates: [{ role: 'last', xPx: 398, yPx: 100, text: '10,880,284' }],
      plotLeftPx: 40,
      plotRightPx: 400,
      plotBottomPx: 200,
    });
    expect(edge!.labelXPx).toBeLessThanOrEqual(400 - 35);
    const dropped = placeValueLabels({
      candidates: [{ role: 'peak', xPx: 100, yPx: 3, text: '1' }],
      plotLeftPx: 40,
      plotRightPx: 400,
      plotBottomPx: 6,
    });
    expect(dropped).toEqual([]);
  });
});

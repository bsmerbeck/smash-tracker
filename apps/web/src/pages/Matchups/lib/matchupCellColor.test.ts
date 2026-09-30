import { describe, expect, it } from 'vitest';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { matchupCellBackground } from './matchupCellColor';

/**
 * Plan 39.1-47 (matrix-sketch-a, sketch 003 A `matrixCard`, brief §5 M13 /
 * M15): the matrix heat is the identity series-1 hue — `color-mix(in oklch,
 * var(--viz-series-1) N%, transparent)` with N = 8 + win rate (0-100) x 0.5 —
 * and NOTHING under the abstention floor. Replaces the red -> grey -> emerald
 * interpolation and its sample-size opacity band (`rateToRgb`,
 * `sampleSizeToOpacity`, `FULL_SAMPLE_SIZE`): win / loss colour belongs to
 * win / loss marks only, and confidence is the sub-floor outline, not opacity.
 */

const MIX = /^color-mix\(in oklch, var\(--viz-series-1\) (\d+)%, transparent\)$/;

function mixPercent(css: string): number {
  const match = MIX.exec(css);
  if (!match) throw new Error(`not a series-1 colour mix: ${css}`);
  return Number(match[1]);
}

describe('matchupCellBackground (matrix-sketch-a)', () => {
  it('mixes the series-1 token by win rate: 8% at a 0% rate, 58% at a 100% rate', () => {
    expect(matchupCellBackground(0, 10)).toBe(
      'color-mix(in oklch, var(--viz-series-1) 8%, transparent)',
    );
    expect(matchupCellBackground(1, 10)).toBe(
      'color-mix(in oklch, var(--viz-series-1) 58%, transparent)',
    );
    expect(matchupCellBackground(0.5, 10)).toBe(
      'color-mix(in oklch, var(--viz-series-1) 33%, transparent)',
    );
  });

  it('rounds the percentage to an integer, like the sketch', () => {
    // 2 of 3: 8 + 66.67 x 0.5 = 41.33 -> 41.
    expect(mixPercent(matchupCellBackground(2 / 3, 3))).toBe(41);
    // 7 of 9: 8 + 77.78 x 0.5 = 46.89 -> 47.
    expect(mixPercent(matchupCellBackground(7 / 9, 9))).toBe(47);
  });

  it('increases monotonically with win rate at a fixed sample', () => {
    const rates = [0, 0.2, 0.4, 0.6, 0.8, 1];
    const percents = rates.map((rate) => mixPercent(matchupCellBackground(rate, 20)));
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThan(percents[i - 1]!);
    }
  });

  it('does not depend on the sample size at or above the floor (confidence is not an opacity here)', () => {
    expect(matchupCellBackground(0.75, ABSTENTION_FLOOR_GAMES)).toBe(
      matchupCellBackground(0.75, 200),
    );
  });

  it('is transparent — no heat — under the 3-game floor, whatever the rate', () => {
    expect(ABSTENTION_FLOOR_GAMES).toBe(3);
    for (const total of [0, 1, 2]) {
      expect(matchupCellBackground(1, total)).toBe('transparent');
      expect(matchupCellBackground(0, total)).toBe('transparent');
    }
    expect(matchupCellBackground(1, 3)).not.toBe('transparent');
  });

  it('clamps an out-of-range rate to the 8-58% band', () => {
    expect(mixPercent(matchupCellBackground(-1, 10))).toBe(8);
    expect(mixPercent(matchupCellBackground(2, 10))).toBe(58);
  });

  it('draws only the series token — no rgb() literal and no status hue', () => {
    const css = matchupCellBackground(0.3, 12);
    expect(css).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}|emerald|destructive|red|green/i);
  });
});

/**
 * `MatchupMatrix.tsx`'s cell button renders its record text in
 * `text-foreground` over this heat composited on the card surface. WCAG 2.1
 * relative-luminance contrast, computed independently here (not imported from
 * the component) so this oracle can never share a bug with the code it
 * checks. The series-1 blue and the card / foreground surfaces are the sRGB
 * values of `--viz-series-1` (`oklch(0.62 0.17 255)`), `--card`
 * (`oklch(0.205 0.006 285)`) and `--foreground` (`oklch(0.97 0 0)`) from
 * `index.css`, resolved with `guardPaletteCore.oklchToHex`.
 */
describe('WCAG contrast: text-foreground over the composited series heat (matrix-sketch-a)', () => {
  const SERIES_SRGB: [number, number, number] = [0x31, 0x86, 0xe9];
  const CARD_SRGB: [number, number, number] = [0x17, 0x17, 0x1a];
  const FOREGROUND_SRGB: [number, number, number] = [0xf5, 0xf5, 0xf5];

  function srgbChannelToLinear(channel: number): number {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  function relativeLuminance([r, g, b]: [number, number, number]): number {
    return (
      0.2126 * srgbChannelToLinear(r) +
      0.7152 * srgbChannelToLinear(g) +
      0.0722 * srgbChannelToLinear(b)
    );
  }

  function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
    const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (lighter! + 0.05) / (darker! + 0.05);
  }

  function compositedCell(rate: number, total: number): [number, number, number] {
    const alpha = mixPercent(matchupCellBackground(rate, total)) / 100;
    return [
      SERIES_SRGB[0] * alpha + CARD_SRGB[0] * (1 - alpha),
      SERIES_SRGB[1] * alpha + CARD_SRGB[1] * (1 - alpha),
      SERIES_SRGB[2] * alpha + CARD_SRGB[2] * (1 - alpha),
    ];
  }

  for (const rate of [0, 0.25, 0.5, 0.75, 1]) {
    for (const total of [3, 5, 10, 50]) {
      it(`clears 4.5:1 at rate=${rate} total=${total}`, () => {
        expect(contrastRatio(FOREGROUND_SRGB, compositedCell(rate, total))).toBeGreaterThanOrEqual(
          4.5,
        );
      });
    }
  }

  it('the oracle is not vacuous: the same ink on a saturated series fill would fail 4.5:1', () => {
    expect(contrastRatio(FOREGROUND_SRGB, SERIES_SRGB)).toBeLessThan(4.5);
  });
});

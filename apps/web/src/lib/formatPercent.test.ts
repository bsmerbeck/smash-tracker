import { describe, expect, it } from 'vitest';
import { formatPercent } from './formatPercent';

describe('formatPercent', () => {
  it('WR-C05: formats the French convention with a space before the sign, not the English "42%" glued form', () => {
    const fr = formatPercent(0.42, 'fr');
    expect(fr).not.toBe('42%');
    // CLDR's "fr" percent convention places a space (narrow no-break in full
    // ICU data, regular space on Node's small-icu build) before the sign —
    // this is a real, locale-driven difference from "en"'s glued "42%",
    // which is exactly the class of difference `Math.round(x*100)+'%'` could
    // never produce.
    expect(/\s%$/.test(fr)).toBe(true);
  });

  it('formats the English convention with no space before the sign', () => {
    expect(formatPercent(0.42, 'en')).toBe('42%');
  });

  it('rounds to the nearest whole percent', () => {
    expect(formatPercent(0.4249, 'en')).toBe('42%');
    expect(formatPercent(0.4251, 'en')).toBe('43%');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatCompact,
  formatDate,
  formatDaySpan,
  formatGrouped,
  formatMonthName,
  formatSigned,
} from '@/lib/format';

/**
 * 41-01 (D1 / DD-41-15): the one formatter module. Every expectation below is the verified ICU
 * output (41-RESEARCH §"i18n — facts, guard design, formatting").
 */

describe('formatGrouped', () => {
  it('groups digits in the explicit locale', () => {
    expect(formatGrouped(10880284, 'en')).toBe('10,880,284');
    expect(formatGrouped(10880284, 'de')).toBe('10.880.284');
  });

  it('E10: an unknown locale does not throw and still yields a grouped figure', () => {
    const out = formatGrouped(1234, 'zz');
    expect(out.replace(/\D/g, '')).toBe('1234');
  });
});

describe('formatCompact', () => {
  it('uses one fraction digit by default', () => {
    expect(formatCompact(9500000, 'en')).toBe('9.5M');
    expect(formatCompact(9500000, 'de')).toBe('9,5\u00a0Mio.');
    expect(formatCompact(9500000, 'ja')).toBe('950万');
  });

  it("derives the fraction digits from the step hint (the step's own decimals in the figure's unit)", () => {
    expect(formatCompact(9250000, 'en', { stepHint: 250000 })).toBe('9.25M');
    expect(formatCompact(9500000, 'en', { stepHint: 500000 })).toBe('9.5M');
    expect(formatCompact(10020000, 'en', { stepHint: 20000 })).toBe('10.02M');
    expect(formatCompact(10005000, 'en', { stepHint: 5000 })).toBe('10.005M');
    expect(formatCompact(10000000, 'en', { stepHint: 1000000 })).toBe('10M');
    expect(formatCompact(10020000, 'ja', { stepHint: 20000 })).toBe('1002万');
  });

  // 41-REVIEW CR-02: adjacent ticks never share a label, in every shipped locale, over the step ladder
  // `fitValueDomain` can pick on GSP-sized values (10.01M-10.08M sits on a 20,000 step).
  it('CR-02: six adjacent ticks on any 1-2-5 step print six distinct labels in all six locales', () => {
    const steps = [500, 1_000, 2_000, 2_500, 5_000, 10_000, 20_000, 25_000, 50_000, 100_000];
    const bases = [9_000_000, 10_000_000, 10_010_000, 12_345_000, 950_000, 1_995_000];
    for (const locale of ['en', 'es', 'fr', 'de', 'pt', 'ja']) {
      for (const step of [...steps, 250_000, 500_000, 1_000_000, 2_000_000]) {
        for (const base of bases) {
          const start = Math.floor(base / step) * step;
          const labels = Array.from({ length: 6 }, (_, i) =>
            formatCompact(start + i * step, locale, { stepHint: step }),
          );
          expect(new Set(labels).size, `${locale} step ${step} from ${start}: ${labels}`).toBe(6);
        }
      }
    }
  });
});

describe('formatSigned', () => {
  it('prefixes U+2212 (never the hyphen-minus) to a negative figure', () => {
    const out = formatSigned(-5, 'en');
    expect(out.charCodeAt(0)).toBe(8722);
    expect(out.endsWith('5')).toBe(true);
    expect(out).not.toContain('-');
  });

  it('IN-04: a figure that rounds to zero is a bare 0, never -0 or +0', () => {
    expect(formatSigned(-0.4, 'en')).toBe('0');
    expect(formatSigned(0.4, 'en')).toBe('0');
    expect(formatSigned(-0, 'en')).toBe('0');
    expect(formatSigned(-0.6, 'en')).toBe('\u22121');
    expect(formatSigned(0.6, 'en')).toBe('+1');
  });

  it('prefixes + to a positive grouped figure and leaves zero bare', () => {
    expect(formatSigned(1234, 'en')).toBe('+1,234');
    expect(formatSigned(0, 'en')).toBe('0');
  });
});

describe('formatDate / formatDaySpan', () => {
  const day1 = new Date(2025, 2, 3, 9).getTime();
  const day1Evening = new Date(2025, 2, 3, 21).getTime();
  const day2 = new Date(2025, 2, 20, 12).getTime();

  it('orders a date the way the locale does', () => {
    expect(formatDate(day1, 'en')).toBe('3/3/2025');
    expect(formatDate(day2, 'en')).toBe('3/20/2025');
    expect(formatDate(day2, 'de')).toBe('20.3.2025');
  });

  it('a same-day span is one date with no separator', () => {
    expect(formatDaySpan(day1, day1Evening, 'en')).toBe(formatDate(day1, 'en'));
  });

  it('a multi-day span is the locale range form', () => {
    const en = formatDaySpan(day1, day2, 'en');
    const de = formatDaySpan(day1, day2, 'de');
    expect(en).toContain('3/3/2025');
    expect(en).toContain('3/20/2025');
    // ICU collapses the shared month and pads the days in the de range form.
    expect(de).toContain('20.03.2025');
    expect(en).not.toBe(de);
  });
});

describe('formatMonthName', () => {
  it('names the month in the locale, never shifted by the host zone', () => {
    expect(formatMonthName(1, 'ja', 'short')).toBe('1月');
    expect(formatMonthName(3, 'de', 'long')).toBe('März');
    expect(formatMonthName(12, 'en', 'short')).toBe('Dec');
  });
});

describe('formatter cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs one Intl.NumberFormat per (kind, locale, options) and reuses it', () => {
    const Original = Intl.NumberFormat;
    const spy = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (
      ...args: ConstructorParameters<typeof Original>
    ) {
      return new Original(...args);
    } as unknown as typeof Intl.NumberFormat);
    const first = formatGrouped(1234567, 'sv');
    const second = formatGrouped(7654321, 'sv');
    expect(first).not.toBe(second);
    expect(spy).toHaveBeenCalledTimes(1);
    formatGrouped(1, 'sv');
    expect(spy).toHaveBeenCalledTimes(1);
    formatGrouped(1, 'nb');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it } from 'vitest';
import { formatMonthSpan } from '@/lib/dateSpan';

/**
 * Plan 39.1-44 Task 1 (pairing-hero): sketch 003's `fmtSpan` — "Mar 2021 – Jun
 * 2026" — as a pure, locale-aware formatter. Dates are built in the HOST-LOCAL
 * zone (the results list's rule), mid-month so a zone offset never moves a
 * month.
 */
const MAR_2021 = new Date(2021, 2, 13, 12).getTime();
const JUN_2026 = new Date(2026, 5, 20, 12).getTime();

describe('formatMonthSpan', () => {
  it('prints "Mon YYYY – Mon YYYY" with the caller-supplied separator', () => {
    expect(formatMonthSpan(MAR_2021, JUN_2026, 'en', ' – ')).toBe('Mar 2021 – Jun 2026');
    expect(formatMonthSpan(MAR_2021, JUN_2026, 'en', ' → ')).toBe('Mar 2021 → Jun 2026');
  });

  it('collapses a span inside one month to that month alone', () => {
    const early = new Date(2026, 5, 2, 12).getTime();
    const late = new Date(2026, 5, 28, 12).getTime();
    expect(formatMonthSpan(early, late, 'en', ' – ')).toBe('Jun 2026');
  });

  it('collapses one instant to its month', () => {
    expect(formatMonthSpan(JUN_2026, JUN_2026, 'en', ' – ')).toBe('Jun 2026');
  });

  it('does not collapse the same month in two different years', () => {
    const junLastYear = new Date(2025, 5, 20, 12).getTime();
    expect(formatMonthSpan(junLastYear, JUN_2026, 'en', ' – ')).toBe('Jun 2025 – Jun 2026');
  });

  it('returns the locale month forms for de and ja', () => {
    const de = formatMonthSpan(MAR_2021, JUN_2026, 'de', ' – ');
    expect(de).toContain('2021');
    expect(de).toContain('2026');
    expect(de).toContain(' – ');
    const ja = formatMonthSpan(MAR_2021, JUN_2026, 'ja', ' – ');
    expect(ja).toContain('2021年');
    expect(ja).toContain('2026年');
  });

  it('orders an inverted pair oldest first', () => {
    expect(formatMonthSpan(JUN_2026, MAR_2021, 'en', ' – ')).toBe('Mar 2021 – Jun 2026');
  });
});

import type { TFunction } from 'i18next';

const WEEK_KEY = /^week:(\d{4})-W(\d{1,2})$/;
const MONTH_KEY = /^month:(\d{4})-(\d{2})$/;
const QUARTER_KEY = /^quarter:(\d{4})-Q([1-4])$/;
const YEAR_KEY = /^year:(\d{4})$/;
const MAX_ISO_WEEK = 53;

/**
 * UAT 39.1-27a (F4): the words for a calendar-period drill key — the trend
 * `PeriodPoint.key` shapes `week:2024-W31`, `month:2024-05`, `quarter:2024-Q2`
 * and `year:2024` (packages/shared periodSeries). Months and years print in
 * the UTC calendar the period engine buckets by; week and quarter reuse the
 * career timeline's `analytics.timeline.period.*` copy. Any other key — a
 * session, set, game or named-event key, or a malformed calendar key — is
 * `undefined`, so the caller keeps its own description.
 */
export function calendarPeriodLabel(key: string, t: TFunction, locale: string): string | undefined {
  const week = WEEK_KEY.exec(key);
  if (week) {
    const weekNumber = Number(week[2]);
    if (weekNumber < 1 || weekNumber > MAX_ISO_WEEK) return undefined;
    return t('analytics.timeline.period.week', { year: week[1], week: weekNumber });
  }
  const month = MONTH_KEY.exec(key);
  if (month) {
    const monthIndex = Number(month[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) return undefined;
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(Date.UTC(Number(month[1]), monthIndex, 1));
  }
  const quarter = QUARTER_KEY.exec(key);
  if (quarter) {
    return t('analytics.timeline.period.quarter', {
      year: quarter[1],
      quarter: Number(quarter[2]),
    });
  }
  const year = YEAR_KEY.exec(key);
  if (year) {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }).format(
      Date.UTC(Number(year[1]), 0, 1),
    );
  }
  return undefined;
}

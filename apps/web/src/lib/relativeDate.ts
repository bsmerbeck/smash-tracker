import type { TFunction } from 'i18next';

/**
 * Minimal relative-date formatter, originally built for the group
 * leaderboard's "last active" column and reused (V7-B.1) for the Scout
 * page's "Generated <relative date>" line on a persisted AI report — the
 * codebase has no date library dependency (elsewhere it uses
 * `toLocaleDateString()` for absolute dates), so this is a small,
 * dependency-free helper rather than pulling one in for a single column.
 * Takes `t` so the units come out of the active locale.
 */
export function formatRelativeDate(epochMs: number, t: TFunction, now = Date.now()): string {
  const diffMs = now - epochMs;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) {
    return t('shared.relativeDate.justNow');
  }
  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute);
    return t('shared.relativeDate.minutesAgo', { count: minutes });
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return t('shared.relativeDate.hoursAgo', { count: hours });
  }
  const days = Math.floor(diffMs / day);
  if (days < 30) {
    return t('shared.relativeDate.daysAgo', { count: days });
  }
  return new Date(epochMs).toLocaleDateString();
}

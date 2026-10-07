import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { formatRelativeDate } from './relativeDate';

const NOW = 1_700_000_000_000;

describe('formatRelativeDate', () => {
  it('returns "just now" for under a minute', () => {
    expect(formatRelativeDate(NOW - 30 * 1000, i18n.t, 'en', NOW)).toBe('just now');
  });

  it('returns minutes for under an hour', () => {
    expect(formatRelativeDate(NOW - 5 * 60 * 1000, i18n.t, 'en', NOW)).toBe('5m ago');
  });

  it('returns hours for under a day', () => {
    expect(formatRelativeDate(NOW - 3 * 60 * 60 * 1000, i18n.t, 'en', NOW)).toBe('3h ago');
  });

  it('returns days for under 30 days', () => {
    expect(formatRelativeDate(NOW - 5 * 24 * 60 * 60 * 1000, i18n.t, 'en', NOW)).toBe('5d ago');
  });

  it('falls back to an absolute date at 30+ days', () => {
    const epochMs = NOW - 40 * 24 * 60 * 60 * 1000;
    // 2023-10-05 noon-ish UTC: same calendar day in every host zone.
    expect(formatRelativeDate(epochMs, i18n.t, 'en-US', NOW)).toBe('10/5/2023');
    expect(formatRelativeDate(epochMs, i18n.t, 'de-DE', NOW)).toBe('5.10.2023');
  });
});

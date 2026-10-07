import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { calendarPeriodLabel } from './periodKeyLabel';

const t = i18n.getFixedT('en');

describe('calendarPeriodLabel (UAT 39.1-27a F4)', () => {
  it('labels a quarter key by its year and quarter', () => {
    expect(calendarPeriodLabel('quarter:2024-Q2', t, 'en')).toBe('2024 Q2');
  });

  it('labels an ISO week key by its year and week number', () => {
    expect(calendarPeriodLabel('week:2024-W31', t, 'en')).toBe('2024 W31');
    expect(calendarPeriodLabel('week:2024-W05', t, 'en')).toBe('2024 W5');
  });

  it('labels a month key in the UTC calendar month it names, in the given locale', () => {
    expect(calendarPeriodLabel('month:2024-05', t, 'en')).toBe(
      new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        Date.UTC(2024, 4, 1),
      ),
    );
    expect(calendarPeriodLabel('month:2024-01', t, 'de')).toBe(
      new Intl.DateTimeFormat('de', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        Date.UTC(2024, 0, 1),
      ),
    );
  });

  it('labels a year key by its year', () => {
    expect(calendarPeriodLabel('year:2024', t, 'en')).toBe('2024');
  });

  it('returns undefined for every non-calendar key and every malformed calendar key', () => {
    for (const key of [
      'session:2024-05-01',
      'game:abc',
      'sgg:78234561',
      'eventSession:Genesis',
      'Ultimate Singles',
      'quarter:2024-Q5',
      'month:2024-13',
      'week:2024-W54',
      'year:24',
      'quarter:',
    ]) {
      expect(calendarPeriodLabel(key, t, 'en'), key).toBeUndefined();
    }
  });
});

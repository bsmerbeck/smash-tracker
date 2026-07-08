import { describe, expect, it } from 'vitest';
import { parseGspInput } from './parseGspInput';

describe('parseGspInput', () => {
  it('parses "6.3m" shorthand as 6,300,000', () => {
    expect(parseGspInput('6.3m')).toBe(6_300_000);
  });

  it('parses "6.3M" (uppercase) the same way', () => {
    expect(parseGspInput('6.3M')).toBe(6_300_000);
  });

  it('parses whole-number "m" shorthand', () => {
    expect(parseGspInput('10m')).toBe(10_000_000);
  });

  it('parses "k" shorthand', () => {
    expect(parseGspInput('300k')).toBe(300_000);
  });

  it('still parses plain and comma-separated integers via parseGspNumber', () => {
    expect(parseGspInput('10300000')).toBe(10_300_000);
    expect(parseGspInput('10,300,000')).toBe(10_300_000);
  });

  it('rejects invalid input', () => {
    expect(parseGspInput('abc')).toBeNull();
    expect(parseGspInput('')).toBeNull();
    expect(parseGspInput('-5m')).toBeNull();
  });
});

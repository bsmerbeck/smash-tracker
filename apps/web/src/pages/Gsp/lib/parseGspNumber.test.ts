import { describe, expect, it } from 'vitest';
import { parseGspNumber } from './parseGspNumber';

describe('parseGspNumber', () => {
  it('parses plain integers', () => {
    expect(parseGspNumber('10300000')).toBe(10_300_000);
  });

  it('parses comma-separated values as copied from elitegsp.com', () => {
    expect(parseGspNumber('10,300,000')).toBe(10_300_000);
  });

  it('parses space-separated values', () => {
    expect(parseGspNumber('10 300 000')).toBe(10_300_000);
    expect(parseGspNumber(' 10,300,000 ')).toBe(10_300_000);
  });

  it('allows zero (matchRecordSchema permits gsp = 0)', () => {
    expect(parseGspNumber('0')).toBe(0);
  });

  it('rejects non-numeric, negative, decimal, and empty input', () => {
    expect(parseGspNumber('')).toBeNull();
    expect(parseGspNumber('abc')).toBeNull();
    expect(parseGspNumber('10,300,000gsp')).toBeNull();
    expect(parseGspNumber('-5')).toBeNull();
    expect(parseGspNumber('10.3')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { ordinalSuffix, formatOrdinal, formatOpponentEventContext } from './ordinal';

describe('ordinalSuffix', () => {
  it('returns "st" for numbers ending in 1 (except 11)', () => {
    expect(ordinalSuffix(1)).toBe('st');
    expect(ordinalSuffix(21)).toBe('st');
    expect(ordinalSuffix(101)).toBe('st');
  });

  it('returns "nd" for numbers ending in 2 (except 12)', () => {
    expect(ordinalSuffix(2)).toBe('nd');
    expect(ordinalSuffix(22)).toBe('nd');
  });

  it('returns "rd" for numbers ending in 3 (except 13)', () => {
    expect(ordinalSuffix(3)).toBe('rd');
    expect(ordinalSuffix(23)).toBe('rd');
  });

  it('returns "th" for the 11-13 teens regardless of last digit', () => {
    expect(ordinalSuffix(11)).toBe('th');
    expect(ordinalSuffix(12)).toBe('th');
    expect(ordinalSuffix(13)).toBe('th');
    expect(ordinalSuffix(111)).toBe('th');
    expect(ordinalSuffix(112)).toBe('th');
    expect(ordinalSuffix(113)).toBe('th');
  });

  it('returns "th" for everything else', () => {
    expect(ordinalSuffix(0)).toBe('th');
    expect(ordinalSuffix(4)).toBe('th');
    expect(ordinalSuffix(129)).toBe('th');
  });
});

describe('formatOrdinal', () => {
  it('formats a number with its ordinal suffix', () => {
    expect(formatOrdinal(1)).toBe('1st');
    expect(formatOrdinal(129)).toBe('129th');
    expect(formatOrdinal(2)).toBe('2nd');
    expect(formatOrdinal(3)).toBe('3rd');
  });
});

describe('formatOpponentEventContext', () => {
  it('formats both seed and placement when present', () => {
    expect(formatOpponentEventContext({ seed: 56, placement: 129 })).toBe('seed 56 · placed 129th');
  });

  it('formats seed alone when placement is absent', () => {
    expect(formatOpponentEventContext({ seed: 56 })).toBe('seed 56');
  });

  it('formats placement alone when seed is absent', () => {
    expect(formatOpponentEventContext({ placement: 129 })).toBe('placed 129th');
  });

  it('returns null when both are absent', () => {
    expect(formatOpponentEventContext({})).toBeNull();
  });
});

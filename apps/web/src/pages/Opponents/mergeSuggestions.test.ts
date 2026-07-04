import { describe, expect, it } from 'vitest';
import {
  isNearMissSuggestion,
  isPrefixRelation,
  levenshteinDistance,
  rankMergeSuggestions,
} from './mergeSuggestions';

describe('levenshteinDistance', () => {
  it('is 0 for identical strings', () => {
    expect(levenshteinDistance('rival', 'rival')).toBe(0);
  });

  it('handles an empty string', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('counts a single substitution', () => {
    expect(levenshteinDistance('rival', 'rivbl')).toBe(1);
  });

  it('counts a single insertion/deletion', () => {
    expect(levenshteinDistance('rival', 'rivals')).toBe(1);
    expect(levenshteinDistance('rivals', 'rival')).toBe(1);
  });

  it('computes a larger distance for dissimilar strings', () => {
    expect(levenshteinDistance('rival', 'zzzzz')).toBe(5);
  });
});

describe('isPrefixRelation', () => {
  it('is true when one name is a prefix of the other', () => {
    expect(isPrefixRelation('riv', 'rival')).toBe(true);
    expect(isPrefixRelation('rival', 'riv')).toBe(true);
  });

  it('is false for unrelated names', () => {
    expect(isPrefixRelation('rival', 'zeta')).toBe(false);
  });

  it('is false for empty strings', () => {
    expect(isPrefixRelation('', 'rival')).toBe(false);
    expect(isPrefixRelation('rival', '')).toBe(false);
  });
});

describe('isNearMissSuggestion', () => {
  it('is true within edit distance 2', () => {
    expect(isNearMissSuggestion('rival', 'rivals')).toBe(true); // distance 1
    expect(isNearMissSuggestion('rival', 'rivvle')).toBe(true); // distance 2
  });

  it('is true for a prefix relation even with a large edit distance', () => {
    expect(isNearMissSuggestion('riv', 'rivalofsomekind')).toBe(true);
  });

  it('is false for unrelated names', () => {
    expect(isNearMissSuggestion('rival', 'completelydifferentname')).toBe(false);
  });

  it('is false comparing a name to itself', () => {
    expect(isNearMissSuggestion('rival', 'rival')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isNearMissSuggestion('Rival', 'rival')).toBe(false); // same after lowering
    expect(isNearMissSuggestion('RIVAL', 'rivals')).toBe(true);
  });
});

describe('rankMergeSuggestions', () => {
  it('puts near-miss candidates first, ordered by ascending distance', () => {
    const result = rankMergeSuggestions('rival', ['zeta', 'rivals', 'rival2', 'unrelated']);
    // rivals: distance 1; rival2: distance 1 (substitution) -- alphabetical tiebreak
    expect(result.slice(0, 2).sort()).toEqual(['rival2', 'rivals'].sort());
    expect(result).toContain('zeta');
    expect(result).toContain('unrelated');
  });

  it('excludes the name itself from the candidate list', () => {
    const result = rankMergeSuggestions('rival', ['rival', 'zeta']);
    expect(result).not.toContain('rival');
  });

  it('preserves original relative order for non-suggestions', () => {
    const result = rankMergeSuggestions('rival', ['bravo', 'alpha', 'charlie']);
    expect(result).toEqual(['bravo', 'alpha', 'charlie']);
  });

  it('returns an empty array when there are no other candidates', () => {
    expect(rankMergeSuggestions('rival', [])).toEqual([]);
    expect(rankMergeSuggestions('rival', ['rival'])).toEqual([]);
  });
});

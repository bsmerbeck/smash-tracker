import { describe, expect, it } from 'vitest';
import { CLAIM_CODE_ALPHABET, CLAIM_CODE_LENGTH, CLAIM_CODE_TTL_MS } from '@smash-tracker/shared';
import {
  claimCodeExpiresAt,
  formatClaimCode,
  generateClaimCode,
  hashClaimCode,
  normalizeClaimCode,
} from './crypto.js';

describe('generateClaimCode', () => {
  it('returns a string of exactly CLAIM_CODE_LENGTH characters, all in CLAIM_CODE_ALPHABET', () => {
    const code = generateClaimCode();
    expect(code).toHaveLength(CLAIM_CODE_LENGTH);
    for (const char of code) {
      expect(CLAIM_CODE_ALPHABET).toContain(char);
    }
  });

  it('contains no separator characters', () => {
    const code = generateClaimCode();
    expect(code).not.toContain('-');
    expect(code).not.toContain(' ');
  });

  it('produces 200 distinct values across 200 successive calls', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateClaimCode()));
    expect(codes.size).toBe(200);
  });
});

describe('formatClaimCode', () => {
  it('formats a 26-character code as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X (31 chars, 5 hyphens)', () => {
    const code = generateClaimCode();
    const formatted = formatClaimCode(code);
    expect(formatted).toHaveLength(31);
    expect(formatted.split('-')).toHaveLength(6);
    expect(formatted).toMatch(
      /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{1}$/,
    );
  });
});

describe('normalizeClaimCode', () => {
  it('round-trips through the display form', () => {
    const code = generateClaimCode();
    expect(normalizeClaimCode(formatClaimCode(code))).toBe(code);
  });

  it('returns the uppercase canonical form for a lowercase input', () => {
    const code = generateClaimCode();
    expect(normalizeClaimCode(code.toLowerCase())).toBe(code);
  });

  it('strips whitespace and hyphens', () => {
    expect(normalizeClaimCode('  abc de-fgh ')).toBe('ABCDEFGH');
  });

  it('folds Crockford ambiguities: O/o -> 0, I/i -> 1, L/l -> 1', () => {
    expect(normalizeClaimCode('OoIiLl')).toBe('001111');
  });

  it('returns the empty string for fully malformed input rather than throwing', () => {
    expect(() => normalizeClaimCode('!!!@@@')).not.toThrow();
    expect(normalizeClaimCode('!!!@@@')).toBe('');
  });
});

describe('hashClaimCode', () => {
  it('returns a 64-character lowercase hex string', () => {
    const hash = hashClaimCode('secret-a', 'ABC');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same secret and input', () => {
    expect(hashClaimCode('secret-a', 'ABC')).toBe(hashClaimCode('secret-a', 'ABC'));
  });

  it('differs when the secret differs', () => {
    expect(hashClaimCode('secret-a', 'ABC')).not.toBe(hashClaimCode('secret-b', 'ABC'));
  });
});

describe('claimCodeExpiresAt', () => {
  it('returns nowMs + CLAIM_CODE_TTL_MS', () => {
    expect(claimCodeExpiresAt(1000)).toBe(1000 + CLAIM_CODE_TTL_MS);
  });
});

import { describe, expect, it } from 'vitest';
import { CLAIM_CODE_LENGTH } from '@smash-tracker/shared';
import {
  countSignificantClaimCodeChars,
  formatClaimCodeForDisplay,
  normalizeClaimCodeInput,
} from './claimCodeFormat';

describe('formatClaimCodeForDisplay', () => {
  it('groups a full 26-character code into five groups of five plus a trailing single', () => {
    expect(formatClaimCodeForDisplay('ABCDEFGHJKMNPQRSTVWXYZ0123')).toBe(
      'ABCDE-FGHJK-MNPQR-STVWX-YZ012-3',
    );
  });

  it('returns an empty string for empty input', () => {
    expect(formatClaimCodeForDisplay('')).toBe('');
  });

  it('normalises before grouping (lowercase, separators stripped)', () => {
    expect(formatClaimCodeForDisplay('abcde-fghjk')).toBe('ABCDE-FGHJK');
  });
});

describe('normalizeClaimCodeInput', () => {
  it('uppercases and strips separators and out-of-alphabet characters', () => {
    expect(normalizeClaimCodeInput('abcde-fghjk ')).toBe('ABCDEFGHJK');
  });

  it('folds Crockford ambiguities I/L->1, O->0, mirroring the server exactly', () => {
    // Mirrors the server's normalizeClaimCode precisely: I and L fold to 1,
    // O folds to 0, and U (excluded from the true Crockford alphabet the
    // server uses) is dropped rather than remapped — it is never folded to
    // any other symbol.
    expect(normalizeClaimCodeInput('ILOU')).toBe('110');
  });

  it('never throws and never truncates for garbage input', () => {
    expect(() => normalizeClaimCodeInput('!!!@@@')).not.toThrow();
    expect(normalizeClaimCodeInput('!!!@@@')).toBe('');
  });
});

describe('countSignificantClaimCodeChars', () => {
  it('counts alphabet-significant characters after normalisation', () => {
    expect(countSignificantClaimCodeChars('abcde-fghjk')).toBe(10);
  });

  it('returns CLAIM_CODE_LENGTH for a full 26-significant-character input', () => {
    expect(countSignificantClaimCodeChars('ABCDEFGHJKMNPQRSTVWXYZ0123')).toBe(CLAIM_CODE_LENGTH);
  });
});

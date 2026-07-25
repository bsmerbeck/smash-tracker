import { describe, expect, it } from 'vitest';
import {
  activeClaimInvitationPointerSchema,
  CLAIM_CODE_ALPHABET,
  CLAIM_CODE_LENGTH,
  CLAIM_CODE_TTL_MS,
  claimInvitationRecordSchema,
  redeemClaimRequestSchema,
} from './claims.js';

describe('CLAIM_CODE_ALPHABET', () => {
  it('has length 32 and excludes I, L, O, U while keeping 0 and 1', () => {
    expect(CLAIM_CODE_ALPHABET).toHaveLength(32);
    expect(CLAIM_CODE_ALPHABET).not.toContain('I');
    expect(CLAIM_CODE_ALPHABET).not.toContain('L');
    expect(CLAIM_CODE_ALPHABET).not.toContain('O');
    expect(CLAIM_CODE_ALPHABET).not.toContain('U');
    expect(CLAIM_CODE_ALPHABET).toContain('0');
    expect(CLAIM_CODE_ALPHABET).toContain('1');
  });
});

describe('CLAIM_CODE_LENGTH', () => {
  it('yields 130 bits of entropy against CLAIM_CODE_ALPHABET', () => {
    expect(CLAIM_CODE_LENGTH * Math.log2(CLAIM_CODE_ALPHABET.length)).toBe(130);
  });
});

describe('CLAIM_CODE_TTL_MS', () => {
  it('equals 72 hours in milliseconds', () => {
    expect(CLAIM_CODE_TTL_MS).toBe(72 * 60 * 60 * 1000);
  });
});

describe('claimInvitationRecordSchema', () => {
  it('parses a record with only the required fields present', () => {
    const result = claimInvitationRecordSchema.safeParse({
      tenantId: 'tenant-1',
      issuerUid: 'uid-1',
      createdAt: 1,
      expiresAt: 2,
    });
    expect(result.success).toBe(true);
  });

  it('parses the same record with nullish fields explicitly null (RTDB round-trip parity)', () => {
    const result = claimInvitationRecordSchema.safeParse({
      tenantId: 'tenant-1',
      issuerUid: 'uid-1',
      createdAt: 1,
      expiresAt: 2,
      revokedAt: null,
      consumedAt: null,
      consumedByUid: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an object missing tenantId', () => {
    const result = claimInvitationRecordSchema.safeParse({
      issuerUid: 'uid-1',
      createdAt: 1,
      expiresAt: 2,
    });
    expect(result.success).toBe(false);
  });
});

describe('redeemClaimRequestSchema', () => {
  it('accepts a 31-character grouped code string and trims surrounding whitespace', () => {
    const grouped = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-3';
    expect(grouped).toHaveLength(31);
    const result = redeemClaimRequestSchema.safeParse({ code: `  ${grouped}  ` });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe(grouped);
    }
  });

  it('rejects an empty string', () => {
    expect(redeemClaimRequestSchema.safeParse({ code: '' }).success).toBe(false);
  });

  it('rejects a 200-character string', () => {
    expect(redeemClaimRequestSchema.safeParse({ code: 'A'.repeat(200) }).success).toBe(false);
  });
});

describe('activeClaimInvitationPointerSchema', () => {
  it('parses { digest, issuedAt }', () => {
    const result = activeClaimInvitationPointerSchema.safeParse({
      digest: 'abc123',
      issuedAt: 1,
    });
    expect(result.success).toBe(true);
  });
});

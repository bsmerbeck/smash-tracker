import { describe, expect, it } from 'vitest';
import { CHECKOUT_PREP_REASON, checkoutRequestSchema } from './billing.js';

describe('checkoutRequestSchema', () => {
  it('accepts a body with only packId (attemptId optional, deploy-first client compatibility)', () => {
    const result = checkoutRequestSchema.safeParse({ packId: 'pack5' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attemptId).toBeUndefined();
    }
  });

  it('accepts a body with packId + attemptId', () => {
    const result = checkoutRequestSchema.safeParse({ packId: 'pack15', attemptId: 'attempt-1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attemptId).toBe('attempt-1');
    }
  });

  it('rejects an empty-string attemptId', () => {
    const result = checkoutRequestSchema.safeParse({ packId: 'pack5', attemptId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown packId', () => {
    const result = checkoutRequestSchema.safeParse({ packId: 'pack1000' });
    expect(result.success).toBe(false);
  });
});

/**
 * Phase 27: the validated checkout return-destination contract
 * (checkoutReturnToSchema/entryKey cross-validation, RESEARCH Pitfall 4).
 */
describe('checkoutRequestSchema — Phase 27 return destination', () => {
  it("accepts a body with only packId — today's clients are unaffected", () => {
    const result = checkoutRequestSchema.safeParse({ packId: 'pack5' });
    expect(result.success).toBe(true);
  });

  it('accepts returnTo: "prep" with an entryKey', () => {
    const result = checkoutRequestSchema.safeParse({
      packId: 'pack5',
      returnTo: 'prep',
      entryKey: 'e1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects returnTo: "prep" without an entryKey', () => {
    const result = checkoutRequestSchema.safeParse({ packId: 'pack5', returnTo: 'prep' });
    expect(result.success).toBe(false);
  });

  it('rejects an entryKey without returnTo: "prep"', () => {
    const result = checkoutRequestSchema.safeParse({ packId: 'pack5', entryKey: 'e1' });
    expect(result.success).toBe(false);
  });

  it('rejects an entryKey containing an RTDB-illegal path character', () => {
    const result = checkoutRequestSchema.safeParse({
      packId: 'pack5',
      returnTo: 'prep',
      entryKey: 'a/b',
    });
    expect(result.success).toBe(false);
  });
});

describe('CHECKOUT_PREP_REASON', () => {
  it('is exactly "prep_purchase"', () => {
    expect(CHECKOUT_PREP_REASON).toBe('prep_purchase');
  });
});

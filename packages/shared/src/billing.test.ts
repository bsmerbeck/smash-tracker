import { describe, expect, it } from 'vitest';
import { checkoutRequestSchema } from './billing.js';

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

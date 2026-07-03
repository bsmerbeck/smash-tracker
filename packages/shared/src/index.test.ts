import { describe, expect, it } from 'vitest';
import { healthCheckSchema } from './index.js';

describe('healthCheckSchema', () => {
  it('parses a valid health check payload', () => {
    expect(healthCheckSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
  });

  it('rejects an invalid status', () => {
    expect(() => healthCheckSchema.parse({ status: 'bad' })).toThrow();
  });
});

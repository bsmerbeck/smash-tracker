import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { createQueryClient, shouldRetryQuery } from './queryClient';

describe('shouldRetryQuery', () => {
  it('never retries a 4xx ApiError (deterministic answer, not transient)', () => {
    for (const status of [400, 401, 404, 409]) {
      expect(shouldRetryQuery(0, new ApiError(status, 'nope'))).toBe(false);
    }
  });

  it('retries 5xx ApiErrors up to the budget', () => {
    const error = new ApiError(503, 'unavailable');
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(2, error)).toBe(true);
    expect(shouldRetryQuery(3, error)).toBe(false);
  });

  it('retries network-level errors up to the budget', () => {
    const error = new TypeError('Failed to fetch');
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(3, error)).toBe(false);
  });
});

describe('createQueryClient', () => {
  it('applies the retry predicate and a nonzero staleTime as defaults', () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions().queries!;
    expect(defaults.retry).toBe(shouldRetryQuery);
    expect(defaults.staleTime).toBeGreaterThan(0);
  });
});

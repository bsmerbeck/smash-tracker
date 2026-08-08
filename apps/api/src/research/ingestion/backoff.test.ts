import { describe, expect, it } from 'vitest';
import { StartggApiError } from '../../startgg/client.js';
import { BACKOFF_MAX_MS, assessStartggFailure, resolveBackoffDelayMs } from './backoff.js';

describe('resolveBackoffDelayMs', () => {
  it('honors a delta-seconds Retry-After header', () => {
    expect(resolveBackoffDelayMs('30', 0)).toBe(30_000);
  });

  it('honors a zero-second Retry-After header rather than treating it as absent', () => {
    expect(resolveBackoffDelayMs('0', 0)).toBe(0);
  });

  it('clamps an oversized delta-seconds header to the configured maximum', () => {
    expect(resolveBackoffDelayMs('99999', 0)).toBe(BACKOFF_MAX_MS);
  });

  it('honors an HTTP-date header two seconds in the future, given an injected clock', () => {
    const nowMs = Date.parse('2026-01-01T00:00:00Z');
    const future = new Date(nowMs + 2000).toUTCString();
    const delay = resolveBackoffDelayMs(future, 0, { now: () => nowMs });
    expect(delay).toBeGreaterThanOrEqual(1900);
    expect(delay).toBeLessThanOrEqual(2100);
  });

  it('returns 0, never negative, for an HTTP-date header in the past', () => {
    const nowMs = Date.parse('2026-01-01T00:00:00Z');
    const past = new Date(nowMs - 5000).toUTCString();
    expect(resolveBackoffDelayMs(past, 0, { now: () => nowMs })).toBe(0);
  });

  it('falls through to the exponential branch for an unparseable header', () => {
    const delay = resolveBackoffDelayMs('not-a-number', 2, { random: () => 0 });
    // attempt 2, random 0: base * 2^2 = 4x base.
    expect(delay).toBe(4000);
  });

  it('returns the exact doubled base delay per attempt with random 0', () => {
    expect(resolveBackoffDelayMs(null, 0, { random: () => 0 })).toBe(1000);
    expect(resolveBackoffDelayMs(null, 1, { random: () => 0 })).toBe(2000);
    expect(resolveBackoffDelayMs(null, 2, { random: () => 0 })).toBe(4000);
  });

  it('never overflows or returns NaN/Infinity for a huge attempt count, random 0', () => {
    const delay = resolveBackoffDelayMs(undefined, 20, { random: () => 0 });
    expect(delay).toBe(BACKOFF_MAX_MS);
  });

  it('never exceeds BACKOFF_MAX_MS for a huge attempt count even with maximal jitter (review C-L4)', () => {
    const delay = resolveBackoffDelayMs(undefined, 20, { random: () => 1 });
    expect(delay).toBe(BACKOFF_MAX_MS);
  });

  it('applies jitter before the final clamp for an unclamped base case', () => {
    // attempt 0, random 1: exponential = 1000 (intermediate-clamped),
    // jitter = 1 * 1000 * 0.2 = 200, total 1200 — below max, unclamped.
    const delay = resolveBackoffDelayMs(null, 0, { random: () => 1 });
    expect(delay).toBe(1200);
  });

  it('never returns a delay greater than BACKOFF_MAX_MS across the whole suite', () => {
    const cases: [string | null | undefined, number][] = [
      ['30', 0],
      ['0', 0],
      ['99999', 0],
      ['not-a-number', 2],
      [null, 0],
      [null, 1],
      [null, 2],
      [undefined, 20],
      [undefined, 0],
      [undefined, 100],
    ];
    for (const random of [0, 0.5, 1]) {
      for (const [header, attempt] of cases) {
        const delay = resolveBackoffDelayMs(header, attempt, { random: () => random });
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      }
    }
  });
});

describe('assessStartggFailure', () => {
  it('classifies a 429 status as rate-limited', () => {
    const error = new StartggApiError('start.gg API returned 429', 429, '30');
    const result = assessStartggFailure(error);
    expect(result.isRateLimited).toBe(true);
    expect(result.retryAfter).toBe('30');
    expect(result.complexityRejected).toBe(false);
  });

  it('classifies a rate-limit-message body even without a 429 status', () => {
    const error = new StartggApiError(
      'start.gg API returned 400',
      400,
      undefined,
      '{"success":false,"message":"Rate limit exceeded - api-token"}',
    );
    expect(assessStartggFailure(error).isRateLimited).toBe(true);
  });

  it('classifies a complexity rejection carried on responseBody with an unrelated message', () => {
    const error = new StartggApiError(
      'start.gg API returned 400',
      400,
      undefined,
      '{"success":false,"fields":null,"message":"Query complexity too high... (actual: 1235)"}',
    );
    const result = assessStartggFailure(error);
    expect(result.complexityRejected).toBe(true);
    expect(result.isRateLimited).toBe(false);
  });

  it('reports neither classification for an ordinary provider error', () => {
    const error = new StartggApiError('start.gg API returned 500', 500);
    const result = assessStartggFailure(error);
    expect(result.isRateLimited).toBe(false);
    expect(result.complexityRejected).toBe(false);
  });

  it('reports neither classification for a non-StartggApiError', () => {
    const result = assessStartggFailure(new Error('boom'));
    expect(result.isRateLimited).toBe(false);
    expect(result.complexityRejected).toBe(false);
    expect(result.retryAfter).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  computeP95Ms,
  buildFilterChangeToPaintResult,
  buildHeapDeltaResult,
  bytesToMb,
} from './scl01BrowserBudgetCore.mjs';

describe('budgetFor', () => {
  it('finds a known budget id', () => {
    expect(budgetFor('filter-change-to-paint-8k').target).toBe(200);
    expect(budgetFor('heap-delta-50k').target).toBe(150);
  });

  it('throws for an unknown id', () => {
    expect(() => budgetFor('not-a-real-budget-id')).toThrow(/missing SCL-01 budget/);
  });
});

describe('computeP95Ms', () => {
  it('is nearest-rank over the sample set, not a mean', () => {
    expect(computeP95Ms([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
    expect(computeP95Ms([10, 1, 2, 9, 3, 8, 4, 7, 5, 6])).toBe(10); // order-independent
  });
});

describe('buildFilterChangeToPaintResult', () => {
  it('PASSes when the p95 is at or below the 200ms target', () => {
    const samples = Array.from({ length: 20 }, () => 50);
    const result = buildFilterChangeToPaintResult(samples);
    expect(result.id).toBe('filter-change-to-paint-8k');
    expect(result.target).toBe(200);
    expect(result.measured).toBe(50);
    expect(result.verdict).toBe('PASS');
    expect(result.line).toBe(
      'SCL-01 filter-change-to-paint-8k target=200ms measured=50ms verdict=PASS',
    );
  });

  it('MISSes when the p95 exceeds the 200ms target', () => {
    const samples = Array.from({ length: 20 }, () => 500);
    const result = buildFilterChangeToPaintResult(samples);
    expect(result.verdict).toBe('MISS');
  });

  it('a measured value exactly equal to the target PASSes (<=, never <)', () => {
    const samples = Array.from({ length: 20 }, () => 200);
    const result = buildFilterChangeToPaintResult(samples);
    expect(result.measured).toBe(200);
    expect(result.verdict).toBe('PASS');
  });
});

describe('buildHeapDeltaResult', () => {
  it('reports the MAX sample, not an average, as the measured figure', () => {
    const result = buildHeapDeltaResult([10, 90, 40]);
    expect(result.measured).toBe(90);
    expect(result.id).toBe('heap-delta-50k');
    expect(result.target).toBe(150);
    expect(result.verdict).toBe('PASS');
  });

  it('MISSes when the max sample exceeds the 150MB target', () => {
    const result = buildHeapDeltaResult([10, 200, 40]);
    expect(result.verdict).toBe('MISS');
  });
});

describe('bytesToMb', () => {
  it('converts bytes to megabytes using 1024-based units', () => {
    expect(bytesToMb(1024 * 1024)).toBe(1);
    expect(bytesToMb(150 * 1024 * 1024)).toBe(150);
  });
});

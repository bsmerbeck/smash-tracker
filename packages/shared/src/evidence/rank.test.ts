import { describe, expect, it } from 'vitest';
import { rankByWilson, wilsonLowerBound } from './rank.js';

describe('wilsonLowerBound', () => {
  it('is 0 for an empty sample', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('matches the closed-form values already asserted for these inputs pre-promotion (value-identical relocation)', () => {
    // p=1, n=1, z=1.96
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.2065, 3);
    // p=0.8, n=15
    expect(wilsonLowerBound(12, 15)).toBeCloseTo(0.5481, 3);
    // p=0.5, n=100
    expect(wilsonLowerBound(50, 100)).toBeCloseTo(0.4038, 3);
  });

  it('never lets a small perfect sample outrank a large strong one', () => {
    expect(wilsonLowerBound(1, 1)).toBeLessThan(wilsonLowerBound(12, 15));
  });

  it('is monotonic in sample size at a fixed rate', () => {
    expect(wilsonLowerBound(5, 10)).toBeLessThan(wilsonLowerBound(50, 100));
  });
});

describe('rankByWilson (EVID-02/ordering)', () => {
  it('sorts descending by wilson bound, ties broken by larger total then ascending numeric key', () => {
    const rows = [
      { key: 5, wins: 8, total: 10 },
      { key: 1, wins: 8, total: 10 },
      { key: 3, wins: 1, total: 1 },
    ];
    const ranked = rankByWilson(
      rows,
      (r) => r.wins,
      (r) => r.total,
      (r) => r.key,
    );
    // key 1 and key 5 tie on wilson AND total -> ascending key breaks it: 1
    // before 5. key 3's thin 1-0 record has a lower wilson bound than the
    // proven 8-2 records, so it ranks last.
    expect(ranked.map((r) => r.key)).toEqual([1, 5, 3]);
  });

  it('produces the same order regardless of input order (total order, EVID-02/ordering)', () => {
    const rowsA = [
      { key: 2, wins: 4, total: 10 },
      { key: 1, wins: 4, total: 10 },
    ];
    const rowsB = [
      { key: 1, wins: 4, total: 10 },
      { key: 2, wins: 4, total: 10 },
    ];
    const keyOf = (r: { key: number; wins: number; total: number }) => r.key;
    const winsOf = (r: { key: number; wins: number; total: number }) => r.wins;
    const totalOf = (r: { key: number; wins: number; total: number }) => r.total;
    expect(rankByWilson(rowsA, winsOf, totalOf, keyOf).map((r) => r.key)).toEqual(
      rankByWilson(rowsB, winsOf, totalOf, keyOf).map((r) => r.key),
    );
  });

  it('supports a string key (the opponent-identity axis)', () => {
    const rows = [
      { key: 'zeta', wins: 6, total: 10 },
      { key: 'alpha', wins: 6, total: 10 },
    ];
    const ranked = rankByWilson(
      rows,
      (r) => r.wins,
      (r) => r.total,
      (r) => r.key,
    );
    // Tied wilson and total -> ascending string key: 'alpha' before 'zeta'.
    expect(ranked.map((r) => r.key)).toEqual(['alpha', 'zeta']);
  });
});

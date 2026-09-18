import { describe, expect, it } from 'vitest';
import { pickBanSplit, PICK_BAN_COUNT } from './pickBan.js';

describe('pickBanSplit (D-15)', () => {
  it('over six ranked items returns three picks and three bans, disjoint, bans worst-first', () => {
    const ranked = [1, 2, 3, 4, 5, 6];
    const { picks, bans } = pickBanSplit(ranked);
    expect(picks).toEqual([1, 2, 3]);
    expect(bans).toEqual([6, 5, 4]);
    expect(picks.filter((p) => bans.includes(p))).toEqual([]);
  });

  it('over four ranked items returns three picks and exactly one ban', () => {
    const { picks, bans } = pickBanSplit([1, 2, 3, 4]);
    expect(picks).toEqual([1, 2, 3]);
    expect(bans).toEqual([4]);
  });

  it('over three ranked items returns three picks and zero bans', () => {
    const { picks, bans } = pickBanSplit([1, 2, 3]);
    expect(picks).toEqual([1, 2, 3]);
    expect(bans).toEqual([]);
  });

  it('over an empty list returns two empty lists', () => {
    const { picks, bans } = pickBanSplit([]);
    expect(picks).toEqual([]);
    expect(bans).toEqual([]);
  });

  it('over two ranked items returns both as picks and zero bans (too few for a disjoint tail)', () => {
    const { picks, bans } = pickBanSplit([1, 2]);
    expect(picks).toEqual([1, 2]);
    expect(bans).toEqual([]);
  });

  it('PICK_BAN_COUNT is 3 — the value both the pick slice and the ban cap size against', () => {
    expect(PICK_BAN_COUNT).toBe(3);
  });
});

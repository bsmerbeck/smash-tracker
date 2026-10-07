import { describe, expect, it, vi } from 'vitest';
import {
  carriedOverrides,
  classifyStoredOverride,
  withoutOverrides,
  withoutUnreadableOverrides,
} from './tournamentOverrides.js';

/**
 * 39.2 code review API-WR-02: the ONE stored-override policy every writer
 * (start.gg sync, parry.gg sync, reconcile) and the GET reader share.
 */
describe('classifyStoredOverride', () => {
  it('absent for null and undefined', () => {
    expect(classifyStoredOverride('tierOverride', undefined)).toBe('absent');
    expect(classifyStoredOverride('rulesetOverride', null)).toBe('absent');
  });

  it('valid when the stored schema reads it, whatever its contract version', () => {
    expect(
      classifyStoredOverride('tierOverride', { contractVersion: 1, tier: 'major', setAtMs: 1 }),
    ).toBe('valid');
    expect(
      classifyStoredOverride('tierOverride', {
        contractVersion: 2,
        tier: 'major',
        setAtMs: 1,
        reason: 'r',
      }),
    ).toBe('valid');
    expect(classifyStoredOverride('rulesetOverride', { contractVersion: 1, dsr: 'none' })).toBe(
      'valid',
    );
  });

  it('future-contract when unreadable but stamped with a newer contract version', () => {
    expect(
      classifyStoredOverride('tierOverride', { contractVersion: 2, tier: 'premier', setAtMs: 1 }),
    ).toBe('future-contract');
    expect(classifyStoredOverride('rulesetOverride', { contractVersion: 9, dsr: 'x' })).toBe(
      'future-contract',
    );
  });

  it('invalid for anything else', () => {
    expect(
      classifyStoredOverride('tierOverride', { contractVersion: 1, tier: 'premier', setAtMs: 1 }),
    ).toBe('invalid');
    expect(classifyStoredOverride('tierOverride', { contractVersion: 1, tier: 'major' })).toBe(
      'invalid',
    );
    expect(classifyStoredOverride('tierOverride', { contractVersion: 2.5, tier: 'x' })).toBe(
      'invalid',
    );
    expect(classifyStoredOverride('tierOverride', 'garbage')).toBe('invalid');
    expect(classifyStoredOverride('rulesetOverride', [1])).toBe('invalid');
  });
});

describe('carriedOverrides', () => {
  it('carries valid and future-contract members byte-for-byte and reports each dropped member', () => {
    const tierOverride = { contractVersion: 2, tier: 'major', setAtMs: 1, reason: 'r' };
    const onDropped = vi.fn();

    const carried = carriedOverrides(
      { eventName: 'x', tierOverride, rulesetOverride: { contractVersion: 1, dsr: 'bogus' } },
      onDropped,
    );

    expect(carried).toEqual({ tierOverride });
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith('rulesetOverride');
  });

  it('carries nothing from a non-object', () => {
    expect(carriedOverrides(null)).toEqual({});
    expect(carriedOverrides('x')).toEqual({});
    expect(carriedOverrides([{ tierOverride: {} }])).toEqual({});
  });
});

describe('withoutUnreadableOverrides', () => {
  it('omits every member the stored schema cannot read and reports why, keeping the rest', () => {
    const readable = { contractVersion: 1, dsr: 'none' };

    const { row, omitted } = withoutUnreadableOverrides({
      eventName: 'x',
      tierOverride: { contractVersion: 2, tier: 'premier', setAtMs: 1 },
      rulesetOverride: readable,
    });

    expect(row).toEqual({ eventName: 'x', rulesetOverride: readable });
    expect(omitted).toEqual([{ member: 'tierOverride', status: 'future-contract' }]);
  });

  it('returns a non-object unchanged', () => {
    expect(withoutUnreadableOverrides('x')).toEqual({ row: 'x', omitted: [] });
  });
});

describe('withoutOverrides', () => {
  it('drops both members and nothing else, without mutating its input', () => {
    const input = { eventName: 'x', tierOverride: {}, rulesetOverride: {} };
    expect(withoutOverrides(input)).toEqual({ eventName: 'x' });
    expect(input).toHaveProperty('tierOverride');
  });
});

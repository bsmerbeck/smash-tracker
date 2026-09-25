import { describe, expect, it } from 'vitest';
import type { Match } from '../match.js';
import { describeCohort } from './cohort.js';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function matches(specs: Array<{ type?: string; source?: 'startgg' | 'parrygg' }>): Match[] {
  return specs.map((spec, i) =>
    makeMatch({
      id: `m${i}`,
      time: i,
      win: true,
      matchType: (spec.type ?? 'none') as Match['matchType'],
      ...(spec.source ? { source: spec.source } : {}),
    }),
  );
}

describe('describeCohort (EVID-02, D-10)', () => {
  it('flags mixedContext for 3 online / 1 offline (share 0.25, inclusive boundary)', () => {
    const composition = describeCohort(
      matches([
        { type: 'quickplay' },
        { type: 'quickplay' },
        { type: 'quickplay' },
        { type: 'offline-friendly' },
      ]),
    );
    expect(composition.online).toBe(3);
    expect(composition.offline).toBe(1);
    expect(composition.mixedContext).toBe(true);
    expect(composition.minorityLabel).toBe('offline');
    expect(composition.minorityShare).toBeCloseTo(0.25);
  });

  it('does not flag mixedContext for 10 online / 0 offline (single-bucket axis)', () => {
    const composition = describeCohort(
      matches(Array.from({ length: 10 }, () => ({ type: 'quickplay' }))),
    );
    expect(composition.mixedContext).toBe(false);
    expect(composition.minorityLabel).toBeNull();
  });

  it('is exclusive-below the boundary: a share just under 0.25 is not mixed', () => {
    // 5 online, 1 offline -> share 1/6 ≈ 0.1667, below the threshold.
    const composition = describeCohort(
      matches([
        { type: 'quickplay' },
        { type: 'quickplay' },
        { type: 'quickplay' },
        { type: 'quickplay' },
        { type: 'quickplay' },
        { type: 'offline-friendly' },
      ]),
    );
    expect(composition.mixedContext).toBe(false);
  });

  it('buckets an absent source as manual, and startgg/parrygg by exact equality', () => {
    const composition = describeCohort(
      matches([{ source: 'startgg' }, { source: 'parrygg' }, {}, {}]),
    );
    expect(composition.startgg).toBe(1);
    expect(composition.parrygg).toBe(1);
    expect(composition.manual).toBe(2);
  });

  it('flags mixedContext via the source axis when a non-dominant source clears the threshold', () => {
    // 3 startgg, 1 manual -> manual share 0.25, mixed via the source axis.
    const composition = describeCohort(
      matches([{ source: 'startgg' }, { source: 'startgg' }, { source: 'startgg' }, {}]),
    );
    expect(composition.mixedContext).toBe(true);
    expect(composition.minorityLabel).toBe('manual');
    expect(composition.majorityLabel).toBe('startgg');
  });

  it('returns an all-one-cohort fixture as mixedContext false on both axes', () => {
    const composition = describeCohort(
      matches(Array.from({ length: 5 }, () => ({ type: 'quickplay' }))),
    );
    expect(composition.mixedContext).toBe(false);
    expect(composition.online).toBe(5);
    expect(composition.manual).toBe(5);
  });

  it('handles an empty sample without throwing', () => {
    const composition = describeCohort([]);
    expect(composition).toMatchObject({
      online: 0,
      offline: 0,
      unspecified: 0,
      manual: 0,
      startgg: 0,
      parrygg: 0,
      mixedContext: false,
      minorityShare: 0,
      minorityLabel: null,
      majorityLabel: null,
    });
  });
});

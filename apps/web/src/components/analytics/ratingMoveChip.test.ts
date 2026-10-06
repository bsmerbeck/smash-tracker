import { describe, expect, it } from 'vitest';
import type { Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { buildRatingMoveChipView } from './ratingMoveChip';

const t = i18n.t.bind(i18n);
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

describe('buildRatingMoveChipView (plan 35-05)', () => {
  it('a rising history from a losing baseline reads up, with the rating unit and horizon', () => {
    // Plan 39.1-53: this case used an 8-game account whose last-30 window held
    // every game; that window now collapses (UAT 39.1-17), so the rising read
    // runs over 60 older losses and a 30-game recent block instead.
    const matches = [
      ...Array.from({ length: 60 }, (_, i) =>
        makeMatch({ id: `l${i}`, time: NOW - (400 * 24 - i) * HOUR_MS, win: false }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        makeMatch({ id: `w${i}`, time: NOW - (10 * 24 - i) * HOUR_MS, win: i !== 5 }),
      ),
    ];
    const { insight, chipView } = buildRatingMoveChipView({
      matches,
      horizon: 'last30',
      nowMs: NOW,
      t,
    });
    expect(insight?.state).toBe('trend');
    expect(chipView?.state).toBe('up');
    expect(chipView?.valueLabel).toBe(`+${insight?.deltaPoints}`);
    expect(chipView?.horizonLabel).toBe('last 30');
  });

  it('plan 39.1-53: an 8-game account whose last-30 window holds every game shows no direction', () => {
    const matches = Array.from({ length: 8 }, (_, i) =>
      makeMatch({ id: `w${i}`, time: NOW - (10 * 24 - i) * HOUR_MS, win: i !== 5 }),
    );
    const { insight, chipView } = buildRatingMoveChipView({
      matches,
      horizon: 'last30',
      nowMs: NOW,
      t,
    });
    expect(insight?.state).toBe('collapsed');
    expect(insight?.deltaPoints).toBeNull();
    expect(chipView?.state).not.toBe('up');
    expect(chipView?.state).not.toBe('down');
  });

  it('below the abstention floor no direction is shown', () => {
    const matches = [
      makeMatch({ id: 'a', time: NOW - 2 * HOUR_MS, win: true }),
      makeMatch({ id: 'b', time: NOW - HOUR_MS, win: true }),
    ];
    const { insight, chipView } = buildRatingMoveChipView({
      matches,
      horizon: 'last30',
      nowMs: NOW,
      t,
    });
    expect(insight?.state).toBe('locked');
    expect(insight?.deltaPoints).toBeNull();
    expect(chipView?.state).not.toBe('up');
    expect(chipView?.state).not.toBe('down');
    expect(chipView?.state).not.toBe('steady');
  });
});

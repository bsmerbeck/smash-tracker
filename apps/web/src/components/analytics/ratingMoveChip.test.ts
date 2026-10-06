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
  it('a rising 8-game history from the default rating reads up, with the rating unit and horizon', () => {
    const matches = Array.from({ length: 8 }, (_, i) =>
      makeMatch({ id: `w${i}`, time: NOW - (10 * 24 - i) * HOUR_MS, win: i !== 5 }),
    );
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

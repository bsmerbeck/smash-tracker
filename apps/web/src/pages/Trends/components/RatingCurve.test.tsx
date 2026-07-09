import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import {
  RATING_CURVE_UNLOCK_THRESHOLD,
  RatingCurve,
  buildRatingCurveData,
  formatPeriodLabel,
} from './RatingCurve';
import { computeRatingHistory } from '@/lib/glicko';

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

describe('formatPeriodLabel', () => {
  it('formats a period end timestamp as a short month/day label', () => {
    const period = {
      start: 0,
      end: new Date(2021, 0, 5).getTime(),
      games: 3,
      rating: 1500,
      rd: 300,
      volatility: 0.06,
    };
    expect(formatPeriodLabel(period, 'en')).toBe('Jan 5');
  });
});

describe('buildRatingCurveData', () => {
  it('builds a rating line plus a muted +/-RD line pair from periods', () => {
    const matches = Array.from({ length: 6 }, (_, i) =>
      makeMatch({ id: `${i}`, time: i * 1000, win: true }),
    );
    const { periods } = computeRatingHistory(matches);
    const data = buildRatingCurveData(periods, i18n.t, 'en');

    expect(data.datasets).toHaveLength(3);
    expect(data.datasets[0]?.label).toBe('Rating');
    expect(data.datasets[1]?.label).toBe('+RD');
    expect(data.datasets[2]?.label).toBe('-RD');
    expect(data.datasets[0]?.data).toEqual(periods.map((p) => p.rating));
    expect(data.datasets[1]?.data).toEqual(periods.map((p) => p.rating + p.rd));
    expect(data.datasets[2]?.data).toEqual(periods.map((p) => p.rating - p.rd));
    expect(data.labels).toHaveLength(periods.length);
  });

  it('returns empty series for no periods', () => {
    const data = buildRatingCurveData([], i18n.t, 'en');
    expect(data.labels).toEqual([]);
    expect(data.datasets[0]?.data).toEqual([]);
  });
});

describe('RatingCurve component', () => {
  it('shows the locked state below the 5-game unlock threshold', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '3', time: 3, win: false }),
    ];

    render(<RatingCurve matches={matches} />);

    expect(
      screen.getByText(`Rating curve unlocks at ${RATING_CURVE_UNLOCK_THRESHOLD} games`),
    ).toBeInTheDocument();
    expect(screen.getByText('3/5 games so far')).toBeInTheDocument();
  });

  it('shows the locked state for zero matches', () => {
    render(<RatingCurve matches={[]} />);

    expect(
      screen.getByText(`Rating curve unlocks at ${RATING_CURVE_UNLOCK_THRESHOLD} games`),
    ).toBeInTheDocument();
    expect(screen.getByText('0/5 games so far')).toBeInTheDocument();
  });

  it('renders the curve, current rating callout, and caption once unlocked at 5+ games', () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `${i}`, time: i * 1000, win: true }),
    );

    render(<RatingCurve matches={matches} />);

    expect(
      screen.queryByText(`Rating curve unlocks at ${RATING_CURVE_UNLOCK_THRESHOLD} games`),
    ).not.toBeInTheDocument();
    expect(screen.getByText('current rating')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Glicko-2, session-based · unofficial. Dashed lines show the +/-RD uncertainty band.',
      ),
    ).toBeInTheDocument();
    // Rating + RD render together in one node, e.g. "1521 ±..."; assert the
    // ± glyph appears alongside a numeric rating rather than pinning an
    // exact number (keeps this test decoupled from glicko.ts's internals).
    const card = screen.getByText('Rating Curve').closest('[data-slot="card"]');
    expect(card?.textContent).toMatch(/\d+\s*±\d+/);
  });
});

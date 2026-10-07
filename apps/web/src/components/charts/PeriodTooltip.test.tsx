import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { PeriodPoint } from '@smash-tracker/shared';
import { PeriodTooltip } from './PeriodTooltip';
import { formatPeriodRowLabel } from './periodTicks';

/**
 * Plan 37-08 (UAT 37 test 2, UI-SPEC 39.1 §10.1 'one tooltip'): the period
 * trend's tooltip names the period, its TRUE rate and its W–L — resolved by
 * the hovered row's `key`, never an index.
 */
function makePoint(i: number, overrides: Partial<PeriodPoint> = {}): PeriodPoint {
  return {
    grain: 'quarter',
    key: `quarter:2024-Q${i + 1}`,
    label: `2024-Q${i + 1}`,
    startMs: i * 1000,
    endMs: i * 1000 + 999,
    wins: 3 + i,
    losses: 2,
    total: 5 + i,
    rate: (3 + i) / (5 + i),
    subFloor: false,
    matchIds: [],
    ...overrides,
  };
}

const points: PeriodPoint[] = [
  makePoint(0),
  makePoint(1),
  makePoint(2, { wins: 7, losses: 3, total: 10, rate: 0.7 }),
  makePoint(3, { wins: 0, losses: 2, total: 2, rate: 0, subFloor: true }),
];

describe('PeriodTooltip', () => {
  it('shows the period label, the whole-percent rate and the W–L in this period for the hovered key', () => {
    const { getByText } = render(
      <PeriodTooltip points={points} active payload={[{ payload: { key: points[2]!.key } }]} />,
    );
    expect(getByText(formatPeriodRowLabel(points[2]!, 'en'))).toBeInTheDocument();
    expect(getByText(`${Math.round(points[2]!.rate * 100)}%`)).toBeInTheDocument();
    expect(getByText('7–3 in this period')).toBeInTheDocument();
  });

  it('a sub-floor (pinned) period states its TRUE rate, not the clamped dot position', () => {
    const { getByText } = render(
      <PeriodTooltip
        points={points}
        active
        payload={[{ payload: { key: points[3]!.key, dotRatePercent: 40 } }]}
      />,
    );
    expect(getByText('0%')).toBeInTheDocument();
    expect(getByText('0–2 in this period')).toBeInTheDocument();
  });

  it('renders nothing when inactive or when the key matches no period', () => {
    const inactive = render(
      <PeriodTooltip
        points={points}
        active={false}
        payload={[{ payload: { key: points[0]!.key } }]}
      />,
    );
    expect(inactive.container.firstChild).toBeNull();
    const unknown = render(
      <PeriodTooltip points={points} active payload={[{ payload: { key: 'quarter:1999-Q1' } }]} />,
    );
    expect(unknown.container.firstChild).toBeNull();
    const empty = render(<PeriodTooltip points={points} active payload={[]} />);
    expect(empty.container.firstChild).toBeNull();
  });
});

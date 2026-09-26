import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ChartTooltip } from './ChartTooltip';
import type { TrendChartPoint, TrendEventPoint } from './TrendLine';

/**
 * Plan 39.1-50 (OOS-14, UI-SPEC §10.2): a tooltip whose pre-resolved
 * opponent is empty (stage detail has no opponent) prints the event label or
 * the stage name alone — never a sentence that starts with 'at' or 'on'.
 */
const DATE_MS = Date.UTC(2023, 10, 17, 12);

function eventPoint(
  overrides: Partial<TrendEventPoint> & { opponentTag: string },
): TrendEventPoint {
  const { opponentTag, ...rest } = overrides;
  return {
    eventKey: 'eventSession:tournament:genesis',
    cumulativeWinRate: 54,
    wins: 9,
    losses: 9,
    context: { opponentTag, eventLabel: 'Session · Nov 17, 2023', dateMs: DATE_MS },
    ...rest,
  };
}

function gamePoint(opponentTag: string): TrendChartPoint {
  return {
    index: 3,
    winRate: 60,
    context: {
      matchId: 'm3',
      opponentTag,
      stageName: 'Battlefield',
      eventName: null,
      dateMs: DATE_MS,
      win: true,
      gameNumber: null,
    },
  };
}

function lines(point: TrendChartPoint | TrendEventPoint): string[] {
  const { container } = render(<ChartTooltip active payload={[{ payload: point }]} />);
  return Array.from(container.querySelectorAll('p')).map((p) => p.textContent ?? '');
}

describe('ChartTooltip opponent-less wording (plan 39.1-50, OOS-14)', () => {
  it('an event point with no opponent prints the event label alone, never a leading "at"', () => {
    const [, whoWhere] = lines(eventPoint({ opponentTag: '' }));
    expect(whoWhere).toBe('Session · Nov 17, 2023');
    expect(whoWhere).not.toMatch(/^\s*at\b/);
  });

  it('an event point with an opponent still reads "<opponent> at <event>"', () => {
    const [, whoWhere] = lines(eventPoint({ opponentTag: 'synthopp15' }));
    expect(whoWhere).toBe('synthopp15 at Session · Nov 17, 2023');
  });

  it('a per-game point with no opponent prints the stage name alone, never a leading "on"', () => {
    const [, whoWhere] = lines(gamePoint(''));
    expect(whoWhere).toBe('Battlefield');
    expect(whoWhere).not.toMatch(/^\s*on\b/);
  });

  it('a per-game point with an opponent still reads "<opponent> on <stage>"', () => {
    const [, whoWhere] = lines(gamePoint('rival'));
    expect(whoWhere).toBe('rival on Battlefield');
  });

  it('keeps the event and period score lines unchanged', () => {
    expect(lines(eventPoint({ opponentTag: '' })).at(-1)).toBe('9–9 this event');
    expect(lines(eventPoint({ opponentTag: '', eventKey: 'bin:month:1698796800000' })).at(-1)).toBe(
      '9–9 in this period',
    );
  });
});

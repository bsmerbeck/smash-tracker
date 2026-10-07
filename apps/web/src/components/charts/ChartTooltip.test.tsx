import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ChartTooltip } from './ChartTooltip';
import type { TrendChartPoint, TrendEventPoint, TrendValuePoint } from './TrendLine';

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

describe('ChartTooltip event points name the running record (plan 38-12, 38-UAT test 20 F5)', () => {
  it('an event point reads "<rate>% overall so far" above the unchanged "W–L this event" line', () => {
    const out = lines(
      eventPoint({ opponentTag: 'rival', cumulativeWinRate: 79, wins: 1, losses: 3 }),
    );
    expect(out[0]).toBe('79% overall so far');
    expect(out.at(-1)).toBe('1–3 this event');
  });

  it('a binned event point also reads "… overall so far", with the period score line', () => {
    const out = lines(
      eventPoint({
        opponentTag: 'rival',
        eventKey: 'bin:month:1698796800000',
        cumulativeWinRate: 79,
        wins: 1,
        losses: 3,
      }),
    );
    expect(out[0]).toBe('79% overall so far');
    expect(out.at(-1)).toBe('1–3 in this period');
  });

  it('a per-game point keeps the bare rate', () => {
    expect(lines(gamePoint('rival'))[0]).toBe('60%');
  });
});

describe('ChartTooltip value branch (plan 41-02, DD-41-01)', () => {
  const valuePoint: TrendValuePoint = {
    key: 'month:2026-03',
    xMs: DATE_MS,
    value: 10_880_284,
    kind: 'close',
    n: 12,
    memberIndexes: [3, 4],
    containsCalibration: false,
    startMs: DATE_MS,
    endMs: DATE_MS + 1,
    context: {
      valueKey: 'value',
      title: '10,880,284 GSP',
      lines: ['Mar 2026 close', '12 readings · close shown'],
    },
  };

  it('prints the host-resolved title then every line, and never reads winRate', () => {
    const { container } = render(<ChartTooltip active payload={[{ payload: valuePoint }]} />);
    const text = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
    expect(text).toEqual(['10,880,284 GSP', 'Mar 2026 close', '12 readings · close shown']);
    expect(container.textContent).not.toMatch(/NaN|%/);
  });

  it('formats the existing date lines through the locale-explicit formatter', () => {
    const [, , whenOnly] = lines(eventPoint({ opponentTag: 'rival' }));
    // en date order, host zone — the same string the replaced toLocaleDateString printed.
    expect(whenOnly).toContain(new Date(DATE_MS).toLocaleDateString('en'));
  });
});

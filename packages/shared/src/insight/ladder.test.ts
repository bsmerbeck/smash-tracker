import { describe, expect, it } from 'vitest';
import { classify } from './ladder.js';
import type { RateValue } from './types.js';

function rate(wins: number, losses: number): RateValue {
  const total = wins + losses;
  return { wins, losses, total, rate: total > 0 ? wins / total : 0 };
}

describe('classify (D-07 honesty ladder)', () => {
  it('locks below ABSTENTION_FLOOR_GAMES regardless of baseline', () => {
    const result = classify({
      recent: rate(2, 0),
      baseline: rate(2, 0),
      scoped: false,
      hasAction: false,
    });
    expect(result.state).toBe('locked');
    expect(result.deltaPoints).toBeNull();
  });

  it('asserts trend at recent n = 8 when the baseline sits outside the recent Wilson interval', () => {
    // 8 recent wins out of 8 (100%) vs. a large, clearly lower baseline — the interval at n=8,
    // wins=8 is well above any baseline near 50%.
    const result = classify({
      recent: rate(8, 0),
      baseline: rate(50, 50),
      scoped: false,
      hasAction: false,
    });
    expect(result.state).toBe('trend');
    expect(result.kind).toBe('inference');
    expect(result.deltaPoints).not.toBeNull();
  });

  it('reads thin (not trend) at recent n = 7 for the identical shape, with deltaPoints null', () => {
    const result = classify({
      recent: rate(7, 0),
      baseline: rate(50, 50),
      scoped: false,
      hasAction: false,
    });
    expect(result.state).toBe('thin');
    expect(result.deltaPoints).toBeNull();
  });

  it('collapses when recent games are exactly HORIZON_COLLAPSE_RATIO of baseline games', () => {
    // 60 recent / 100 baseline = exactly 60%.
    const result = classify({
      recent: rate(60, 0),
      baseline: rate(100, 0),
      scoped: false,
      hasAction: false,
    });
    expect(result.state).toBe('collapsed');
    expect(result.deltaPoints).toBeNull();
  });

  it('does not collapse at 59.9% of baseline games', () => {
    // 599 recent / 1000 baseline = 59.9%. Baseline rate (60%) sits well inside recent's own
    // (100% win) interval at n=599, so this exercises the "not collapsed, then steady/trend" path.
    const result = classify({
      recent: rate(599, 0),
      baseline: rate(600, 400),
      scoped: false,
      hasAction: false,
    });
    expect(result.state).not.toBe('collapsed');
  });

  it('reads steady when the baseline rate sits inside the recent interval', () => {
    const result = classify({
      recent: rate(15, 15),
      baseline: rate(500, 500),
      scoped: false,
      hasAction: false,
    });
    expect(result.state).toBe('steady');
    expect(result.deltaPoints).toBeNull();
  });

  it('reports thinRecent for a scoped window under TREND_MIN_RECENT_GAMES, never a direction', () => {
    const result = classify({
      recent: rate(4, 3),
      baseline: rate(4, 3),
      scoped: true,
      hasAction: false,
    });
    expect(result.state).toBe('thinRecent');
    expect(result.deltaPoints).toBeNull();
  });

  it('asserts suggestion instead of trend when hasAction is true and the recent sample reaches SUGGESTION_MIN_GAMES', () => {
    const result = classify({
      recent: rate(20, 0),
      baseline: rate(50, 50),
      scoped: false,
      hasAction: true,
    });
    expect(result.state).toBe('suggestion');
    expect(result.kind).toBe('recommendation');
    expect(result.deltaPoints).not.toBeNull();
  });

  it('stays trend (not suggestion) when hasAction is true but the recent sample is below SUGGESTION_MIN_GAMES', () => {
    const result = classify({
      recent: rate(10, 0),
      baseline: rate(50, 50),
      scoped: false,
      hasAction: true,
    });
    expect(result.state).toBe('trend');
    expect(result.deltaPoints).not.toBeNull();
  });

  it('deltaPoints is null in every state except trend and suggestion', () => {
    const cases: Array<{ result: ReturnType<typeof classify>; label: string }> = [
      {
        label: 'locked',
        result: classify({
          recent: rate(1, 0),
          baseline: rate(1, 0),
          scoped: false,
          hasAction: false,
        }),
      },
      {
        label: 'thinRecent',
        result: classify({
          recent: rate(4, 3),
          baseline: rate(4, 3),
          scoped: true,
          hasAction: false,
        }),
      },
      {
        label: 'collapsed',
        result: classify({
          recent: rate(60, 0),
          baseline: rate(100, 0),
          scoped: false,
          hasAction: false,
        }),
      },
      {
        label: 'thin',
        result: classify({
          recent: rate(7, 0),
          baseline: rate(50, 50),
          scoped: false,
          hasAction: false,
        }),
      },
      {
        label: 'steady',
        result: classify({
          recent: rate(15, 15),
          baseline: rate(500, 500),
          scoped: false,
          hasAction: false,
        }),
      },
    ];
    for (const { result, label } of cases) {
      expect(result.deltaPoints, `${label} should have null deltaPoints`).toBeNull();
      expect([result.state === 'trend', result.state === 'suggestion']).not.toContain(true);
    }
  });
});

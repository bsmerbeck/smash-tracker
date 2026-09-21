import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import {
  MatchupChart,
  formStripEventKeyForMatch,
  renderFormNowHead,
  useMatchupFormNow,
} from './MatchupChart';

/**
 * `MatchupChart.tsx` never imports `ChartCard` (the Phase 37 structural
 * split `chartKitBoundary.test.ts` enforces) — its host, `MatchupsPage.tsx`,
 * owns the frame. This test-only wrapper reproduces that EXACT production
 * composition (title/caption/abstained/insight), so this file can still
 * assert on the composed card's rendered order without violating the guard.
 */
function ChartCardWrapper({
  matchupMatches,
  horizon,
  width,
  height,
}: {
  matchupMatches: Match[];
  horizon: HorizonKey;
  width?: number;
  height?: number;
}) {
  const { t } = useTranslation();
  const insight = useMatchupFormNow({ matchupMatches, horizon });
  const opponentId = matchupMatches[0]?.opponent_id;
  return (
    <ChartCard
      title={t('matchups.winRateTrend')}
      caption={t('shared.evidence.type.fact')}
      abstained={
        matchupMatches.length < ABSTENTION_FLOOR_GAMES
          ? { gamesNeeded: ABSTENTION_FLOOR_GAMES - matchupMatches.length }
          : null
      }
      insight={insight && opponentId != null ? renderFormNowHead(insight, opponentId, t) : null}
    >
      <MatchupChart
        matchupMatches={matchupMatches}
        horizon={horizon}
        width={width}
        height={height}
      />
    </ChartCard>
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

/** N countable games, one per day, ending `daysAgo` days before now — every game lands inside `last30`'s window and inside D-15's 12-month scoped-recency bound, so `formNow` resolves a real (non-`locked`/`thinRecent`) state instead of the D-15 "matches are ancient" fallthrough a fixed epoch timestamp (e.g. `time: 1000`) would otherwise always trigger for a `character`-scoped read. */
function recentSequence(count: number, results?: boolean[]): Match[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_, i) => {
    const win = results ? results[i % results.length]! : i % 3 !== 0;
    return makeMatch({ id: `m${i}`, time: now - (count - i) * dayMs, win });
  });
}

function renderChart(
  matches: Match[],
  props: { horizon?: 'last30' | 'lastEvent' | 'last90'; width?: number; height?: number } = {},
  contextOverrides: Partial<MatchupsContextValue> = {},
) {
  const setDrillDown = vi.fn();
  const contextValue: MatchupsContextValue = {
    fighterSprites: [],
    fighter: undefined,
    setFighter: vi.fn(),
    opponent: undefined,
    setOpponent: vi.fn(),
    fighterUsageById: new Map(),
    opponentUsage: [],
    drillDownAxes: {},
    setDrillDown,
    ...contextOverrides,
  };

  const { horizon = 'last30', width = 640, height = 288 } = props;

  const utils = render(
    <MatchupsContext.Provider value={contextValue}>
      <div id={MATCHUP_TABLE_ANCHOR_ID} />
      <ChartCardWrapper matchupMatches={matches} horizon={horizon} width={width} height={height} />
    </MatchupsContext.Provider>,
  );

  return { ...utils, setDrillDown };
}

describe('MatchupChart source contract (CHRT-03)', () => {
  it('contains no select, toggle or radio control for a rolling window', () => {
    const source = fs.readFileSync(path.join(__dirname, 'MatchupChart.tsx'), 'utf8');
    expect(source).not.toMatch(/<Select\b/);
    expect(source).not.toMatch(/<SelectTrigger\b/);
    expect(source).not.toMatch(/ToggleGroup/);
    expect(source).not.toMatch(/role=["']radio["']/);
  });
});

describe('MatchupChart', () => {
  it('with zero games renders the abstention branch — no plot, no axis, no point elements', () => {
    const { container } = renderChart([]);
    expect(screen.getByText(/game.*(needed|more)/i)).toBeInTheDocument();
    expect(container.querySelector('svg.recharts-surface')).toBeNull();
    expect(container.querySelectorAll('circle').length).toBe(0);
  });

  it('renders the card body in order: verdict, evidence, form strip, plot, caption', () => {
    const { container } = renderChart(recentSequence(10));

    // `[data-slot]` covers the verdict/evidence/form-strip/caption markers;
    // the plot itself is a plain Recharts `<path class="trend-line-period-line">`
    // (TrendLine's own className, not a `data-slot`) — walked in via a
    // combined selector and de-duplicated by DOM position below.
    const markers = Array.from(
      container.querySelectorAll(
        '[data-slot="matchup-form-now-verdict"], [data-slot="matchup-form-now-evidence"], [data-slot="form-strip-root"], .trend-line-period-line, [data-slot="chart-card-caption-footer"]',
      ),
    );
    const order = markers.map((el) =>
      el.classList.contains('trend-line-period-line') ? 'plot' : el.getAttribute('data-slot'),
    );

    // The plot only renders once the trend is unlocked (>=8 periods) — the
    // 10-game fixture above is at 'game' grain, 10 points, satisfying that
    // floor.
    expect(order).toEqual([
      'matchup-form-now-verdict',
      'matchup-form-now-evidence',
      'form-strip-root',
      'plot',
      'chart-card-caption-footer',
    ]);
  });

  it('at "game" grain every point is sub-floor (n=1 < the 3-game floor): renders only hollow dots and draws no connecting line segment', () => {
    const { container } = renderChart(recentSequence(10));
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(10);
    for (const circle of Array.from(circles)) {
      expect(circle.getAttribute('stroke')).toBe('var(--viz-context)');
    }
    // The stroked connecting line's `d` attribute is empty/absent when every
    // `lineRatePercent` value is `null` (Recharts draws nothing to connect).
    const line = container.querySelector('.trend-line-period-line');
    expect(line).not.toBeNull();
    const d = line?.getAttribute('d') ?? '';
    expect(d.trim()).toBe('');
  });

  it('on a 200-game fixture the rendered period-point count is at most 60 and the strip-tick count is at most 30', () => {
    const { container } = renderChart(recentSequence(200));
    expect(container.querySelectorAll('circle').length).toBeLessThanOrEqual(60);
    expect(container.querySelectorAll('[data-slot="form-strip-tick"]').length).toBeLessThanOrEqual(
      30,
    );
  });

  it('mounts no brand/primary-colour MARK on the surface (data ink only — a `text-primary` link-styled chrome button, e.g. TrendLine\'s own pre-existing "view as table" toggle, is not a mark and is out of scope)', () => {
    const { container } = renderChart(recentSequence(10));
    const marks = container.querySelectorAll('circle, path.trend-line-period-line, rect');
    for (const mark of Array.from(marks)) {
      const fill = mark.getAttribute('fill') ?? '';
      const stroke = mark.getAttribute('stroke') ?? '';
      expect(fill).not.toMatch(/--primary\b/);
      expect(stroke).not.toMatch(/--primary\b/);
    }
  });
});

describe('MatchupChart drill-down (D-07, CHRT-02, Phase 38-04)', () => {
  it("clicking a period point writes the period's own from/to bounds and scrolls to the results-table anchor", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const matches = recentSequence(10);
    const { container, setDrillDown } = renderChart(matches);

    const svg = container.querySelector('svg.recharts-surface');
    expect(svg).not.toBeNull();
    if (svg) {
      fireEvent.click(svg, { clientX: 320, clientY: 144 });
    }

    // jsdom's zero-size layout resolves every click to activeTooltipIndex 0
    // (see TrendLine.test.tsx and the 37-01 SUMMARY) — the clicked point is
    // therefore always the oldest ('game' grain) point, whose start/end both
    // equal that game's own timestamp.
    expect(setDrillDown).toHaveBeenCalledTimes(1);
    const call = setDrillDown.mock.calls[0]?.[0];
    expect(call).toEqual({ from: matches[0]?.time, to: matches[0]?.time });
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth', block: 'start' }),
    );
  });
});

describe('formStripEventKeyForMatch (event axis <-> form-strip set identity)', () => {
  it('resolves a parseable externalId to its set id, and a manual match to a synthetic per-match key', () => {
    expect(formStripEventKeyForMatch(makeMatch({ externalId: 'sgg:abc123:g2' }))).toBe('abc123');
    expect(formStripEventKeyForMatch(makeMatch({ id: 'manual-1', externalId: undefined }))).toBe(
      'game:manual-1',
    );
  });
});

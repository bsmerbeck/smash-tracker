import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES, buildPeriodSeries } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { ChartCard } from '@/components/charts/ChartCard';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';
import { buildMatchupPeriodSeries } from '../lib/matchupPeriodSeries';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { MatchupChart, renderFormNowHead, useMatchupFormNow } from './MatchupChart';
import { createFormStripSetKeyResolver } from '@/lib/formStripEvents';

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
  const { t, i18n } = useTranslation();
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
      insight={
        insight && opponentId != null
          ? renderFormNowHead(insight, opponentId, t, i18n.language)
          : null
      }
    >
      <MatchupChart
        matchupMatches={matchupMatches}
        horizon={horizon}
        periodSeries={buildMatchupPeriodSeries(matchupMatches)}
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

/**
 * `count` games older than 12 months (well past D-15's 360-day scoped
 * bound) — every game lands OUTSIDE `last30`'s scoped window but INSIDE
 * `scopedMatches` (the pairing's lifetime baseline). The first `wins` games
 * (by array position, not time) win; the rest lose — order doesn't matter
 * for `toRateValue`'s win/loss totals.
 */
function oldSequence(count: number, wins: number, opponentId = 1): Match[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const base = now - 400 * dayMs;
  return Array.from({ length: count }, (_, i) =>
    makeMatch({ id: `o${i}`, opponent_id: opponentId, time: base + i * dayMs, win: i < wins }),
  );
}

/**
 * Plan 39.1-41: `perQuarter` games in each of the `quarters` calendar quarters
 * BEFORE the current one (5 days into the quarter, an hour apart) — the scoped
 * trend's quarterly grain draws one point per quarter whatever today's date
 * is, and the newest quarters stay inside D-15's 12-month bound.
 */
function quarterlySequence(quarters: number, perQuarter: number): Match[] {
  const now = new Date();
  const currentQuarterFirstMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  const matches: Match[] = [];
  for (let k = quarters; k >= 1; k--) {
    const start = Date.UTC(now.getUTCFullYear(), currentQuarterFirstMonth - 3 * k, 5, 12);
    for (let i = 0; i < perQuarter; i++) {
      matches.push(
        makeMatch({ id: `q${k}-${i}`, time: start + i * 60 * 60 * 1000, win: (k + i) % 3 !== 0 }),
      );
    }
  }
  return matches;
}

/** Two games inside both D-15's 12-month scoped bound and the `last30` window. */
function recentPair(opponentId = 1): Match[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  return [
    makeMatch({ id: 'r1', opponent_id: opponentId, time: now - 2 * dayMs, win: true }),
    makeMatch({ id: 'r2', opponent_id: opponentId, time: now - 1 * dayMs, win: false }),
  ];
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
    // REWRITTEN by plan 39.1-41 (PD-41-1): 10 daily games are one quarter —
    // the scoped trend locks there — so the fixture is 9 quarters of 3 games.
    const { container } = renderChart(quarterlySequence(9, 3));

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
    // fixture above is at 'quarter' grain, 9 points, satisfying that floor.
    expect(order).toEqual([
      'matchup-form-now-verdict',
      'matchup-form-now-evidence',
      'form-strip-root',
      'plot',
      'chart-card-caption-footer',
    ]);
  });

  // REWRITTEN by plan 39.1-41 (PD-41-1): the scoped trend never bins finer
  // than a quarter, so the all-sub-floor case is 8 quarters of 2 games (was
  // 10 single-game 'game' points).
  it('at "quarter" grain with every quarter sub-floor (n=2 < the 3-game floor): renders only hollow dots and draws no connecting line segment', () => {
    const { container } = renderChart(quarterlySequence(8, 2));
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(8);
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

  describe('WR-C05 (39.1-REVIEW.md): locale-aware percent formatting in the evidence sentence', () => {
    afterEach(async () => {
      await i18n.changeLanguage('en');
    });

    it('renders the French percent convention (a space before the sign), never the English "NN%" glued form', async () => {
      await i18n.changeLanguage('fr');
      const { container } = renderChart(recentSequence(10));
      const evidence = container.querySelector('[data-slot="matchup-form-now-evidence"]');
      expect(evidence).toBeInTheDocument();
      const text = evidence!.textContent ?? '';
      expect(text).toMatch(/%/);
      expect(text).toMatch(/\d+\s%/);
      expect(text).not.toMatch(/\d+%/);
    });
  });
});

describe('D-15 scoped-window head (39.1-31, item 7)', () => {
  it('renders the D-15 "no games" sentence and a lifetime-only evidence line when the pairing has history but nothing within 12 months', () => {
    const matches = oldSequence(20, 12);
    const { container } = renderChart(matches, { horizon: 'last30' });

    const verdict = container.querySelector('[data-slot="matchup-form-now-verdict"]');
    expect(verdict?.textContent).toBe(
      'No games vs Mario in the last 12 months — showing lifetime.',
    );

    const evidence = container.querySelector('[data-slot="matchup-form-now-evidence"]');
    expect(evidence).toBeInTheDocument();
    const text = evidence!.textContent ?? '';
    expect(text).toContain('12–8');
    expect(text).toContain('all time');
    expect(text).toContain('high confidence, 20 games');
    expect(text).not.toContain('0–0');
    expect(text).not.toContain('low confidence');
  });

  it('renders the D-15 "only N games" sentence once a couple of recent games exist inside the scoped bound', () => {
    const matches = [...oldSequence(20, 12), ...recentPair()];
    const { container } = renderChart(matches, { horizon: 'last30' });

    const verdict = container.querySelector('[data-slot="matchup-form-now-verdict"]');
    expect(verdict?.textContent).toBe(
      'Only 2 games vs Mario in the last 12 months — showing lifetime.',
    );
  });

  it('suppresses the form strip\'s duplicate "No games in the last 30" note when the head already states the scoped-empty window, but keeps the note for a time-bounded horizon whose empty window is unrelated to D-15', () => {
    const matches = oldSequence(20, 12);

    const { container: last30Container } = renderChart(matches, { horizon: 'last30' });
    expect(
      within(last30Container).queryByText('No games in the last 30 — showing all time.'),
    ).toBeNull();

    const { container: lastEventContainer } = renderChart(matches, { horizon: 'lastEvent' });
    expect(
      within(lastEventContainer).getByText('No games at the last event — showing all time.'),
    ).toBeInTheDocument();
  });

  it("keeps the unchanged two-horizon evidence line, with its confidence cue drawn from the window's own game count, once the recent window is evidenced", () => {
    const { container } = renderChart(recentSequence(30));
    const evidence = container.querySelector('[data-slot="matchup-form-now-evidence"]');
    expect(evidence).toBeInTheDocument();
    expect(evidence!.textContent ?? '').toMatch(/high confidence, 30 games/);
  });
});

describe('Form strip session grouping (39.1-31, item 7, UI-SPEC §7.10/§8.6)', () => {
  it('groups manual games with no named event into 3-hour sessions labelled "Session · <date>", ordered by first game time alongside a named event, and never labels a group "Unknown"', () => {
    const hourMs = 60 * 60 * 1000;
    const base = Date.now() - 2 * 24 * hourMs;
    const sessionA = [
      makeMatch({ id: 'sA1', time: base, win: true }),
      makeMatch({ id: 'sA2', time: base + 30 * 60 * 1000, win: false }),
    ];
    const namedEvent = [
      makeMatch({ id: 'ev1', time: base + 2 * hourMs, win: true, eventName: 'Genesis 9' }),
    ];
    const sessionB = [
      makeMatch({ id: 'sB1', time: base + 10 * hourMs, win: true }),
      makeMatch({ id: 'sB2', time: base + 10.5 * hourMs, win: false }),
    ];
    const matches = [...sessionA, ...namedEvent, ...sessionB];

    const { container } = renderChart(matches);
    const groups = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(groups.length).toBe(3);

    // Plan 39.1-33 (R1): each group's own aria-label is "<label> · <record>"
    // — the per-group label/record line FormStrip.tsx used to render is
    // gone, replaced by the row's own accessible name and the kit-level
    // caption (asserted below).
    const labels = groups.map((g) => g.getAttribute('aria-label'));
    const expectedDate = new Intl.DateTimeFormat('en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(base));

    expect(labels[0]).toMatch(new RegExp(`^Session · ${expectedDate}`));
    expect(labels[1]).toMatch(/^Genesis 9/);
    expect(labels[2]).toMatch(/^Session · /);
    expect(labels.some((l) => l?.startsWith('Unknown'))).toBe(false);

    // The caption's first (oldest shown) span carries the same event's
    // label as its title — no width-fit prop is given in this render, so
    // every group is shown and the oldest is session A.
    const captionFirst = container.querySelector('[data-slot="form-strip-caption-first"]');
    expect(captionFirst).toHaveAttribute('title', `Session · ${expectedDate}`);
  });

  it("WR-01: a recurring start.gg event name at two tournaments is ordered by its sets' own games — the newest tournament's sets end the strip, not an older manual session", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const olderTournament = Array.from({ length: 4 }, (_, i) =>
      makeMatch({
        id: `a${i}`,
        time: now - 300 * dayMs + i * 60_000,
        eventName: 'Ultimate Singles',
        tournamentName: 'Genesis',
        opponent: 'old-rival',
      }),
    );
    const manualSession = [
      makeMatch({ id: 's1', time: now - 100 * dayMs, opponent: 'session-rival' }),
      makeMatch({ id: 's2', time: now - 100 * dayMs + 60_000, opponent: 'session-rival' }),
    ];
    const newerTournament = Array.from({ length: 3 }, (_, i) =>
      makeMatch({
        id: `b${i}`,
        time: now - 2 * dayMs + i * 60_000,
        eventName: 'Ultimate Singles',
        tournamentName: 'Evo',
        opponent: 'newest-rival',
      }),
    );
    const { container } = renderChart([...olderTournament, ...manualSession, ...newerTournament]);
    const sets = Array.from(container.querySelectorAll('[data-slot="form-strip-set"]'));
    expect(sets[sets.length - 1]!.getAttribute('aria-label')).toMatch(/newest-rival/);
    // REWRITTEN by plan 39.1-42 (PD-42-2): the group is named by its
    // TOURNAMENT ("Evo"), never the shared bracket name "Ultimate Singles".
    expect(container.querySelector('[data-slot="form-strip-caption-last"]')).toHaveAttribute(
      'title',
      'Evo',
    );
    const groups = Array.from(container.querySelectorAll('[data-slot="form-strip-event"]'));
    expect(groups).toHaveLength(3);
  });

  it('WR-03: the strip row is named for the games DRAWN of the total ("Form strip, 30 of 35 games"), and the key pluralises on the total', () => {
    const { container } = renderChart(recentSequence(35));
    const row = container.querySelector('[data-slot="form-strip-root"] [role="group"]');
    expect(row).toHaveAttribute('aria-label', 'Form strip, 30 of 35 games');
    const t = i18n.getFixedT('en');
    expect(t('analytics.strip.aria', { count: 1, shown: 1 })).toBe('Form strip, 1 of 1 game');
    expect(t('analytics.strip.aria', { count: 77, shown: 11 })).toBe('Form strip, 11 of 77 games');
    for (const locale of ['en', 'es', 'fr', 'de', 'pt', 'ja']) {
      for (const suffix of ['_one', '_other']) {
        const bundle = JSON.parse(
          fs.readFileSync(path.resolve(__dirname, `../../../i18n/locales/${locale}.json`), 'utf8'),
        ) as { analytics: { strip: Record<string, string> } };
        const value = bundle.analytics.strip[`aria${suffix}`];
        expect(value, `${locale} analytics.strip.aria${suffix}`).toMatch(
          /\{\{shown\}\}.*\{\{count\}\}|\{\{count\}\}.*\{\{shown\}\}/,
        );
      }
    }
  });

  it('a pairing of 35 games renders "30 of 35 games shown" — the host formatter wiring, jsdom applies only the 30-game limit (no measured width)', () => {
    const { container } = renderChart(recentSequence(35));
    const shownOfTotal = container.querySelector('[data-slot="form-strip-shown-of-total"]');
    expect(shownOfTotal).toHaveTextContent('30 of 35 games shown');
  });
});

describe('MatchupChart drill-down (D-07, CHRT-02, Phase 38-04)', () => {
  it("clicking a period point writes the point's own key as the event axis (never a from/to window) and scrolls to the results-table anchor", () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    // REWRITTEN by plan 39.1-41 (PD-41-1): the clicked point is the oldest
    // QUARTER (was the oldest 'game' point of 10 daily games).
    const matches = quarterlySequence(9, 3);
    const { container, setDrillDown } = renderChart(matches);

    const svg = container.querySelector('svg.recharts-surface');
    expect(svg).not.toBeNull();
    if (svg) {
      fireEvent.click(svg, { clientX: 320, clientY: 144 });
    }

    // jsdom's zero-size layout resolves every click to activeTooltipIndex 0
    // (see TrendLine.test.tsx and the 37-01 SUMMARY) — the clicked point is
    // therefore always the oldest (quarter) point. CR-02 (39.1-REVIEW):
    // the drill names that point by its key — a `[startMs, endMs]` window
    // over-counts on tied timestamps and non-contiguous grains.
    expect(setDrillDown).toHaveBeenCalledTimes(1);
    const call = setDrillDown.mock.calls[0]?.[0];
    expect(call).toEqual({ eventKey: buildMatchupPeriodSeries(matches).points[0]?.key });
    expect(call.eventKey).toMatch(/^quarter:\d{4}-Q[1-4]$/);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth', block: 'start' }),
    );
  });
});

// REWRITTEN by plan 39.1-42 (PD-42-4): the per-game `formStripEventKeyForMatch`
// wrapper is retired — the terminus resolves through the ONE strip derivation,
// where a manual game belongs to its play-session set and keeps its legacy
// per-game key for links shared before the change.
describe('createFormStripSetKeyResolver (event axis <-> form-strip set identity)', () => {
  it('resolves a parseable externalId to its set id, and a manual match to its session set key plus its legacy per-match key', () => {
    const parsed = makeMatch({ externalId: 'sgg:abc123:g2' });
    const manual = makeMatch({ id: 'manual-1', externalId: undefined });
    const resolve = createFormStripSetKeyResolver([parsed, manual]);
    expect(resolve(parsed)).toEqual(['abc123']);
    expect(resolve(manual)).toEqual(['manual-session:manual-1', 'game:manual-1']);
  });
});

/**
 * Plan 39.1-41 (sketch 003 A tracer; PD-41-1/2/3): the scoped Matchups trend
 * on the sketch's own two pairings. The fixture (`scripts/sketch003Fixture.mjs`)
 * and the new builder are loaded inside each test body so a missing export
 * fails the test, not the file.
 */
describe('MatchupChart — sketch 003 scoped trend (plan 39.1-41)', () => {
  type Sketch003Fixture = {
    buildSketch003Scale: () => { matches: Match[] };
    SKETCH_003_PAIRINGS: { deep: readonly [number, number]; thin: readonly [number, number] };
  };

  async function loadFixture(): Promise<Sketch003Fixture> {
    const url = pathToFileURL(path.resolve(__dirname, '../../../../scripts/sketch003Fixture.mjs'));
    return (await import(/* @vite-ignore */ url.href)) as Sketch003Fixture;
  }

  async function pairing(which: 'deep' | 'thin'): Promise<Match[]> {
    const { buildSketch003Scale, SKETCH_003_PAIRINGS } = await loadFixture();
    const [fighterId, opponentId] = SKETCH_003_PAIRINGS[which];
    return buildSketch003Scale().matches.filter(
      (m) => m.fighter_id === fighterId && m.opponent_id === opponentId,
    );
  }

  type ScopedBuilder = (matches: Match[]) => ReturnType<typeof buildPeriodSeries>;

  async function loadBuilder(): Promise<{ build: ScopedBuilder; minGrain: unknown }> {
    const mod = (await import('../lib/matchupPeriodSeries')) as Record<string, unknown>;
    expect(typeof mod.buildMatchupPeriodSeries, 'buildMatchupPeriodSeries is exported').toBe(
      'function',
    );
    return {
      build: mod.buildMatchupPeriodSeries as ScopedBuilder,
      minGrain: mod.MATCHUP_TREND_MIN_GRAIN,
    };
  }

  it("buildMatchupPeriodSeries bins quarterly (MATCHUP_TREND_MIN_GRAIN = 'quarter'): deep 21 points, 18 at the floor", async () => {
    const { build, minGrain } = await loadBuilder();
    expect(minGrain).toBe('quarter');
    const series = build(await pairing('deep'));
    expect(series.grain).toBe('quarter');
    expect(series.points).toHaveLength(21);
    expect(series.points.filter((p) => !p.subFloor)).toHaveLength(18);
  });

  it('buildMatchupPeriodSeries on the thin pairing: 4 quarters, 1 at the floor', async () => {
    const { build } = await loadBuilder();
    const series = build(await pairing('thin'));
    expect(series.grain).toBe('quarter');
    expect(series.points).toHaveLength(4);
    expect(series.points.filter((p) => !p.subFloor)).toHaveLength(1);
  });

  function renderScoped(matches: Match[], series: ReturnType<typeof buildPeriodSeries>) {
    const contextValue: MatchupsContextValue = {
      fighterSprites: [],
      fighter: undefined,
      setFighter: vi.fn(),
      opponent: undefined,
      setOpponent: vi.fn(),
      fighterUsageById: new Map(),
      opponentUsage: [],
      drillDownAxes: {},
      setDrillDown: vi.fn(),
    };
    return render(
      <MatchupsContext.Provider value={contextValue}>
        <MatchupChart matchupMatches={matches} horizon="last30" periodSeries={series} width={640} />
      </MatchupsContext.Provider>,
    );
  }

  it('the deep trend renders at CHART_H_COMPACT with tier dots (5 and 7 px only) and ONE stroked line', async () => {
    const { build } = await loadBuilder();
    const deep = await pairing('deep');
    const { container } = renderScoped(deep, build(deep));
    const root = container.querySelector('[data-slot="trend-line-period"]');
    expect(root?.getAttribute('data-state')).toBe('drawn');
    expect(root?.getAttribute('data-dot-sizing')).toBe('tier');
    expect(root?.getAttribute('data-y-domain')).toBe('20,100');
    const surface = container.querySelector('svg.recharts-surface');
    expect(surface?.getAttribute('height')).toBe('160');
    const diameters = new Set(
      Array.from(container.querySelectorAll('[data-slot="trend-period-dot"]')).map(
        (c) => Number(c.getAttribute('r')) * 2,
      ),
    );
    expect([...diameters].sort()).toEqual([5, 7]);
    const stroked = Array.from(container.querySelectorAll('path.recharts-line-curve')).filter(
      (p) => (p.getAttribute('stroke') ?? 'none') !== 'none',
    );
    expect(stroked).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-yAxis')).toHaveLength(1);
    const labels = Array.from(
      container.querySelectorAll('[data-slot="trend-period-value-label"]'),
    ).map((el) => el.textContent);
    expect([...labels].sort()).toEqual(['100%', '33%', '60%']);
  });

  it("the reference label reads t('analytics.trend.referenceLabel') — '63% all time' on the deep pairing (was a bare '63%')", async () => {
    const { build } = await loadBuilder();
    const deep = await pairing('deep');
    const { container } = renderScoped(deep, build(deep));
    const label = container.querySelector('.trend-period-reference-label');
    expect(label?.textContent).toBe(i18n.t('analytics.trend.referenceLabel', { rate: '63%' }));
    expect(label?.textContent).toBe('63% all time');
  });

  it('the thin pairing shows the locked trend', async () => {
    const { build } = await loadBuilder();
    const thin = await pairing('thin');
    const { container } = renderScoped(thin, build(thin));
    const root = container.querySelector('[data-slot="trend-line-period"]');
    expect(root?.getAttribute('data-state')).toBe('locked');
    expect(container.querySelector('svg.recharts-surface')).toBeNull();
  });

  it('MatchupChart.tsx carries no cumulative context series', () => {
    const source = fs.readFileSync(path.join(__dirname, 'MatchupChart.tsx'), 'utf8');
    expect(source).not.toMatch(/contextRatePercents|computeCumulativeContextPercents/);
  });
});

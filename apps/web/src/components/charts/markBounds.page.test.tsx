import { describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router';
import { useTranslation } from 'react-i18next';
import type {
  GspPoint,
  GspSettings,
  HorizonKey,
  Insight,
  Match,
  TierSplitEntry,
  ValueSeriesReading,
} from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  ACCOUNT_SCOPE,
  ACTIVITY_HEAT_MAX_YEARS,
  CAREER_TIMELINE_NARROW_STRIP_CELLS,
  GSP_BAND_MAX_BANDS,
  INSIGHT_TEMPLATES,
  MARK_BOUND_HEAT_CELLS,
  MARK_BOUND_LINE_POINTS,
  MARK_BOUND_STRIP_TICKS,
  TIMELINE_EVENT_MARKER_MAX,
  buildActivityHeat,
  buildOpponentEventSeries,
  buildPeriodSeries,
  buildStageEventSeries,
  buildValueSeries,
  getGspGainStats,
  resolveEntryTiers,
} from '@smash-tracker/shared';
import {
  generateSyntheticMatches,
  emptyWorkspace,
  oneGameWorkspace,
  twoGameWorkspace,
  unknownStageOnlyWorkspace,
  unknownCharacterOnlyWorkspace,
} from '@smash-tracker/shared/testUtils';
import { SpriteList } from '@/data/sprites';
import { ChartCard } from '@/components/charts/ChartCard';
import { MatchupsContext, type MatchupsContextValue } from '@/pages/Matchups/MatchupsContext';
import {
  MatchupChart,
  renderFormNowHead,
  useMatchupFormNow,
} from '@/pages/Matchups/components/MatchupChart';
import { FighterHero } from '@/pages/FighterAnalysis/components/FighterHero';
import { useFighterFormNow } from '@/pages/FighterAnalysis/lib/useFighterFormNow';
import { CareerTimelineCard } from '@/pages/Trends/components/CareerTimelineCard';
import { PlayRhythmCard } from '@/pages/Trends/components/PlayRhythmCard';
import { PlayRhythmHeat } from '@/pages/Trends/components/PlayRhythmHeat';
import { GspCurve } from '@/pages/Gsp/components/GspCurve';
import { GspVsGlicko } from '@/pages/Gsp/components/GspVsGlicko';
import { GainsAnalysis } from '@/pages/Gsp/components/GainsAnalysis';
import { toMmrSeries } from '@/pages/Gsp/lib/gspMmrModel';
import { buildGspVsGlickoPanels } from '@/pages/Gsp/lib/gspVsGlicko';
import { computeRatingHistory } from '@/lib/glicko';

// The GSP hosts read the live Elite threshold through TanStack Query; this oracle has no provider and
// needs none (the same stub GspCurve.test.tsx / GspVsGlicko.test.tsx use).
vi.mock('@/hooks/useGspLive', () => ({ useGspLive: () => ({ data: undefined }) }));

/**
 * Plan 39.1-21 Task 2 (VIZ-01, UI-SPEC §11/§7.13): the whole-phase mark-bound
 * oracle. Covers the two Track C surfaces whose marks are genuinely
 * DOM-countable in jsdom without a page-scale render harness:
 *
 * - `MatchupChart.tsx` (plan 39.1-13) — the ONLY rebuilt surface that
 *   exposes an explicit numeric `width`/`height` test seam, so `TrendLine`'s
 *   `<circle>` marks actually render under jsdom (its `ResponsiveContainer`
 *   otherwise measures 0x0 — see `FighterHero.test.tsx`'s and 39.1-14's own
 *   SUMMARY doc comment on this exact jsdom limitation). This is also the
 *   surface the non-vacuity companion below uses.
 * - `FighterHero.tsx` (plan 39.1-14) — its `FormStrip` ticks ARE
 *   DOM-countable (plain `data-slot="form-strip-tick"` divs, not a Recharts
 *   mark); its period-trend line points are NOT (no explicit width/height
 *   prop on this surface), so this file verifies that bound STRUCTURALLY —
 *   calling the exact same `buildPeriodSeries({ matches: fighterMatches })`
 *   the component itself calls internally (`FighterHero.tsx` line ~251),
 *   over the identical fixture, and asserting the bound on its `.points`
 *   output.
 *
 * NOT covered here, with reasons: `OpponentHubPage.tsx`'s 20-tick `FormStrip`
 * (plan 39.1-18) is a literal `limit={20}` prop — already <=
 * `MARK_BOUND_STRIP_TICKS` by construction and asserted from a real render
 * in `OpponentHubPage.test.tsx`'s own Task-3 describe block (tick count
 * <=20) — mounting the full hub page here (its own test file's API/auth
 * mock surface is ~150 lines) would duplicate that coverage at high setup
 * cost for no new signal. `CounterpickAdvisor.tsx`'s bars-mode
 * `ComparisonBars` and `OpponentHubPage.tsx`'s `MatrixHeat` cross-tab are
 * PRE-EXISTING Phase 37/38 surfaces this phase never rebuilt (`MARK_BOUND_BARS`/
 * `MARK_BOUND_HEAT_CELLS` therefore have no Track-C-rebuilt consumer to
 * prove a bound against this run).
 */

const fox = SpriteList.find((s) => s.id === 8)!; // KNOWN_FIGHTER_ID (sparseWorkspaces.ts)

function makeMatch(overrides: Partial<Match> & { id: string; time: number; win: boolean }): Match {
  return {
    fighter_id: fox.id,
    opponent_id: 23,
    map: { id: 1, name: 'Battlefield' },
    opponent: '',
    notes: '',
    matchType: 'quickplay',
    ...overrides,
  } as Match;
}

/** A large, mixed-event fixture — well past both the form-strip and period-trend line bounds at 'game' grain. */
function realisticFixture(count: number): Match[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) =>
    makeMatch({
      id: `g${i}`,
      time: now - (count - i) * 24 * 60 * 60 * 1000,
      win: i % 3 !== 0,
      matchType: i % 2 === 0 ? 'quickplay' : 'online-tourney',
    }),
  );
}

// ---------------------------------------------------------------------------
// MatchupChart harness — mirrors MatchupChart.test.tsx's own ChartCardWrapper
// (MatchupChart.tsx never imports ChartCard itself, a Phase 37 structural
// guard `chartKitBoundary.test.ts` enforces; the host owns the frame).
// ---------------------------------------------------------------------------

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
      // 39.1-44: `matchups.winRateTrend` is retired (the page's hero has no chart card);
      // this test-only frame keeps a literal title.
      title="Win rate over time"
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
        periodSeries={buildPeriodSeries({ matches: matchupMatches })}
        width={width}
        height={height}
      />
    </ChartCard>
  );
}

function renderMatchupChart(
  matches: Match[],
  { width = 640, height = 288 }: { width?: number; height?: number } = {},
) {
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
      <ChartCardWrapper matchupMatches={matches} horizon="last30" width={width} height={height} />
    </MatchupsContext.Provider>,
  );
}

// ---------------------------------------------------------------------------
// FighterHero harness — mirrors FighterHero.test.tsx's own renderHero.
// ---------------------------------------------------------------------------

/** Mirrors `FighterHero.test.tsx`'s own `HeroHarness` (plan 39.1-25): obtains `formNowInsight`/`nowMs` via `useFighterFormNow` itself, never a hand-built `Insight` literal. */
function FighterHeroHarness({ fighterMatches }: { fighterMatches: Match[] }) {
  const { insight, nowMs } = useFighterFormNow({
    fighterId: fox.id,
    fighterMatches,
    horizon: 'last30',
  });
  return (
    <FighterHero
      fighter={fox}
      fighterMatches={fighterMatches}
      allMatches={fighterMatches}
      horizon="last30"
      setHorizon={vi.fn()}
      isLoading={false}
      formNowInsight={insight}
      nowMs={nowMs}
      periodSeries={buildPeriodSeries({ matches: fighterMatches })}
      onDrill={vi.fn()}
    />
  );
}

function renderFighterHero(fighterMatches: Match[]) {
  return render(
    <MemoryRouter>
      <FighterHeroHarness fighterMatches={fighterMatches} />
    </MemoryRouter>,
  );
}

/** Every rendered delta-chip value text (`analytics.record.deltaUp`/`deltaDown` — "+N pts"/"-N pts") — the one literal, asserted directional pattern this app renders. A sparse/thin fixture must never produce one. */
function directionChipTexts(container: HTMLElement): string[] {
  const matches = (container.textContent ?? '').match(/[+-]\d+\s*pts/g);
  return matches ?? [];
}

describe('Whole-phase mark-bound oracle (VIZ-01)', () => {
  describe('realistically-sized fixture — bounds hold', () => {
    it('MatchupChart: rendered period-point count is at most the shared bound, and the form-strip tick count is at most the shared bound', () => {
      const { container } = renderMatchupChart(realisticFixture(300));
      const circles = container.querySelectorAll('circle');
      expect(circles.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
      const ticks = container.querySelectorAll('[data-slot="form-strip-tick"]');
      expect(ticks.length).toBeLessThanOrEqual(MARK_BOUND_STRIP_TICKS);
    });

    it('non-vacuity companion: MatchupChart renders more than ten real line points on the realistic fixture — the bound assertion above cannot be passing on an empty render', () => {
      const { container } = renderMatchupChart(realisticFixture(300));
      const circles = container.querySelectorAll('circle');
      expect(circles.length).toBeGreaterThan(10);
    });

    it('FighterHero: rendered form-strip tick count is at most the shared bound', () => {
      const { container } = renderFighterHero(realisticFixture(300));
      const ticks = container.querySelectorAll('[data-slot="form-strip-tick"]');
      expect(ticks.length).toBeLessThanOrEqual(MARK_BOUND_STRIP_TICKS);
      expect(ticks.length).toBeGreaterThan(0);
    });

    it("FighterHero: the period series it feeds TrendLine (buildPeriodSeries, the exact call FighterHero.tsx itself makes) never exceeds the shared line-point bound — verified structurally, since jsdom's ResponsiveContainer renders zero-size (0 circles) without an explicit width/height prop this surface does not expose", () => {
      const matches = realisticFixture(300);
      const series = buildPeriodSeries({ matches });
      expect(series.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
      // Non-vacuity for the structural check: the fixture is big enough that
      // the ladder is genuinely exercised (not a 1-2-point fixture trivially
      // under bound at every grain).
      expect(series.points.length).toBeGreaterThan(10);
    });
  });

  describe('sparse fixtures — no empty frame, no direction anywhere', () => {
    const sparseFixtures: { name: string; build: () => Match[] }[] = [
      { name: 'empty workspace', build: emptyWorkspace },
      { name: 'one-game workspace', build: oneGameWorkspace },
      { name: 'two-game workspace', build: twoGameWorkspace },
      { name: 'unknown-stage-only workspace', build: unknownStageOnlyWorkspace },
    ];

    for (const fixture of sparseFixtures) {
      it(`MatchupChart on the ${fixture.name}: renders a real branch (abstained copy or content), never an empty frame, and no direction chip`, () => {
        const { container } = renderMatchupChart(fixture.build());
        expect((container.textContent ?? '').trim().length).toBeGreaterThan(0);
        expect(directionChipTexts(container)).toEqual([]);
      });

      it(`FighterHero on the ${fixture.name}: renders a real branch (no-matches copy or content), never an empty frame, and no direction chip`, () => {
        const { container } = renderFighterHero(fixture.build());
        expect((container.textContent ?? '').trim().length).toBeGreaterThan(0);
        expect(directionChipTexts(container)).toEqual([]);
      });
    }

    // The opponent-side unknown-character workspace (fighter_id/opponent_id
    // both the `0` sentinel) models an OPPONENT-side data-quality edge
    // (characterMovers/rivalMovers' own isUnknownCharacter exclusion) — it
    // fits MatchupChart's pairing scope (fighter+opponent) directly, but not
    // FighterHero's "one real, selected fighter" contract (that surface is
    // never mounted for an unknown fighter id in production), so it is
    // exercised against MatchupChart only.
    it('MatchupChart on the unknown-character-only workspace: renders a real branch, never an empty frame, and no direction chip', () => {
      const { container } = renderMatchupChart(unknownCharacterOnlyWorkspace());
      expect((container.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(directionChipTexts(container)).toEqual([]);
    });
  });

  /**
   * Plan 39.1-35 (UI-SPEC §11 / §12.1, D-07): the Trends career timeline —
   * rendered through its real host (`CareerTimelineCard`, explicit chart
   * width) — obeys the line / strip / form-strip bounds on the realistic,
   * casual and sparse fixtures, and a sparse account gets a designed state
   * (the locked inset or the thin state), never an empty frame.
   */
  describe('career timeline (plan 39.1-35)', () => {
    function renderTimelineCard(matches: Match[], width: number) {
      return render(<CareerTimelineCard matches={matches} horizon="last30" chartWidth={width} />);
    }

    it('realistic fixture at 1000px: more than 20 and at most 60 anchors, at most 108 rate and games cells', () => {
      const { container } = renderTimelineCard(realisticFixture(300), 1000);
      const anchors = container.querySelectorAll('[data-slot="career-timeline-point"]');
      expect(anchors.length).toBeGreaterThan(20);
      expect(anchors.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
      const rate = container.querySelectorAll('[data-slot="career-timeline-rate-cell"]');
      const games = container.querySelectorAll('[data-slot="career-timeline-games-cell"]');
      expect(rate.length).toBeGreaterThan(0);
      expect(rate.length).toBeLessThanOrEqual(MARK_BOUND_HEAT_CELLS);
      expect(games.length).toBeLessThanOrEqual(MARK_BOUND_HEAT_CELLS);
    });

    it('realistic fixture at 400px: at most 36 rate and games cells (quarters)', () => {
      const { container } = renderTimelineCard(realisticFixture(300), 400);
      const rate = container.querySelectorAll('[data-slot="career-timeline-rate-cell"]');
      const games = container.querySelectorAll('[data-slot="career-timeline-games-cell"]');
      expect(rate.length).toBeGreaterThan(0);
      expect(rate.length).toBeLessThanOrEqual(CAREER_TIMELINE_NARROW_STRIP_CELLS);
      expect(games.length).toBeLessThanOrEqual(CAREER_TIMELINE_NARROW_STRIP_CELLS);
    });

    it('casual fixture (41 games, 3 months): the thin state with at most 60 anchors and a per-game strip of at most 60 ticks', () => {
      const casual = generateSyntheticMatches({
        seed: 39_135_001,
        count: 41,
        startMs: Date.UTC(2026, 6, 3, 19),
        sessionSizeRange: [2, 6],
        sessionGapMs: 156 * 60 * 60 * 1000,
        winRate: 0.56,
      });
      const { container } = renderTimelineCard(casual, 1000);
      const root = container.querySelector('[data-slot="career-timeline"]')!;
      expect(root.getAttribute('data-state')).toBe('thin');
      expect(
        root.querySelectorAll('[data-slot="career-timeline-point"]').length,
      ).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
      const ticks = root.querySelectorAll('[data-slot="form-strip-tick"]');
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.length).toBeLessThanOrEqual(MARK_BOUND_STRIP_TICKS);
    });

    const sparse: { name: string; build: () => Match[] }[] = [
      { name: 'empty workspace', build: emptyWorkspace },
      { name: 'one-game workspace', build: oneGameWorkspace },
      { name: 'two-game workspace', build: twoGameWorkspace },
      { name: 'unknown-stage-only workspace', build: unknownStageOnlyWorkspace },
    ];
    for (const fixture of sparse) {
      it(`on the ${fixture.name}: the locked inset or the thin state — never an empty frame — and no direction chip`, () => {
        const { container } = renderTimelineCard(fixture.build(), 1000);
        const root = container.querySelector('[data-slot="career-timeline"]');
        expect(root).not.toBeNull();
        const state = root!.getAttribute('data-state');
        if (state === 'locked') {
          expect(root!.querySelector('[data-slot="career-timeline-locked"]')).not.toBeNull();
        } else {
          expect(state).toBe('thin');
          expect(root!.querySelector('[data-slot="career-timeline-thin-strip"]')).not.toBeNull();
        }
        expect((root!.textContent ?? '').trim().length).toBeGreaterThan(0);
        expect(directionChipTexts(container)).toEqual([]);
      });
    }
  });
});

/**
 * Plan 39.1-39 (VIZ-01, UI-SPEC §11 "line points at most 60"): stage detail
 * and the opponent hub bound their event trends STRUCTURALLY — the exact
 * pipeline both hosts run (`binEventSeries` over the engine's event series,
 * then `buildEventTrendPoints`) over a sparg0-sized fixture (8,400 games,
 * ~495 sessions, the career scale's parameters), with a non-vacuity check
 * that the unbinned series is over the bound. The page-level jsdom cases
 * live in StageDetailPage.test.tsx / OpponentHubPage.test.tsx.
 */
describe('mark bounds — stage detail and hub event trends (plan 39.1-39)', () => {
  const sparg0 = generateSyntheticMatches({
    seed: 39_134_001,
    count: 8_400,
    startMs: Date.UTC(2018, 11, 18, 18),
    sessionSizeRange: [6, 28],
    sessionGapMs: 135 * 60 * 60 * 1000,
    winRate: 0.73,
    mainFighterIds: [8, 22],
    opponentFighterIds: [1, 10],
    stageIds: [1],
  });

  async function pipeline() {
    const shared = (await import('@smash-tracker/shared')) as Record<string, unknown>;
    // A variable specifier keeps Vite's import analysis from failing the whole
    // file at transform time while the module does not exist yet (RED).
    const specifier = '@/lib/eventTrendPoints';
    const mod = (await import(/* @vite-ignore */ specifier).catch(() => null)) as Record<
      string,
      unknown
    > | null;
    expect(typeof shared.binEventSeries, 'binEventSeries is exported').toBe('function');
    expect(mod, 'lib/eventTrendPoints exists').not.toBeNull();
    return {
      bin: shared.binEventSeries as (series: unknown[]) => unknown[],
      points: mod!.buildEventTrendPoints as (input: {
        series: unknown[];
        opponentTag: string;
        t: (key: string) => string;
        locale: string;
      }) => unknown[],
    };
  }

  it('stage detail: the sparg0-sized stage series is over 60 anchors and renders at most 60 points', async () => {
    const { bin, points } = await pipeline();
    const series = buildStageEventSeries({ matches: sparg0, stageId: 1, refreshedAt: 1 });
    expect(series.length).toBeGreaterThan(MARK_BOUND_LINE_POINTS);
    const rendered = points({ series: bin(series), opponentTag: '', t: (k) => k, locale: 'en' });
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
  });

  it("hub: the sparg0-sized fixture's most-played opponent series is over 60 anchors and renders at most 60 points", async () => {
    const { bin, points } = await pipeline();
    const counts = new Map<string, number>();
    for (const m of sparg0) {
      const tag = m.opponent ?? '';
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const series = buildOpponentEventSeries({
      matches: sparg0,
      aliasMap: {},
      opponentTag: top,
      refreshedAt: 1,
    });
    expect(series.length).toBeGreaterThan(MARK_BOUND_LINE_POINTS);
    const rendered = points({ series: bin(series), opponentTag: top, t: (k) => k, locale: 'en' });
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
  });
});

/**
 * Plan 41-09 (VIZ-01, UI-SPEC §11 / §12.5): the Phase 41 half of the whole-phase mark-bound oracle. Every
 * surface the phase rebuilt is held to its bound through its real host — the GSP value trend (<= 60
 * points), each GSP-vs-Glicko panel (<= 60), the Gains band bars (<= 12), the Play rhythm heat (<= 108
 * cells across <= 9 year rows) and the career-timeline event diamonds (<= 40) — and each bound has a
 * non-vacuity companion proving the fixture is OVER the bound before binning, so a pass cannot come from
 * a fixture that was small to begin with.
 */
describe('Phase 41 surfaces (plan 41-09)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const GSP_START_MS = Date.UTC(2025, 0, 6, 12);
  const GSP_SETTINGS: GspSettings = { eliteThreshold: 10_500_000, updatedAt: GSP_START_MS };

  /** `count` readings over `spanDays`, rising 5k each, a win on two of every three. */
  function gspReadings(count: number, spanDays: number): GspPoint[] {
    return Array.from({ length: count }, (_, i) => ({
      time: GSP_START_MS + Math.round((i * spanDays * DAY_MS) / count),
      gsp: 9_000_000 + i * 5_000,
      win: i % 3 !== 0,
    }));
  }

  /** One quickplay match per day, each carrying a GSP reading — the readings and the Glicko sessions line up. */
  function gspMatches(count: number): Match[] {
    return Array.from({ length: count }, (_, i) =>
      makeMatch({
        id: `gm${i}`,
        time: GSP_START_MS + i * DAY_MS,
        win: i % 3 !== 0,
        gsp: 9_800_000 + i * 4_000,
      }),
    );
  }

  /** Every month of `years` consecutive years carries one game: the densest legal heat. */
  function everyMonthFor(years: number, firstYear: number): Match[] {
    const games: Match[] = [];
    for (let y = 0; y < years; y += 1) {
      for (let m = 0; m < 12; m += 1) {
        games.push(
          makeMatch({
            id: `heat-${y}-${m}`,
            time: Date.UTC(firstYear + y, m, 10, 12),
            win: (y + m) % 2 === 0,
          }),
        );
      }
    }
    return games;
  }

  function leaksDirection(container: HTMLElement): boolean {
    const classed = Array.from(container.querySelectorAll('[class]')).some((el) =>
      el
        .getAttribute('class')!
        .split(/\s+/)
        .some((token) => token === 'up' || token === 'down'),
    );
    return classed || container.querySelector('[data-direction]') !== null;
  }

  describe('bounds hold on a realistically large fixture', () => {
    it('GSP curve: 200 readings render at most 60 points through the host', () => {
      const series = gspReadings(200, 18 * 30);
      const { container } = render(
        <GspCurve series={series} settings={GSP_SETTINGS} chartWidth={830} />,
      );
      const root = container.querySelector('[data-slot="trend-line-value"]')!;
      expect(Number(root.getAttribute('data-point-count'))).toBeLessThanOrEqual(
        MARK_BOUND_LINE_POINTS,
      );
      expect(root.querySelectorAll('[data-slot="trend-value-dot"]').length).toBeLessThanOrEqual(
        MARK_BOUND_LINE_POINTS,
      );
    });

    it('GSP curve structurally: the exact buildValueSeries call the host makes never exceeds the bound (the FighterHero precedent for a plot jsdom measures at 0x0)', () => {
      const readings: ValueSeriesReading[] = gspReadings(200, 18 * 30).map((point) => ({
        atMs: point.time,
        value: point.gsp,
        calibration: point.win === null,
      }));
      const built = buildValueSeries(readings, { target: MARK_BOUND_LINE_POINTS });
      expect(built.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
    });

    it('non-vacuity companion: the 200-reading fixture is over the bound before binning and the host really draws points', () => {
      const series = gspReadings(200, 18 * 30);
      expect(series.length).toBeGreaterThan(MARK_BOUND_LINE_POINTS);
      const { container } = render(
        <GspCurve series={series} settings={GSP_SETTINGS} chartWidth={830} />,
      );
      const root = container.querySelector('[data-slot="trend-line-value"]')!;
      expect(Number(root.getAttribute('data-point-count'))).toBeGreaterThan(10);
      expect(root.getAttribute('data-grain')).not.toBe('reading');
    });

    it('GSP vs Glicko: 200 readings and 300 rating periods draw at most 60 points in EACH panel', () => {
      const matches = gspMatches(300);
      const series: GspPoint[] = matches.map((m) => ({ time: m.time, gsp: m.gsp!, win: m.win }));
      const periods = computeRatingHistory(matches).periods;
      // Non-vacuity: both inputs are over the bound before binning.
      expect(series.length).toBeGreaterThan(MARK_BOUND_LINE_POINTS);
      expect(periods.length).toBeGreaterThan(MARK_BOUND_LINE_POINTS);

      const panels = buildGspVsGlickoPanels({ mmr: toMmrSeries(series), periods });
      expect(panels.mmr.points.length).toBeGreaterThan(10);
      expect(panels.mmr.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
      expect(panels.glicko.points.length).toBeGreaterThan(10);
      expect(panels.glicko.points.length).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);

      const { container } = render(
        <GspVsGlicko
          gspSeries={series}
          allMatches={matches}
          settings={GSP_SETTINGS}
          chartWidth={830}
        />,
      );
      const roots = container.querySelectorAll('[data-slot="trend-line-value"]');
      expect(roots).toHaveLength(2);
      for (const root of Array.from(roots)) {
        const count = Number(root.getAttribute('data-point-count'));
        expect(count).toBeGreaterThan(10);
        expect(count).toBeLessThanOrEqual(MARK_BOUND_LINE_POINTS);
      }
    });

    it('Gains bands: wins spread over 1M-40M GSP list at most 12 bands and the card draws that many bar rows', () => {
      // Climb 1M -> 40M in +200k wins with a -100k loss every third game.
      const series: GspPoint[] = [{ time: GSP_START_MS, gsp: 1_000_000, win: true }];
      let gsp = 1_000_000;
      for (let i = 1; gsp < 40_000_000; i += 1) {
        const win = i % 3 !== 0;
        gsp += win ? 200_000 : -100_000;
        series.push({ time: GSP_START_MS + i * 60_000, gsp, win });
      }
      const stats = getGspGainStats(series);
      // Non-vacuity: the wins span far more bands than 12 at the narrowest ladder width (250k).
      const levels = stats.perWinLevels;
      const narrowestBands =
        Math.floor(Math.max(...levels) / 250_000) - Math.floor(Math.min(...levels) / 250_000) + 1;
      expect(narrowestBands).toBeGreaterThan(GSP_BAND_MAX_BANDS);
      expect(stats.gainsByBand.length).toBeGreaterThan(3);
      expect(stats.gainsByBand.length).toBeLessThanOrEqual(GSP_BAND_MAX_BANDS);

      const { container } = render(<GainsAnalysis stats={stats} />);
      const list = container.querySelector('[data-slot="comparison-bars-series"]')!;
      const rows = within(list as HTMLElement).getAllByRole('listitem');
      expect(rows).toHaveLength(stats.gainsByBand.length);
      expect(rows.length).toBeLessThanOrEqual(GSP_BAND_MAX_BANDS);
    });

    it('Play rhythm heat: a 10-year fixture draws 9 year rows of 12 = at most 108 cells and says 9 of 10 years shown', () => {
      const matches = everyMonthFor(10, 2016);
      // Non-vacuity: ten distinct years of games exist before the cap and the uncapped heat is over the bound.
      expect(buildActivityHeat(matches, { maxYears: 99 }).years).toHaveLength(10);
      expect(10 * 12).toBeGreaterThan(MARK_BOUND_HEAT_CELLS);

      const { container } = render(<PlayRhythmHeat matches={matches} onSelectMonth={() => {}} />);
      const root = container.querySelector('[data-slot="matrix-heat-volume"]')!;
      const buttons = root.querySelectorAll('button').length;
      const placeholders = root.querySelectorAll('.bg-muted\\/20').length;
      const rows = root.querySelectorAll('span[aria-label]').length;
      expect(buttons).toBeGreaterThan(0);
      expect(buttons + placeholders).toBeLessThanOrEqual(MARK_BOUND_HEAT_CELLS);
      expect(rows).toBeLessThanOrEqual(ACTIVITY_HEAT_MAX_YEARS);
      expect(rows).toBeGreaterThan(1);
      expect(root.textContent).not.toContain('2016');
      expect(container.textContent).toContain('9 of 10 years shown');
    });

    describe('career timeline event diamonds', () => {
      const PRO = generateSyntheticMatches({
        seed: 39_134_001,
        count: 6_000,
        startMs: Date.UTC(2018, 11, 18, 18),
        sessionSizeRange: [6, 28],
        sessionGapMs: 135 * 60 * 60 * 1000,
        winRate: 0.73,
        mainFighterIds: [8, 22],
        opponentFighterIds: [1, 10],
        stageIds: [1],
      });

      it('55 qualifying resolved entries draw at most 40 diamonds', () => {
        const entries: TierSplitEntry[] = Array.from({ length: 55 }, (_, i) => ({
          entryKey: `major-${i}`,
          tournamentName: `Major ${i}`,
          eventName: 'Ultimate Singles',
          firstSetAt: PRO[100 + i * 100]!.time,
          lastSetAt: PRO[100 + i * 100]!.time + 1,
          isOnline: false,
          tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 1 },
        }));
        // 41-REVIEW CR-01: a diamond needs listable games, so each entry owns the game it dates from.
        const resolved = resolveEntryTiers(entries, PRO).map((item, i) => ({
          ...item,
          matches: [PRO[100 + i * 100]!],
        }));
        // Non-vacuity: all 55 resolve to a known major tier, so the 40 cap is what binds.
        expect(resolved.filter((entry) => entry.resolution.tier === 'major')).toHaveLength(55);
        expect(resolved.length).toBeGreaterThan(TIMELINE_EVENT_MARKER_MAX);

        const { container } = render(
          <CareerTimelineCard
            matches={PRO}
            horizon="last30"
            chartWidth={1000}
            resolvedEntries={resolved}
          />,
        );
        const drawn = container.querySelectorAll('[data-slot="career-timeline-event"]');
        expect(drawn.length).toBeGreaterThan(0);
        expect(drawn.length).toBeLessThanOrEqual(TIMELINE_EVENT_MARKER_MAX);
        expect(TIMELINE_EVENT_MARKER_MAX).toBe(40);
      });
    });
  });

  describe('sparse fixtures: a real branch, never an empty frame', () => {
    const TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'playRhythm')!;
    const sparse: { name: string; build: () => Match[] }[] = [
      { name: 'empty workspace', build: emptyWorkspace },
      { name: 'one-game workspace', build: oneGameWorkspace },
      { name: 'two-game workspace', build: twoGameWorkspace },
      { name: 'unknown-stage-only workspace', build: unknownStageOnlyWorkspace },
    ];

    function playRhythmFor(matches: Match[]): Insight[] {
      return TEMPLATE.build({
        matches,
        scope: ACCOUNT_SCOPE,
        horizon: 'last30',
        nowMs: Date.UTC(2026, 5, 15, 12),
      });
    }

    for (const readingCount of [0, 1, 2]) {
      it(`GSP curve with ${readingCount} reading(s): the locked sentence or content, never an empty frame`, () => {
        const { container } = render(
          <GspCurve
            series={gspReadings(readingCount, 5)}
            settings={GSP_SETTINGS}
            chartWidth={830}
          />,
        );
        expect(container.querySelector('canvas')).toBeNull();
        expect((container.textContent ?? '').trim().length).toBeGreaterThan(0);
        expect(container.textContent).not.toMatch(/\bgsp\.[a-z]+\./);
        expect(directionChipTexts(container)).toEqual([]);
      });

      it(`Gains with ${readingCount} reading(s): the empty sentence or content, never an empty frame`, () => {
        const { container } = render(
          <GainsAnalysis stats={getGspGainStats(gspReadings(readingCount, 5))} />,
        );
        expect((container.textContent ?? '').trim().length).toBeGreaterThan(0);
        expect(container.textContent).not.toMatch(/\bgsp\.[a-z]+\./);
      });

      it(`GSP vs Glicko with ${readingCount} reading(s): hidden by its gate (the page then gives the note the whole row) — never an empty frame`, () => {
        const matches = gspMatches(readingCount);
        const { container } = render(
          <GspVsGlicko
            gspSeries={matches.map((m) => ({ time: m.time, gsp: m.gsp!, win: m.win }))}
            allMatches={matches}
            settings={GSP_SETTINGS}
            chartWidth={830}
          />,
        );
        // Below the gate the card returns null: no card at all, which is the designed state, not a blank card.
        expect(container.querySelector('[data-slot="chart-card"], [data-slot="card"]')).toBeNull();
        expect(container.textContent ?? '').toBe('');
      });
    }

    it('non-vacuity companion: the same GSP vs Glicko card DOES draw once both series reach the gate', () => {
      const matches = gspMatches(12);
      const { container } = render(
        <GspVsGlicko
          gspSeries={matches.map((m) => ({ time: m.time, gsp: m.gsp!, win: m.win }))}
          allMatches={matches}
          settings={GSP_SETTINGS}
          chartWidth={830}
        />,
      );
      expect(container.querySelectorAll('[data-slot="trend-line-value"]')).toHaveLength(2);
    });

    for (const fixture of sparse) {
      it(`Play rhythm on the ${fixture.name}: the heat and the read each render a real branch (or the page mounts neither), and no direction anywhere`, () => {
        const matches = fixture.build();
        const insights = playRhythmFor(matches);
        if (matches.length === 0) {
          // The page mounts neither the read nor the heat for zero games (TrendsPage: matches.length > 0).
          expect(insights).toEqual([]);
          return;
        }
        expect(insights).toHaveLength(1);
        expect(insights[0]!.state).toBe('locked');
        expect(insights[0]!.deltaPoints).toBeNull();

        const heat = render(<PlayRhythmHeat matches={matches} onSelectMonth={() => {}} />);
        expect((heat.container.textContent ?? '').trim().length).toBeGreaterThan(0);
        expect(heat.container.querySelectorAll('button').length).toBeGreaterThan(0);
        expect(leaksDirection(heat.container)).toBe(false);
        expect(directionChipTexts(heat.container)).toEqual([]);

        const router = createMemoryRouter(
          [
            {
              path: '/trends',
              element: <PlayRhythmCard insight={insights[0]!} onDismiss={() => undefined} />,
            },
          ],
          { initialEntries: ['/trends'] },
        );
        const card = render(<RouterProvider router={router} />);
        const root = card.container.querySelector('[data-slot="play-rhythm-card"]')!;
        expect((root.textContent ?? '').trim().length).toBeGreaterThan(0);
        expect(leaksDirection(card.container)).toBe(false);
        expect(directionChipTexts(card.container)).toEqual([]);
      });
    }

    it('non-vacuity companion: the direction detector fires on a synthetic .up element and on a delta chip', () => {
      const probe = document.createElement('div');
      probe.innerHTML = '<span class="chip up">+3 pts</span>';
      expect(leaksDirection(probe)).toBe(true);
      expect(directionChipTexts(probe)).toEqual(['+3 pts']);
    });
  });
});

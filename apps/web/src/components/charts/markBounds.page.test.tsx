import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  CAREER_TIMELINE_NARROW_STRIP_CELLS,
  MARK_BOUND_HEAT_CELLS,
  MARK_BOUND_LINE_POINTS,
  MARK_BOUND_STRIP_TICKS,
  buildOpponentEventSeries,
  buildPeriodSeries,
  buildStageEventSeries,
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
    for (const m of sparg0) counts.set(m.opponent, (counts.get(m.opponent) ?? 0) + 1);
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

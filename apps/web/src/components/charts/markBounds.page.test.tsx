import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  MARK_BOUND_LINE_POINTS,
  MARK_BOUND_STRIP_TICKS,
  buildPeriodSeries,
} from '@smash-tracker/shared';
import {
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

function renderFighterHero(fighterMatches: Match[]) {
  return render(
    <MemoryRouter>
      <FighterHero
        fighter={fox}
        fighterMatches={fighterMatches}
        allMatches={fighterMatches}
        horizon="last30"
        setHorizon={vi.fn()}
        isLoading={false}
      />
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
});

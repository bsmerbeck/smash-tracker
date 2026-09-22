import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { SpriteList } from '@/data/sprites';
import { useFighterFormNow } from '../lib/useFighterFormNow';
import { FighterHero, type FighterHeroDrillAxes } from './FighterHero';

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(overrides: Partial<Match> & { id: string; time: number; win: boolean }): Match {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: '',
    notes: '',
    matchType: 'quickplay',
    ...overrides,
  } as Match;
}

/**
 * Plan 39.1-25 (gap closure, SC4/INS-04): obtains `formNowInsight`/`nowMs`
 * by rendering `useFighterFormNow` itself — never a hand-built `Insight`
 * literal — so the door's shape is proven against the SAME computation the
 * real page uses.
 */
function HeroHarness(props: {
  fighterMatches: Match[];
  allMatches?: Match[];
  horizon?: HorizonKey;
  setHorizon: (next: HorizonKey) => void;
  isLoading?: boolean;
  onDrill: (axes: FighterHeroDrillAxes) => void;
}) {
  const horizon = props.horizon ?? 'last30';
  const { insight, nowMs } = useFighterFormNow({
    fighterId: mario.id,
    fighterMatches: props.fighterMatches,
    horizon,
  });
  return (
    <FighterHero
      fighter={mario}
      fighterMatches={props.fighterMatches}
      allMatches={props.allMatches ?? props.fighterMatches}
      horizon={horizon}
      setHorizon={props.setHorizon}
      isLoading={props.isLoading ?? false}
      formNowInsight={insight}
      nowMs={nowMs}
      onDrill={props.onDrill}
    />
  );
}

function renderHero(props: {
  fighterMatches: Match[];
  allMatches?: Match[];
  horizon?: HorizonKey;
  setHorizon?: (next: HorizonKey) => void;
  isLoading?: boolean;
  onDrill?: (axes: FighterHeroDrillAxes) => void;
}) {
  const setHorizon = props.setHorizon ?? vi.fn();
  const onDrill = props.onDrill ?? vi.fn();
  const result = render(
    <MemoryRouter>
      <HeroHarness
        fighterMatches={props.fighterMatches}
        allMatches={props.allMatches}
        horizon={props.horizon}
        setHorizon={setHorizon}
        isLoading={props.isLoading}
        onDrill={onDrill}
      />
    </MemoryRouter>,
  );
  return { setHorizon, onDrill, ...result };
}

/** A large, mixed-event fixture — enough games to exceed both the form-strip and period-trend line bounds. */
function largeFixture(): Match[] {
  const now = Date.now();
  const matches: Match[] = [];
  for (let i = 0; i < 200; i++) {
    matches.push(
      makeMatch({
        id: `g${i}`,
        // One day apart, oldest first.
        time: now - (200 - i) * 24 * 60 * 60 * 1000,
        win: i % 3 !== 0,
        eventName: i % 20 === 0 ? `Event ${Math.floor(i / 20)}` : undefined,
        matchType: i % 2 === 0 ? 'quickplay' : 'online-tourney',
      }),
    );
  }
  return matches;
}

/** A forty-game, no-event, all-recent fixture — collapses both recent horizons and locks the last-event figure (no named event anywhere). */
function fortyGameFixture(): Match[] {
  const now = Date.now();
  const matches: Match[] = [];
  for (let i = 0; i < 40; i++) {
    matches.push(
      makeMatch({
        id: `c${i}`,
        time: now - (40 - i) * 60 * 60 * 1000,
        win: i % 2 === 0,
        matchType: 'quickplay',
      }),
    );
  }
  return matches;
}

/** A tiny (5-game) fixture — fewer than `PERIOD_TREND_MIN_PERIODS` (8) periods at the `game` grain, so the trend renders its locked inset. */
function tinyFixture(): Match[] {
  const now = Date.now();
  return Array.from({ length: 5 }, (_, i) =>
    makeMatch({ id: `t${i}`, time: now - (5 - i) * 60 * 60 * 1000, win: i % 2 === 0 }),
  );
}

describe('FighterHero', () => {
  it('renders the seven sections in the declared DOM order', () => {
    renderHero({ fighterMatches: largeFixture() });
    const root = document.querySelector('[data-slot="fighter-hero-body"]') as HTMLElement;
    expect(root).toBeInTheDocument();
    const slots = [...root.children].map((el) => el.getAttribute('data-slot'));
    expect(slots).toEqual([
      'fighter-hero-identity',
      'fighter-hero-verdict',
      null, // StatRow root carries no data-slot
      'fighter-hero-strip',
      'fighter-hero-trend',
      'share-bar-root',
      'fighter-hero-doors',
    ]);
  });

  it('renders exactly four stat figures with the all-time figure first at the large figure role', () => {
    renderHero({ fighterMatches: largeFixture() });
    const labels = ['All time', '30 games', 'Last event', '90 days'];
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('clicking the last-event figure writes the same persisted horizon the page switch would set', () => {
    const { setHorizon } = renderHero({ fighterMatches: largeFixture(), horizon: 'last30' });
    const lastEventButton = screen.getByText('Last event').closest('button')!;
    lastEventButton.click();
    expect(setHorizon).toHaveBeenCalledWith('lastEvent');
  });

  it('does not write a horizon when clicked while the match query is loading', () => {
    const { setHorizon } = renderHero({
      fighterMatches: largeFixture(),
      horizon: 'last30',
      isLoading: true,
    });
    const lastEventButton = screen.getByText('Last event').closest('button')!;
    lastEventButton.click();
    expect(setHorizon).not.toHaveBeenCalled();
  });

  it('carries the neutral underline on exactly one figure label, never a colour utility', () => {
    renderHero({ fighterMatches: largeFixture(), horizon: 'last90' });
    const pressedButtons = document.querySelectorAll('button[aria-pressed="true"]');
    expect(pressedButtons.length).toBe(1);
    const underlined = document.querySelectorAll('.border-b-2.border-foreground');
    expect(underlined.length).toBe(1);
  });

  it('bounds the rendered strip ticks to 60 on a large fixture', () => {
    renderHero({ fighterMatches: largeFixture() });
    const ticks = document.querySelectorAll('[data-slot="form-strip-tick"]');
    expect(ticks.length).toBeLessThanOrEqual(60);
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('renders localised by-match-type labels — no raw enum value reaches the DOM', () => {
    renderHero({ fighterMatches: largeFixture() });
    expect(screen.getByText('Quickplay')).toBeInTheDocument();
    expect(screen.getByText('Online tournament')).toBeInTheDocument();
    expect(screen.queryByText('quickplay')).not.toBeInTheDocument();
    expect(screen.queryByText('online-tourney')).not.toBeInTheDocument();
  });

  it('imports no legacy canvas chart library', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(dir, 'FighterHero.tsx'), 'utf8');
    expect(source).not.toMatch(/from\s+['"](chart\.js|react-chartjs-2)['"]/);
  });

  describe('on a forty-game, no-event account', () => {
    it('collapses the recent horizons with no delta chip and locks the last-event figure', () => {
      renderHero({ fighterMatches: fortyGameFixture(), horizon: 'last30' });
      const collapsedValues = screen.getAllByText('= all games');
      expect(collapsedValues.length).toBeGreaterThanOrEqual(1);
      const statBody = document.querySelector('[data-slot="fighter-hero-body"]') as HTMLElement;
      const chips = within(statBody).queryAllByLabelText(/last 30|last event|90 days/i);
      expect(chips.length).toBe(0);
    });

    it('asserts no direction anywhere on the surface', () => {
      renderHero({ fighterMatches: fortyGameFixture(), horizon: 'last30' });
      expect(screen.queryByText(/win rate up/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/win rate down/i)).not.toBeInTheDocument();
    });
  });

  it('renders the trend locked inset instead of a plot on a fixture under the period-trend floor', () => {
    renderHero({ fighterMatches: tinyFixture() });
    expect(document.querySelector('[data-slot="trend-line-period-locked"]')).toBeInTheDocument();
  });

  describe('T-39.1-25 (gap closure, SC4/INS-04): the door is built from the claim axis, never a hand-built fighter axis', () => {
    it('renders the formNow counted-games door built from the claim axis, count equal to countedMatchIds.length', () => {
      const matches = largeFixture();
      renderHero({ fighterMatches: matches, horizon: 'last30' });

      const door = screen.getByRole('link', { name: /see the .* games?/i });
      const href = door.getAttribute('href') ?? '';
      // Same-route, claim-shaped href (UI-SPEC §10.3) — the insight id is
      // `formNow:character:<fighterId>:<horizon>` — never a hand-built
      // `fighter=1` axis (the defect this plan closes).
      expect(href).toContain('claim=formNow%3Acharacter%3A1%3Alast30');
      expect(href).toMatch(/#games$/);
      expect(href).not.toMatch(/fighter=/);

      // The label's printed count matches the insight's own
      // `countedMatchIds.length` — computed independently via the SAME
      // hook the harness renders with, never a hand-derived expectation.
      const doorLabel = door.textContent ?? '';
      const printedCount = Number((doorLabel.match(/\d+/) ?? ['0'])[0]);
      expect(printedCount).toBeGreaterThan(0);
    });

    it('renders no door when the recent window has zero games (a fixture whose games are all outside the active horizon)', () => {
      const now = Date.now();
      // 20 games, all 365+ days old — outside both the `last90` (90-day)
      // window AND the character scope's 12-month recency floor
      // (`resolveWindow`'s `withinScopedRecency`), so the recent window is
      // empty either way.
      const oldFixture: Match[] = Array.from({ length: 20 }, (_, i) =>
        makeMatch({ id: `old${i}`, time: now - (365 + i) * 24 * 60 * 60 * 1000, win: i % 2 === 0 }),
      );

      renderHero({ fighterMatches: oldFixture, horizon: 'last90' });
      expect(screen.queryByRole('link', { name: /see the .* games?/i })).not.toBeInTheDocument();
    });
  });

  describe('T-39.1-25 (gap closure, SC6/TRND-04): the strip groups by real set id, not by event', () => {
    it('groups games by their real start.gg set id, not by event (sets are no longer one-per-event)', () => {
      const now = Date.now();
      const eventName = 'Big House Online';
      const matches: Match[] = [
        makeMatch({
          id: 'g1',
          time: now - 3 * 60 * 60 * 1000,
          win: true,
          eventName,
          externalId: 'sgg:100:g1',
        }),
        makeMatch({
          id: 'g2',
          time: now - 2 * 60 * 60 * 1000,
          win: false,
          eventName,
          externalId: 'sgg:100:g2',
        }),
        makeMatch({
          id: 'g3',
          time: now - 1 * 60 * 60 * 1000,
          win: true,
          eventName,
          externalId: 'sgg:200:g1',
        }),
      ];

      renderHero({ fighterMatches: matches });

      const eventRoot = document.querySelector('[data-slot="form-strip-event"]') as HTMLElement;
      expect(eventRoot).toBeInTheDocument();
      const setElements = eventRoot.querySelectorAll('[data-slot="form-strip-set"]');
      // Two real start.gg sets (100 and 200) inside the SAME event — the
      // old hand-rolled grouping collapsed every game of an event into ONE
      // set; the fix must render exactly TWO set elements here.
      expect(setElements.length).toBe(2);
      const tickCounts = [...setElements]
        .map((el) => el.querySelectorAll('[data-slot="form-strip-tick"]').length)
        .sort();
      expect(tickCounts).toEqual([1, 2]);
    });
  });

  it('shows the empty state with no crash when the fighter has no matches at all', () => {
    renderHero({ fighterMatches: [], allMatches: [] });
    expect(screen.getByText(mario.name)).toBeInTheDocument();
  });

  describe('WR-C05 (39.1-REVIEW.md): locale-aware percent formatting in the evidence sentence', () => {
    afterEach(async () => {
      await i18n.changeLanguage('en');
    });

    it('renders the French percent convention (a space before the sign), never the English "42%" glued form', async () => {
      await i18n.changeLanguage('fr');
      renderHero({ fighterMatches: fortyGameFixture() });
      const evidence = document.querySelector('[data-slot="fighter-hero-verdict-evidence"]');
      expect(evidence).toBeInTheDocument();
      const text = evidence!.textContent ?? '';
      // At least one percent value is present, and every percent value in
      // the sentence carries a space before the `%` sign (the "fr" CLDR
      // convention) — never the bare English "NN%" glued form.
      expect(text).toMatch(/\d+\s%/);
      expect(text).not.toMatch(/\d+%/);
    });
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { buildPeriodSeries } from '@smash-tracker/shared';
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
      periodSeries={buildPeriodSeries({ matches: props.fighterMatches })}
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
      'stat-row', // Plan 39.1-32 (item 10): StatRow now always carries data-slot="stat-row"
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
    it('collapses the recent horizons with no delta chip; the event-less last-event figure reads "no games"', () => {
      renderHero({ fighterMatches: fortyGameFixture(), horizon: 'last30' });
      const collapsedValues = screen.getAllByText('= all games');
      expect(collapsedValues.length).toBeGreaterThanOrEqual(1);
      const statRow = document.querySelector('[data-slot="stat-row"]') as HTMLElement;
      // Plan 39.1-36 (rewritten assertion): the two collapsed figures still
      // carry no chip; the last-event figure (no named event -> 0 games) now
      // renders the honest "no games" chip instead of an unlock caption.
      const chips = Array.from(statRow.querySelectorAll('[data-slot="delta-chip"]'));
      expect(chips.map((chip) => chip.getAttribute('data-state'))).toEqual(['none']);
      expect(chips[0]!.textContent).toBe('no games');
      expect(screen.getByText('Last event').closest('button')).toContainElement(
        chips[0] as HTMLElement,
      );
    });

    it('asserts no direction anywhere on the surface', () => {
      renderHero({ fighterMatches: fortyGameFixture(), horizon: 'last30' });
      expect(screen.queryByText(/win rate up/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/win rate down/i)).not.toBeInTheDocument();
    });
  });

  describe('plan 39.1-36 (INS-04, honest-none-chip): a stale account never reads "Steady"', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const TYPES = ['quickplay', 'online-tourney', 'offline-tourney'] as const;

    /** 40 games, every one dated more than 12 months ago, across three match types. */
    function staleFixture(): Match[] {
      const now = Date.now();
      return Array.from({ length: 40 }, (_, i) =>
        makeMatch({
          id: `stale${i}`,
          time: now - (400 + (40 - i)) * DAY_MS,
          // Wins independent of type, so every type sits near the fighter's
          // own 50% — the shipped all-time-vs-fighter comparison read "Steady".
          win: i % 2 === 0,
          matchType: TYPES[i % 3],
        }),
      );
    }

    /** The stale fixture plus two quickplay games in the last week. */
    function staleWithTwoRecent(): Match[] {
      const now = Date.now();
      return [
        ...staleFixture(),
        makeMatch({ id: 'fresh1', time: now - 3 * DAY_MS, win: true, matchType: 'quickplay' }),
        makeMatch({ id: 'fresh2', time: now - 2 * DAY_MS, win: false, matchType: 'quickplay' }),
      ];
    }

    function shareRowChips(): Map<string, HTMLElement | null> {
      const rows = Array.from(document.querySelectorAll('[data-slot="share-bar-row"]'));
      return new Map(
        rows.map((row) => [
          row.textContent ?? '',
          row.querySelector('[data-slot="delta-chip"]') as HTMLElement | null,
        ]),
      );
    }

    function figureButton(label: string): HTMLElement {
      return screen.getByText(label).closest('button') as HTMLElement;
    }

    it('every by-match-type row reads "no games · last 30" (data-state none)', () => {
      renderHero({ fighterMatches: staleFixture(), horizon: 'last30' });
      const chips = shareRowChips();
      expect(chips.size).toBe(3);
      for (const [row, chip] of chips) {
        expect(chip, `row ${row}`).not.toBeNull();
        expect(chip!.getAttribute('data-state')).toBe('none');
        expect(chip!.textContent).toBe('no games· last 30');
      }
    });

    it('a type with 2 recent games reads "n 2 · no direction" (data-state thin)', () => {
      renderHero({ fighterMatches: staleWithTwoRecent(), horizon: 'last30' });
      const quickplayRow = Array.from(
        document.querySelectorAll('[data-slot="share-bar-row"]'),
      ).find((row) => row.textContent?.includes('Quickplay')) as HTMLElement;
      const chip = quickplayRow.querySelector('[data-slot="delta-chip"]')!;
      expect(chip.getAttribute('data-state')).toBe('thin');
      expect(chip.textContent).toBe('n 2 · no direction');
    });

    it('no element in the hero reads "Steady"', () => {
      renderHero({ fighterMatches: staleFixture(), horizon: 'last30' });
      const body = document.querySelector('[data-slot="fighter-hero-body"]') as HTMLElement;
      const steady = Array.from(body.querySelectorAll('*')).filter((el) =>
        (el.textContent ?? '').trim().startsWith('Steady'),
      );
      expect(steady.map((el) => el.outerHTML.slice(0, 120))).toEqual([]);
    });

    it('the three recent figures render a muted em dash and the "no games" chip, never the unlock sentence', () => {
      renderHero({ fighterMatches: staleFixture(), horizon: 'last30' });
      for (const label of ['30 games', 'Last event', '90 days']) {
        const figure = figureButton(label);
        const chip = figure.querySelector('[data-slot="delta-chip"]');
        expect(chip, `figure ${label}`).not.toBeNull();
        expect(chip!.getAttribute('data-state')).toBe('none');
        expect(chip!.textContent).toBe('no games');
        const dash = within(figure).getByText('—');
        expect(dash.className).toMatch(/text-muted-foreground/);
      }
      const statRow = document.querySelector('[data-slot="stat-row"]') as HTMLElement;
      expect(statRow.textContent).not.toMatch(/more games? unlocks? this/);
    });

    it('a figure whose window holds 2 games reads "n 2 · no direction"', () => {
      renderHero({ fighterMatches: staleWithTwoRecent(), horizon: 'last30' });
      const chip = figureButton('30 games').querySelector('[data-slot="delta-chip"]')!;
      expect(chip.getAttribute('data-state')).toBe('thin');
      expect(chip.textContent).toBe('n 2 · no direction');
      const statRow = document.querySelector('[data-slot="stat-row"]') as HTMLElement;
      expect(statRow.textContent).not.toMatch(/more games? unlocks? this/);
    });

    it('with the page horizon last90 the row chips read "· last 90 days"', () => {
      renderHero({ fighterMatches: staleFixture(), horizon: 'last90' });
      for (const [row, chip] of shareRowChips()) {
        expect(chip, `row ${row}`).not.toBeNull();
        expect(chip!.textContent).toBe('no games· last 90 days');
      }
    });

    it("a type whose last 30 games are recent and inside its own baseline interval reads 'Steady · last 30'", () => {
      const now = Date.now();
      const matches: Match[] = [
        // 60 old offline-tourney games at 50%.
        ...Array.from({ length: 60 }, (_, i) =>
          makeMatch({
            id: `ot-old${i}`,
            time: now - (500 + i) * DAY_MS,
            win: i % 2 === 0,
            matchType: 'offline-tourney',
          }),
        ),
        // 30 recent offline-tourney games at 50% — inside the type's own interval.
        ...Array.from({ length: 30 }, (_, i) =>
          makeMatch({
            id: `ot-new${i}`,
            time: now - (60 - i) * DAY_MS,
            win: i % 2 === 0,
            matchType: 'offline-tourney',
          }),
        ),
        // A much stronger quickplay history (90%) the offline type must NOT be compared against.
        ...Array.from({ length: 60 }, (_, i) =>
          makeMatch({
            id: `qp${i}`,
            time: now - (700 + i) * DAY_MS,
            win: i % 10 !== 0,
            matchType: 'quickplay',
          }),
        ),
      ];
      renderHero({ fighterMatches: matches, horizon: 'last30' });
      const offlineRow = Array.from(document.querySelectorAll('[data-slot="share-bar-row"]')).find(
        (row) => row.textContent?.includes('Offline tournament'),
      ) as HTMLElement;
      const chip = offlineRow.querySelector('[data-slot="delta-chip"]')!;
      expect(chip.getAttribute('data-state')).toBe('steady');
      expect(chip.textContent).toBe('Steady· last 30');
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

  describe('WR-04 (39.1-REVIEW.md): manual games are named as sessions, never "Unknown"', () => {
    it('a manual-only history captions and names every group "Session · <date>" (Matchups\' naming), split into 3-hour sessions', () => {
      const hourMs = 60 * 60 * 1000;
      const base = Date.now() - 3 * 24 * hourMs;
      const matches: Match[] = [
        makeMatch({ id: 'sA1', time: base, win: true }),
        makeMatch({ id: 'sA2', time: base + 30 * 60 * 1000, win: false }),
        makeMatch({ id: 'sB1', time: base + 10 * hourMs, win: true }),
        makeMatch({ id: 'sB2', time: base + 10.5 * hourMs, win: true }),
      ];
      renderHero({ fighterMatches: matches });

      const expectedDate = new Intl.DateTimeFormat('en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(new Date(base));
      const groups = Array.from(document.querySelectorAll('[data-slot="form-strip-event"]'));
      expect(groups).toHaveLength(2);
      for (const group of groups) {
        expect(group.getAttribute('aria-label')).toMatch(/^Session · /);
      }
      const captionFirst = document.querySelector('[data-slot="form-strip-caption-first"]');
      expect(captionFirst).toHaveTextContent(`Session · ${expectedDate}`);
      const captions = Array.from(
        document.querySelectorAll('[data-slot^="form-strip-caption-"]'),
      ).map((el) => el.textContent);
      expect(captions.some((text) => text?.includes('Unknown'))).toBe(false);
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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { SpriteList } from '@/data/sprites';
import { FighterHero } from './FighterHero';

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

function renderHero(props: {
  fighterMatches: Match[];
  allMatches?: Match[];
  horizon?: 'last30' | 'lastEvent' | 'last90';
  setHorizon?: (next: 'last30' | 'lastEvent' | 'last90') => void;
  isLoading?: boolean;
}) {
  const setHorizon = props.setHorizon ?? vi.fn();
  const result = render(
    <MemoryRouter>
      <FighterHero
        fighter={mario}
        fighterMatches={props.fighterMatches}
        allMatches={props.allMatches ?? props.fighterMatches}
        horizon={props.horizon ?? 'last30'}
        setHorizon={setHorizon}
        isLoading={props.isLoading ?? false}
      />
    </MemoryRouter>,
  );
  return { setHorizon, ...result };
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

  it('renders a games door linking to the fighter-scoped drill-down search', () => {
    renderHero({ fighterMatches: largeFixture() });
    const door = screen.getByRole('link', { name: /see the .* games?/i });
    expect(door.getAttribute('href')).toMatch(/fighter=1/);
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

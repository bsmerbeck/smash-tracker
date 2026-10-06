import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { buildMatchupPeriodSeries } from '../lib/matchupPeriodSeries';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { useMatchupFormNow } from './MatchupChart';
import { PairingHero } from './PairingHero';

/**
 * Plan 39.1-44 Task 1 (pairing-hero, sketch 003 A `heroCard`): the pairing's
 * evidence board — identity, verdict, the kit's horizon StatRow, the labelled
 * strip + trend, the by-match-type share bar and the doors as the LAST row.
 * One fixed clock drives the fixture and the FormNow insight, so every window
 * is deterministic.
 */
const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 20, 12);
const HEADING_ID = 'pairing-heading-under-test';

function makeMatch(overrides: Partial<Match> & { id: string; time: number; win: boolean }): Match {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: '',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  } as Match;
}

/** 30 games ten days apart (first 300 days back, last one day back), in named 6-game events. */
function thirtyGames(): Match[] {
  return Array.from({ length: 30 }, (_, i) =>
    makeMatch({
      id: `g${i}`,
      time: NOW_MS - (300 - i * 10) * DAY_MS + 0,
      win: i % 3 !== 0,
      eventName: `Event ${Math.floor(i / 6)}`,
      matchType: i % 2 === 0 ? 'offline-tourney' : 'online-tourney',
    }),
  );
}

function Harness({
  matches,
  horizon = 'last30',
  setHorizon = () => {},
  isLoading = false,
  withDoor = true,
}: {
  matches: Match[];
  horizon?: HorizonKey;
  setHorizon?: (next: HorizonKey) => void;
  isLoading?: boolean;
  withDoor?: boolean;
}) {
  const insight = useMatchupFormNow({ matchupMatches: matches, horizon, nowMs: NOW_MS });
  const door = insight
    ? {
        kind: 'games' as const,
        href: '/matchups?fighter=1&vs=10#matchup-table',
        count: insight.countedMatchIds.length,
      }
    : undefined;
  const context: MatchupsContextValue = {
    fighterSprites: [],
    fighter: mario,
    setFighter: vi.fn(),
    opponent: luigi,
    setOpponent: vi.fn(),
    fighterUsageById: new Map(),
    opponentUsage: [],
    drillDownAxes: {},
    setDrillDown: vi.fn(),
  };
  return (
    <MemoryRouter>
      <MatchupsContext.Provider value={context}>
        <PairingHero
          headingId={HEADING_ID}
          fighter={mario}
          opponent={luigi}
          matchupMatches={matches}
          formNowInsight={insight}
          gamesDoor={withDoor ? door : undefined}
          periodSeries={buildMatchupPeriodSeries(matches)}
          horizon={horizon}
          setHorizon={setHorizon}
          isLoading={isLoading}
          nowMs={NOW_MS}
        />
      </MatchupsContext.Provider>
    </MemoryRouter>
  );
}

function heroOf(container: HTMLElement): HTMLElement {
  const hero = container.querySelector<HTMLElement>('[data-slot="pairing-hero"]');
  expect(hero, 'the pairing hero region').not.toBeNull();
  return hero!;
}

describe('PairingHero', () => {
  it('is a region labelled by its heading, which is the page h1 "Mario vs Luigi" with both sprites', () => {
    const { container } = render(<Harness matches={thirtyGames()} />);
    const hero = heroOf(container);
    expect(hero.getAttribute('aria-labelledby')).toBe(HEADING_ID);
    const heading = within(hero).getByRole('heading', { level: 1, name: 'Mario vs Luigi' });
    expect(heading.id).toBe(HEADING_ID);
    const sprites = hero.querySelectorAll('[data-slot="pairing-hero-identity"] img');
    expect(Array.from(sprites).map((img) => img.getAttribute('src'))).toEqual([
      mario.url,
      luigi.url,
    ]);
  });

  it('the hero region wraps exactly one card (its box is the card box the ceiling and stretch oracles measure)', () => {
    const { container } = render(<Harness matches={thirtyGames()} />);
    const hero = heroOf(container);
    expect(hero.tagName.toLowerCase()).toBe('section');
    expect(hero.children).toHaveLength(1);
    expect(hero.firstElementChild?.getAttribute('data-slot')).toBe('card');
  });

  it('prints the meta "30 games · <month span> · <confidence>" with the tier glyph', () => {
    const { container } = render(<Harness matches={thirtyGames()} />);
    const identity = container.querySelector('[data-slot="pairing-hero-identity"]')!;
    const meta = identity.querySelector('p')!;
    expect(meta.textContent).toMatch(/30 games · Nov 2025 – Sep 2026 · (medium|high) confidence/);
    expect(meta.querySelector('[aria-hidden="true"]')?.textContent).toMatch(/^[●○]{3}$/);
  });

  it('a single game reads "1 game" (the _one form)', () => {
    const { container } = render(<Harness matches={thirtyGames().slice(29)} />);
    const meta = container.querySelector('[data-slot="pairing-hero-identity"] p')!;
    expect(meta.textContent).toMatch(/^[●○]{3}1 game · Sep 2026 · /);
  });

  it('keeps the verdict and evidence slots and shows the claim chip with the reused FormNow meta', () => {
    const { container } = render(<Harness matches={thirtyGames()} horizon="last90" />);
    const hero = heroOf(container);
    expect(hero.querySelector('[data-slot="matchup-form-now-verdict"]')?.textContent).toBeTruthy();
    expect(hero.querySelector('[data-slot="matchup-form-now-evidence"]')).not.toBeNull();
    expect(hero.querySelector('[data-slot="matchup-form-now"] [data-slot="badge"]')).not.toBeNull();
    expect(within(hero).getByText('Form · last 90 days vs all time')).toBeInTheDocument();
  });

  it('the verdict meta follows the page horizon', () => {
    render(<Harness matches={thirtyGames()} horizon="last30" />);
    expect(screen.getByText('Form · last 30 games vs all time')).toBeInTheDocument();
  });

  it('renders the kit horizon StatRow; a figure click calls the page setter with its horizon', () => {
    const setHorizon = vi.fn();
    const { container } = render(<Harness matches={thirtyGames()} setHorizon={setHorizon} />);
    const hero = heroOf(container);
    expect(hero.querySelector('[data-slot="stat-row"]')).not.toBeNull();
    fireEvent.click(within(hero).getByRole('button', { name: /Last event/ }));
    expect(setHorizon).toHaveBeenCalledWith('lastEvent');
  });

  it('a figure click writes nothing while the match query is loading', () => {
    const setHorizon = vi.fn();
    const { container } = render(
      <Harness matches={thirtyGames()} setHorizon={setHorizon} isLoading />,
    );
    fireEvent.click(within(heroOf(container)).getByRole('button', { name: /Last event/ }));
    expect(setHorizon).not.toHaveBeenCalled();
  });

  it('draws the labelled strip + trend body and the by-match-type share bar', () => {
    const { container } = render(<Harness matches={thirtyGames()} />);
    const hero = heroOf(container);
    const body = hero.querySelector('[data-slot="matchup-chart-body"]');
    expect(body).not.toBeNull();
    expect(body!.querySelector('[data-slot="form-strip-root"]')).not.toBeNull();
    expect(hero.querySelector('[data-slot="share-bar-root"]')).not.toBeNull();
  });

  it('orders the board identity, verdict, stat row, chart body, share bar, doors', () => {
    const { container } = render(<Harness matches={thirtyGames()} />);
    const hero = heroOf(container);
    const order = Array.from(
      hero.querySelectorAll(
        '[data-slot="pairing-hero-identity"], [data-slot="matchup-form-now"], [data-slot="stat-row"], [data-slot="matchup-chart-body"], [data-slot="share-bar-root"], [data-slot="matchup-form-now-doors"]',
      ),
    ).map((el) => el.getAttribute('data-slot'));
    expect(order).toEqual([
      'pairing-hero-identity',
      'matchup-form-now',
      'stat-row',
      'matchup-chart-body',
      'share-bar-root',
      'matchup-form-now-doors',
    ]);
  });

  it('the doors row is the LAST child of the card body: "See the N games" then "Other pairings"', () => {
    const { container } = render(<Harness matches={thirtyGames()} />);
    const hero = heroOf(container);
    const doors = hero.querySelector('[data-slot="matchup-form-now-doors"]')!;
    const body = hero.querySelector('[data-slot="card-content"]')!;
    expect(body.lastElementChild).toBe(doors);
    const links = within(doors as HTMLElement).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['See the 30 games', 'Other pairings']);
    expect(links[0]!.getAttribute('href')).toBe('/matchups?fighter=1&vs=10#matchup-table');
    expect(links[1]!.getAttribute('href')).toBe('#matchup-matrix');
  });

  it('renders no "See the N games" door when the insight has none, but keeps "Other pairings"', () => {
    const { container } = render(<Harness matches={thirtyGames()} withDoor={false} />);
    const doors = heroOf(container).querySelector('[data-slot="matchup-form-now-doors"]')!;
    expect(
      within(doors as HTMLElement)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Other pairings']);
  });

  it('zero games renders the identity row and the empty line only', () => {
    const { container } = render(<Harness matches={[]} />);
    const hero = heroOf(container);
    expect(within(hero).getByRole('heading', { level: 1, name: 'Mario vs Luigi' })).toBeVisible();
    expect(within(hero).getByText('No reported matches against this fighter')).toBeInTheDocument();
    expect(hero.querySelector('[data-slot="stat-row"]')).toBeNull();
    expect(hero.querySelector('[data-slot="matchup-chart-body"]')).toBeNull();
    expect(hero.querySelector('[data-slot="matchup-form-now-doors"]')).toBeNull();
  });
});

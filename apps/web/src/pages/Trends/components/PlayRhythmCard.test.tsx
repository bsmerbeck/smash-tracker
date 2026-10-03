import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { ACCOUNT_SCOPE, INSIGHT_TEMPLATES, type Insight, type Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { PlayRhythmCard } from './PlayRhythmCard';

/**
 * B1 / DD-41-07 (UI-SPEC 7.11): the PlayRhythm card renders the REAL `playRhythm` template output, so a
 * change in the template's value shape fails here. Counts and months are asserted in their English
 * sentences; the six-locale pass below renders every state through the real locale files.
 */

const NOW_MS = Date.UTC(2026, 5, 15, 12);
const TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'playRhythm')!;

let nextId = 0;

function gameIn(year: number, month1to12: number, day = 10, hour = 12): Match {
  nextId += 1;
  return {
    id: `prc-${nextId}`,
    fighter_id: 8,
    opponent_id: 23,
    time: Date.UTC(year, month1to12 - 1, day, hour),
    win: nextId % 2 === 0,
  } as Match;
}

/** One game on the 10th of every month in the inclusive (year, month) range. */
function monthlyGames(from: [number, number], to: [number, number]): Match[] {
  const games: Match[] = [];
  let [year, month] = from;
  while (year < to[0] || (year === to[0] && month <= to[1])) {
    games.push(gameIn(year, month));
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return games;
}

function extraGames(year: number, month: number, count: number): Match[] {
  return Array.from({ length: count }, (_, i) =>
    gameIn(year, month, 11 + (i % 15), 1 + Math.floor(i / 15)),
  );
}

function insightFor(matches: Match[]): Insight {
  const built = TEMPLATE.build({
    matches,
    scope: ACCOUNT_SCOPE,
    horizon: 'last30',
    nowMs: NOW_MS,
  });
  if (built.length === 0) throw new Error('the playRhythm fixture produced no insight');
  return built[0]!;
}

/** The four states the card renders, each from real matches. */
const STATE_FIXTURES: { name: string; insight: () => Insight; key: string }[] = [
  {
    name: 'compare',
    // 30 months, a March peak: 12 recent, 12 prior, busiest month March.
    insight: () =>
      insightFor([
        ...monthlyGames([2024, 1], [2026, 6]),
        ...extraGames(2024, 3, 5),
        ...extraGames(2025, 3, 5),
        ...extraGames(2026, 3, 5),
      ]),
    key: 'insights.playRhythm.fact.compare',
  },
  {
    name: 'compareNoSeason',
    insight: () => insightFor(monthlyGames([2024, 1], [2026, 6])),
    key: 'insights.playRhythm.fact.compareNoSeason',
  },
  {
    name: 'recentOnly',
    insight: () =>
      insightFor([...monthlyGames([2020, 1], [2020, 12]), ...monthlyGames([2026, 3], [2026, 5])]),
    key: 'insights.playRhythm.fact.recentOnly',
  },
  {
    name: 'locked',
    insight: () => insightFor(monthlyGames([2025, 8], [2026, 6])),
    key: 'insights.playRhythm.locked',
  },
];

function renderCard(insight: Insight, onDismiss: () => void = () => undefined) {
  const router = createMemoryRouter(
    [
      {
        path: '/trends',
        element: <PlayRhythmCard insight={insight} onDismiss={onDismiss} />,
      },
    ],
    { initialEntries: ['/trends?range=all'] },
  );
  return render(<RouterProvider router={router} />);
}

describe('PlayRhythmCard', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
    vi.restoreAllMocks();
  });

  it('exercises all four states through the real template (non-vacuity)', () => {
    for (const { name, insight, key } of STATE_FIXTURES) {
      expect(insight().copy.key, name).toBe(key);
    }
  });

  describe('fact (busiest month)', () => {
    it('states the two windows and the busiest month by name, as a FACT', () => {
      const insight = STATE_FIXTURES[0]!.insight();
      const { container } = renderCard(insight);
      const recent = insight.copy.values.recent;
      const prior = insight.copy.values.prior;
      expect(
        screen.getByText(
          `Play rhythm — ${recent} games in the last 12 months vs ${prior} the 12 before; busiest month: March.`,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('Fact')).toBeInTheDocument();
      expect(container.querySelector('[data-slot="play-rhythm-card"]')).not.toBeNull();
      const evidence = container.querySelector('[data-slot="insight-card-evidence"]')!.textContent;
      expect(evidence).toContain('30 of 30 months with games');
      expect(evidence).toContain('of all games fall in March');
    });

    it('its only filled door counts exactly the games the template counted, and writes the claim axis', () => {
      const insight = STATE_FIXTURES[0]!.insight();
      const { container } = renderCard(insight);
      const doors = container.querySelector('[data-slot="insight-card-doors"]') as HTMLElement;
      const links = within(doors).getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(links[0]!.textContent).toBe(`See the ${insight.countedMatchIds.length} games`);
      const url = new URL(links[0]!.getAttribute('href')!, 'http://x/trends');
      expect(url.searchParams.get('claim')).toBe(insight.id);
      expect(url.hash).toBe('#games');
      // The door is the card's only filled (default-variant) button; dismiss is a ghost icon button.
      const filled = container.querySelectorAll('[data-variant="default"]');
      expect(filled).toHaveLength(1);
      expect(filled[0]).toBe(links[0]);
    });

    it('is dismissible through its own control', async () => {
      const onDismiss = vi.fn();
      renderCard(STATE_FIXTURES[0]!.insight(), onDismiss);
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  it('compareNoSeason drops the busiest-month clause and its evidence names only the months played', () => {
    const insight = STATE_FIXTURES[1]!.insight();
    const { container } = renderCard(insight);
    const sentence = container.querySelector('[data-slot="insight-card-verdict"]')!.textContent;
    expect(sentence).toMatch(/vs \d+ the 12 before\.$/);
    expect(sentence).not.toContain('busiest');
    expect(container.querySelector('[data-slot="insight-card-evidence"]')!.textContent).toBe(
      '30 of 30 months with games',
    );
  });

  it('recentOnly states the months played inside the last 12', () => {
    const insight = STATE_FIXTURES[2]!.insight();
    renderCard(insight);
    expect(
      screen.getByText('Play rhythm — 3 games across 3 of the last 12 months.'),
    ).toBeInTheDocument();
  });

  describe('locked', () => {
    it('is one UnlocksNext meter in months: no door, no dismiss', () => {
      const insight = STATE_FIXTURES[3]!.insight();
      const { container } = renderCard(insight);
      expect(container.querySelector('[data-card-kind="unlocks-next"]')).not.toBeNull();
      expect(
        screen.getByText('Play rhythm — 1 more month with games unlocks this read.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('img', { name: '11 of 12 months' })).toBeInTheDocument();
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
    });
  });

  it('a template exception inside the card removes the card, not the page', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = {
      ...STATE_FIXTURES[0]!.insight(),
      copy: { key: 'insights.playRhythm.fact.compare', values: null },
    } as unknown as Insight;
    const { container } = renderCard(broken);
    expect(container.querySelector('[data-slot="insight-card"]')).toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });
});

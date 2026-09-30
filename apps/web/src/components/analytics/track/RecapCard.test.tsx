import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import {
  resolveTournamentTier,
  type Match,
  type PrepBriefStatus,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { RecapCandidate, RecapCandidateResult } from '@/hooks/useRecapCandidate';
import { RecapCard } from './RecapCard';
import { buildGamesDoorHref } from './recapGamesDoor';

interface PrepState {
  isSuccess: boolean;
  isPending: boolean;
  data: PrepBriefStatus | undefined;
}
let prepState: PrepState;
const usePrepBriefSpy = vi.fn((key: string | undefined) => {
  void key;
  return prepState;
});
vi.mock('@/hooks/usePrepBrief', () => ({
  usePrepBrief: (key: string | undefined) => usePrepBriefSpy(key),
}));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIGHTER = 8;

/** Three sets of three games: 2–1 (won), 3–0 (won), 0–3 (lost) = 5–4 in games, 2–1 in sets. */
function supernovaGames(endedAgoMs = 3 * DAY): Match[] {
  const now = Date.now();
  const games: Match[] = [];
  let time = now - endedAgoMs - 9 * HOUR;
  for (let s = 0; s < 3; s += 1) {
    for (let g = 0; g < 3; g += 1) {
      time += HOUR;
      const win = s === 0 ? g < 2 : s === 1;
      games.push({
        id: `sn-${s}-${g}`,
        fighter_id: FIGHTER,
        opponent_id: 2,
        time,
        win,
        matchType: 'offline-tourney',
        eventName: 'Supernova 2026',
        tournamentName: 'Supernova 2026',
        externalId: `sgg:supernova-set${s}:g${g + 1}`,
      } as Match);
    }
  }
  return games;
}

function older(count: number): Match[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `old-${i}`,
    fighter_id: FIGHTER,
    opponent_id: 2,
    time: now - 60 * DAY - i * HOUR,
    win: i % 2 === 0,
  })) as Match[];
}

function entryFixture(extra: Partial<TournamentEntry> = {}): TournamentEntry {
  const now = Date.now();
  return {
    eventName: 'Supernova 2026',
    tournamentName: 'Supernova 2026',
    entryKey: 'sn26',
    firstSetAt: now - 3 * DAY - 9 * HOUR,
    lastSetAt: now - 3 * DAY,
    setsPlayed: 3,
    placement: 3,
    numEntrants: 2048,
    ...extra,
  } as TournamentEntry;
}

function candidateOf(
  games: Match[],
  options: { entry?: Partial<TournamentEntry> | null; imported?: boolean } = {},
): RecapCandidate {
  const entry = options.entry === null ? null : entryFixture(options.entry);
  const newestGameAt = Math.max(...games.map((g) => g.time));
  return {
    eventKey: 'Supernova 2026',
    games,
    newestGameAt,
    endMs: newestGameAt,
    dismissalId: entry ? 'recap:sn26' : 'recap:Supernova 2026',
    entry: entry
      ? {
          entry,
          entryKey: 'sn26',
          resolution: resolveTournamentTier({
            entry: { eventName: entry.eventName, numEntrants: 2048, isOnline: false },
            observedOnline: false,
          }),
          isAdminImported: options.imported ?? false,
        }
      : null,
  };
}

function recapOf(candidate: RecapCandidate, dismiss = vi.fn()): RecapCandidateResult {
  return { status: 'ready', candidate, dismiss };
}

function renderCard(
  recap: RecapCandidateResult,
  allMatches: Match[],
  path = '/dashboard',
  horizon: 'last30' | 'lastEvent' | 'last90' = 'last30',
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <RecapCard recap={recap} allMatches={allMatches} horizon={horizon} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function doorLinks(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(
    container.querySelectorAll<HTMLAnchorElement>('[data-slot="insight-card-doors"] a'),
  );
}

describe('RecapCard (plan 39.2-13, TRK-03)', () => {
  beforeEach(() => {
    prepState = { isSuccess: false, isPending: true, data: undefined };
    usePrepBriefSpy.mockClear();
  });
  afterEach(cleanup);

  it('reads the placement sentence for an own-account event, with its tier badge and provenance', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    expect(
      screen.getByText('Supernova 2026 — 3rd of 2,048; 5–4 in games, 2–1 in sets.'),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-slot="tier-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="tier-provenance"]')).not.toBeNull();
    // The one sub line: the lost set, no opponent name means the record alone.
    expect(screen.getByText('Set loss — 0–3.')).toBeInTheDocument();
  });

  it('states the event record, the all-time rate and the sample cue on the evidence line', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    const evidence = container.querySelector('[data-slot="insight-card-evidence"]');
    expect(evidence?.textContent).toMatch(/^5–4 at the event · \d+% all time over 409 · /);
  });

  it('a 5-game event reads thin: a count and no direction, never up or down', () => {
    const games = supernovaGames().slice(0, 5);
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    const chip = container.querySelector('[data-slot="delta-chip"]');
    expect(chip?.getAttribute('data-state')).toBe('thin');
    expect(chip?.getAttribute('data-recent-games')).toBe('5');
    expect(chip?.textContent).toContain('no direction');
    expect(container.querySelector('[data-state="up"], [data-state="down"]')).toBeNull();
  });

  it('draws no chip when the event is most of the history (the engine collapses it)', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), games);
    expect(container.querySelector('[data-slot="delta-chip"]')).toBeNull();
  });

  it('draws the set strip as one tick per set, named as an image', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    const strip = container.querySelector('[data-slot="set-strip"]');
    expect(strip?.getAttribute('role')).toBe('img');
    expect(strip?.children).toHaveLength(3);
    expect(strip?.getAttribute('aria-label')).toMatch(/2/);
  });

  it('with no debrief applicable the games door is first and primary, and nothing offers a debrief', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    const links = doorLinks(container);
    expect(links.map((a) => a.textContent)).toEqual(['See the 9 games', 'Open event']);
    const first = links[0]!;
    expect(first.closest('[data-slot="button"]')?.getAttribute('data-variant')).toBe('default');
    expect(first.getAttribute('href')).toMatch(/^\/match-data\?from=\d+&to=\d+#games$/);
    expect(links[1]!.getAttribute('href')).toBe('/tournaments/sn26');
    expect(screen.queryByText('Debrief this event')).toBeNull();
  });

  it('an event with no registry entry has the games door alone: no tier, no Open event', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games, { entry: null })), [
      ...games,
      ...older(400),
    ]);
    expect(doorLinks(container).map((a) => a.textContent)).toEqual(['See the 9 games']);
    expect(container.querySelector('[data-slot="tier-badge"]')).toBeNull();
    // Without placement the W-L sentence is used, under the event key.
    expect(screen.getByText('Supernova 2026 — 5–4 in games, 2–1 in sets.')).toBeInTheDocument();
  });

  it('a placement without entrants degrades to the W-L sentence', () => {
    const games = supernovaGames();
    const candidate = candidateOf(games, { entry: { numEntrants: undefined } });
    renderCard(recapOf(candidate), [...games, ...older(400)]);
    expect(screen.getByText('Supernova 2026 — 5–4 in games, 2–1 in sets.')).toBeInTheDocument();
  });

  it('dismisses through the recap result, one press', async () => {
    const dismiss = vi.fn();
    const games = supernovaGames();
    renderCard(recapOf(candidateOf(games), dismiss), [...games, ...older(400)]);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for none, and a labelled skeleton for loading', () => {
    const none = renderCard({ status: 'none', candidate: null, dismiss: vi.fn() }, []);
    expect(none.container.querySelector('[data-slot="recap-card"]')).toBeNull();
    cleanup();
    const loading = renderCard({ status: 'loading', candidate: null, dismiss: vi.fn() }, []);
    expect(loading.container.querySelector('[data-slot="recap-card"]')).toBeNull();
    expect(within(loading.container).getByRole('status')).toBeInTheDocument();
  });

  describe('the games door (same-n)', () => {
    const subjectPath = (p: string) => p;

    it('is the event window on Match Data when the window holds exactly the event', () => {
      const games = supernovaGames();
      const href = buildGamesDoorHref(games, [...games, ...older(10)], subjectPath);
      const times = games.map((g) => g.time);
      expect(href).toBe(`/match-data?from=${Math.min(...times)}&to=${Math.max(...times)}#games`);
    });

    it('is dropped when a stray game sits inside the window (the printed count would be wrong)', () => {
      const games = supernovaGames();
      const stray = { ...games[4]!, id: 'stray', eventName: undefined, tournamentName: undefined };
      expect(buildGamesDoorHref(games, [...games, stray], subjectPath)).toBeNull();
    });

    it('keeps the subject prefix, so a coach never lands on the viewer own games', () => {
      const games = supernovaGames();
      const { container } = renderCard(
        recapOf(candidateOf(games, { entry: null })),
        [...games, ...older(50)],
        '/coach/client-1/dashboard',
      );
      expect(doorLinks(container)[0]!.getAttribute('href')).toMatch(
        /^\/coach\/client-1\/match-data\?from=\d+&to=\d+#games$/,
      );
    });
  });
});

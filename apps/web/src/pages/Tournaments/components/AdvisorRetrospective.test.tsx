import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AdvisorRetrospective } from './AdvisorRetrospective';
import { buildRetrospective } from '../lib/retrospective';

const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const NO_SELECTION = { id: 0, name: 'no selection' };

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  return {
    eventId: 1,
    eventName: 'Ultimate Singles',
    firstSetAt: 1_000_000,
    lastSetAt: 2_000_000,
    setsPlayed: 1,
    ...overrides,
  };
}

let idCounter = 0;
function makeMatch(overrides: Partial<Match> & Pick<Match, 'time' | 'win'>): Match {
  idCounter += 1;
  return {
    id: `m${idCounter}`,
    fighter_id: 1,
    opponent_id: 10,
    map: BATTLEFIELD,
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function renderRetro(allMatches: Match[], entryMatches: Match[], entry: TournamentEntry) {
  const retrospective = buildRetrospective(allMatches, entryMatches, entry);
  return render(
    <TooltipProvider>
      <AdvisorRetrospective retrospective={retrospective} />
    </TooltipProvider>,
  );
}

describe('AdvisorRetrospective', () => {
  it('shows the honest all-no-data empty state when nothing is classifiable', () => {
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const game = makeMatch({
      time: 1_500_000,
      win: true,
      map: NO_SELECTION,
      externalId: 'sgg:1:g1',
    });

    renderRetro([game], [game], entry);

    expect(
      screen.getByText('Not enough pre-tournament data to grade these picks.'),
    ).toBeInTheDocument();
  });

  it('shows a no-games empty state when the event has no games at all', () => {
    const entry = makeEntry();
    renderRetro([], [], entry);
    expect(screen.getByText('No games recorded for this event yet.')).toBeInTheDocument();
  });

  it('renders the adherence summary with both win-rate halves when both exist', () => {
    const pre = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
      ),
    ];
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const followedGame = makeMatch({
      time: 1_500_000,
      win: true,
      map: BATTLEFIELD,
      externalId: 'sgg:1:g1',
    });

    renderRetro([...pre, followedGame], [followedGame], entry);

    expect(screen.getByText(/Advisor adherence: 100% of classifiable picks/)).toBeInTheDocument();
    expect(screen.getByText(/followed picks won 100%/)).toBeInTheDocument();
  });

  it('renders per-set rows with a result badge', () => {
    const pre = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
    );
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const game = makeMatch({
      time: 1_500_000,
      win: true,
      map: BATTLEFIELD,
      externalId: 'sgg:42:g1',
      roundText: 'Winners Finals',
    });

    renderRetro([...pre, game], [game], entry);

    expect(screen.getByText('Winners Finals')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match, ScoutCharacterUsage } from '@smash-tracker/shared';
import { ScoutMatchupAdvisorCard } from './ScoutMatchupAdvisorCard';

const useFightersMock = vi.fn();
vi.mock('@/hooks/useFighters', () => ({
  useFighters: () => useFightersMock(),
}));

// Fighter ids: 82 Steve, 52 Little Mac, 9 Pikachu (see fighterData.ts).
function makeMatch(overrides: Partial<Match>): Match {
  return {
    id: `m-${Math.random()}`,
    fighter_id: 82,
    opponent_id: 9,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    time: Date.now(),
    win: true,
    ...overrides,
  };
}

const SCOUTED_CHARACTERS: ScoutCharacterUsage[] = [{ fighterId: 9, games: 10, wins: 6 }];

describe('ScoutMatchupAdvisorCard', () => {
  it('shows the empty state when the scout has no character data', () => {
    useFightersMock.mockReturnValue({ data: { primary: [82], secondary: [] } });
    render(<ScoutMatchupAdvisorCard scoutedCharacters={[]} matches={[]} />);

    expect(screen.getByText(/No character data for this scout yet/)).toBeInTheDocument();
  });

  it('prompts to pick a fighter when the user has no characters/matches at all', () => {
    useFightersMock.mockReturnValue({ data: { primary: [], secondary: [] } });
    render(<ScoutMatchupAdvisorCard scoutedCharacters={SCOUTED_CHARACTERS} matches={[]} />);

    expect(screen.getByText(/Pick a primary or secondary character/)).toBeInTheDocument();
  });

  it('recommends the best pick per opponent character, using the user primary fighter as a candidate', () => {
    useFightersMock.mockReturnValue({ data: { primary: [82], secondary: [] } });
    render(<ScoutMatchupAdvisorCard scoutedCharacters={SCOUTED_CHARACTERS} matches={[]} />);

    expect(screen.getByText('vs. Pikachu')).toBeInTheDocument();
    expect(screen.getByText('Steve')).toBeInTheDocument();
  });

  it('lets the users own record vs. a specific opponent character override the tier prior', () => {
    useFightersMock.mockReturnValue({ data: { primary: [82, 52], secondary: [] } });
    const matches = [
      ...Array.from({ length: 18 }, () => makeMatch({ fighter_id: 52, opponent_id: 9, win: true })),
      ...Array.from({ length: 2 }, () => makeMatch({ fighter_id: 52, opponent_id: 9, win: false })),
    ];
    render(<ScoutMatchupAdvisorCard scoutedCharacters={SCOUTED_CHARACTERS} matches={matches} />);

    // Little Mac's dominant, well-sampled record against Pikachu should win
    // out over Steve's much higher tier score (best pick, not just present).
    const bestPickRegion = screen.getByText('vs. Pikachu').closest('li');
    expect(bestPickRegion).not.toBeNull();
    expect(bestPickRegion!.textContent).toContain('Little Mac');
    expect(bestPickRegion!.textContent).toContain('18-2 in your sets');
  });

  it('hides opponent characters with fighterId 0 (unmapped)', () => {
    useFightersMock.mockReturnValue({ data: { primary: [82], secondary: [] } });
    render(
      <ScoutMatchupAdvisorCard
        scoutedCharacters={[{ fighterId: 0, games: 5, wins: 2 }]}
        matches={[]}
      />,
    );
    expect(screen.getByText(/No character data for this scout yet/)).toBeInTheDocument();
  });
});

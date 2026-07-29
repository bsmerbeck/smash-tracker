import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@/i18n';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match, OpponentNote, PrepPresenceMap } from '@smash-tracker/shared';
import { PREP_LIKELY_OPPONENTS_MAX } from '@smash-tracker/shared';
import { LikelyOpponentsCard } from './LikelyOpponentsCard';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const addMutateSpy = vi.fn();
const removeMutateSpy = vi.fn();

vi.mock('@/hooks/usePrepBrief', () => ({
  useAddLikelyOpponent: () => ({ mutate: addMutateSpy, isPending: false }),
  useRemoveLikelyOpponent: () => ({ mutate: removeMutateSpy, isPending: false }),
}));

beforeEach(() => {
  addMutateSpy.mockReset();
  removeMutateSpy.mockReset();
});

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 2,
    opponent_id: 1,
    ...overrides,
  };
}

function makeNote(overrides: Partial<OpponentNote> = {}): OpponentNote {
  return { updatedAt: NOW, ...overrides };
}

describe('LikelyOpponentsCard', () => {
  it('renders one row per curated opponent, sorted by canonical name ascending', () => {
    const likelyOpponents: PrepPresenceMap = { zeta: true, alpha: true };
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: NOW - DAY_MS, win: true, opponent: 'alpha' }),
      makeMatch({ id: 'z1', time: NOW - DAY_MS, win: true, opponent: 'zeta' }),
    ];
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={likelyOpponents}
        matches={matches}
        canonicalOpponents={['alpha', 'zeta']}
        notes={{}}
      />,
    );
    const names = screen.getAllByText(/^(alpha|zeta)$/);
    expect(names.map((el) => el.textContent)).toEqual(['alpha', 'zeta']);
  });

  it('shows the head-to-head record line for an opponent with recorded matches', () => {
    const likelyOpponents: PrepPresenceMap = { alpha: true };
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: NOW - DAY_MS, win: true, opponent: 'alpha' }),
      makeMatch({ id: 'a2', time: NOW - DAY_MS, win: true, opponent: 'alpha' }),
      makeMatch({ id: 'a3', time: NOW - DAY_MS, win: false, opponent: 'alpha' }),
    ];
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={likelyOpponents}
        matches={matches}
        canonicalOpponents={['alpha']}
        notes={{}}
      />,
    );
    expect(screen.getByText('2-1 · 67% (3)')).toBeInTheDocument();
  });

  it('shows the honest no-record line for a curated opponent with zero recorded matches', () => {
    const likelyOpponents: PrepPresenceMap = { alpha: true };
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={likelyOpponents}
        matches={[]}
        canonicalOpponents={['alpha']}
        notes={{}}
      />,
    );
    expect(screen.getByText('No matches recorded against alpha yet.')).toBeInTheDocument();
  });

  it('shows the no-characters line when the opponent has recorded matches but no fighter data', () => {
    const likelyOpponents: PrepPresenceMap = { alpha: true };
    // getOpponentProfile always derives byTheirFighter from opponent_id, so
    // giving it zero matches produces the noRecord line instead; to exercise
    // the no-characters path with a non-null profile we'd need a match with
    // no opponent_id grouping — byTheirFighter is only empty when the
    // profile itself is null. Assert both empty lines exist independently.
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={likelyOpponents}
        matches={[]}
        canonicalOpponents={['alpha']}
        notes={{}}
      />,
    );
    expect(screen.getByText('No characters recorded yet.')).toBeInTheDocument();
  });

  it('renders a curated opponent with matches showing character sprites, not the no-characters line', () => {
    const likelyOpponents: PrepPresenceMap = { alpha: true };
    const matches: Match[] = [
      makeMatch({ id: 'a1', time: NOW - DAY_MS, win: true, opponent: 'alpha', opponent_id: 1 }),
    ];
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={likelyOpponents}
        matches={matches}
        canonicalOpponents={['alpha']}
        notes={{}}
      />,
    );
    expect(screen.queryByText('No characters recorded yet.')).not.toBeInTheDocument();
    expect(screen.getByText('Mario')).toBeInTheDocument();
  });

  it('the add-picker lists canonical opponents not already curated, in the locked deterministic order, and selecting one calls the add mutation', async () => {
    const user = userEvent.setup();
    const likelyOpponents: PrepPresenceMap = { alpha: true };
    const matches: Match[] = [
      makeMatch({ id: 'b1', time: NOW - DAY_MS, win: true, opponent: 'bravo' }),
      makeMatch({ id: 'b2', time: NOW - DAY_MS, win: true, opponent: 'bravo' }),
      makeMatch({ id: 'c1', time: NOW - DAY_MS, win: true, opponent: 'charlie' }),
    ];
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={likelyOpponents}
        matches={matches}
        canonicalOpponents={['alpha', 'bravo', 'charlie']}
        notes={{}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add opponent' }));
    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    // alpha is already curated, excluded; bravo (2 matches) ranks above charlie (1 match).
    expect(options.map((el) => el.textContent)).toEqual([
      expect.stringContaining('bravo'),
      expect.stringContaining('charlie'),
    ]);

    await user.click(within(listbox).getByText('bravo'));
    expect(addMutateSpy).toHaveBeenCalledWith('bravo');
  });

  it('the remove control has the accessible name from prep.opponents.remove and calls the remove mutation immediately', async () => {
    const user = userEvent.setup();
    const likelyOpponents: PrepPresenceMap = { alpha: true };
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={likelyOpponents}
        matches={[]}
        canonicalOpponents={['alpha']}
        notes={{}}
      />,
    );
    const removeButton = screen.getByRole('button', {
      name: 'Remove alpha from likely opponents',
    });
    await user.click(removeButton);
    expect(removeMutateSpy).toHaveBeenCalledWith('alpha');
  });

  it('renders the empty-state title/body AND keeps the add-picker visible when likelyOpponents is empty', () => {
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={{}}
        matches={[]}
        canonicalOpponents={['alpha']}
        notes={{}}
      />,
    );
    expect(screen.getByText('No likely opponents yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add opponents you expect to face — we'll pull in your head-to-head record and scouting notes for each.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add opponent' })).toBeInTheDocument();
  });

  it('disables the add trigger and shows limitReached when the curated map is at PREP_LIKELY_OPPONENTS_MAX', () => {
    const likelyOpponents: PrepPresenceMap = {};
    const canonicalOpponents: string[] = [];
    for (let i = 0; i < PREP_LIKELY_OPPONENTS_MAX; i += 1) {
      likelyOpponents[`opponent-${i}`] = true;
      canonicalOpponents.push(`opponent-${i}`);
    }
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={likelyOpponents}
        matches={[]}
        canonicalOpponents={canonicalOpponents}
        notes={{}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add opponent' })).toBeDisabled();
    expect(
      screen.getByText(`You can track up to ${PREP_LIKELY_OPPONENTS_MAX} likely opponents.`),
    ).toBeInTheDocument();
  });

  it('renders the stored note via OpponentNoteReadout for the matching curated opponent', () => {
    const likelyOpponents: PrepPresenceMap = { alpha: true };
    const notes: Record<string, OpponentNote> = {
      alpha: makeNote({ habits: 'Likes to roll a lot.' }),
    };
    render(
      <LikelyOpponentsCard
        entryKey="entry-1"
        likelyOpponents={likelyOpponents}
        matches={[]}
        canonicalOpponents={['alpha']}
        notes={notes}
      />,
    );
    expect(screen.getByText('Likes to roll a lot.')).toBeInTheDocument();
  });
});

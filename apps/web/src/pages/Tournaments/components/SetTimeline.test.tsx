import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SetTimeline } from './SetTimeline';
import { buildSetTimeline } from '../lib/setTimeline';
import { SpriteList } from '@/data/sprites';

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

function renderTimeline(matches: Match[]) {
  const { sets, otherMatches } = buildSetTimeline(matches);
  return render(
    <TooltipProvider>
      <SetTimeline sets={sets} otherMatches={otherMatches} />
    </TooltipProvider>,
  );
}

describe('SetTimeline', () => {
  it('shows an empty state when there are no matches', () => {
    renderTimeline([]);
    expect(screen.getByText('No matches recorded for this event yet.')).toBeInTheDocument();
  });

  it('renders a set row with roundText, opponent tag, and the derived set score/result', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 100,
        win: true,
        externalId: 'sgg:1:g1',
        roundText: 'Winners Semi-Final',
      }),
      makeMatch({ id: 'g2', time: 200, win: false, externalId: 'sgg:1:g2' }),
      makeMatch({ id: 'g3', time: 300, win: true, externalId: 'sgg:1:g3' }),
    ];
    renderTimeline(matches);

    expect(screen.getByText('Winners Semi-Final')).toBeInTheDocument();
    expect(screen.getByText('2-1')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
    expect(screen.getByAltText('Luigi')).toBeInTheDocument();
  });

  it('falls back to "Set {id}" when roundText is absent', () => {
    const matches = [makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:555:g1' })];
    renderTimeline(matches);
    expect(screen.getByText('Set 555')).toBeInTheDocument();
  });

  it('applies a losers-side tint when bracketRound is negative', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 100,
        win: true,
        externalId: 'sgg:1:g1',
        bracketRound: -2,
        roundText: 'Losers Round 2',
      }),
    ];
    renderTimeline(matches);

    const list = screen.getByRole('list', { name: 'Sets' });
    const row = within(list).getByText('Losers Round 2').closest('li');
    expect(row?.className).toContain('border-l-destructive');
  });

  it('does not tint winners-side sets', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 100,
        win: true,
        externalId: 'sgg:1:g1',
        bracketRound: 2,
        roundText: 'Winners Round 2',
      }),
    ];
    renderTimeline(matches);

    const list = screen.getByRole('list', { name: 'Sets' });
    const row = within(list).getByText('Winners Round 2').closest('li');
    expect(row?.className).not.toContain('border-l-destructive');
  });

  it('renders manual (non-set) matches in a separate "other matches" list', () => {
    const setGame = makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:1:g1' });
    const manual = makeMatch({ id: 'm1', time: 500, win: false });
    renderTimeline([setGame, manual]);

    expect(screen.getByText('Other matches during this event')).toBeInTheDocument();
    const otherList = screen.getByRole('list', { name: 'Other matches during this event' });
    expect(within(otherList).getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows the opponent tag for a set', () => {
    const matches = [
      makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:1:g1', opponent: 'rival' }),
    ];
    renderTimeline(matches);
    expect(screen.getByText(/vs rival/)).toBeInTheDocument();
  });

  it('links the opponent tag to their start.gg profile when opponentUserSlug is present', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 100,
        win: true,
        externalId: 'sgg:1:g1',
        opponent: 'rival',
        opponentUserSlug: 'user/9fb774ae',
      }),
    ];
    renderTimeline(matches);
    const link = screen.getByRole('link', { name: 'View rival on start.gg' });
    expect(link).toHaveAttribute('href', 'https://start.gg/user/9fb774ae');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('omits the opponent profile link when opponentUserSlug is absent', () => {
    const matches = [
      makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:1:g1', opponent: 'rival' }),
    ];
    renderTimeline(matches);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows a compact seed/placement context next to the opponent when present', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 100,
        win: true,
        externalId: 'sgg:1:g1',
        opponent: 'rival',
        opponentSeed: 56,
        opponentPlacement: 129,
      }),
    ];
    renderTimeline(matches);
    expect(screen.getByText('(seed 56 · placed 129th)')).toBeInTheDocument();
  });

  it('omits the seed/placement context when neither is present', () => {
    const matches = [
      makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:1:g1', opponent: 'rival' }),
    ];
    renderTimeline(matches);
    expect(screen.queryByText(/seed|placed/)).not.toBeInTheDocument();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SetTimeline } from './SetTimeline';
import { buildSetTimeline } from '../lib/setTimeline';
import { SpriteList } from '@/data/sprites';

const updateMatch = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    matches: {
      update: (...args: unknown[]) => updateMatch(...args),
    },
  },
}));

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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SetTimeline sets={sets} otherMatches={otherMatches} />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('SetTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    expect(screen.getByText(/rival/)).toBeInTheDocument();
  });

  it("shows the user's fighter(s) alongside the opponent's for a set", () => {
    const matches = [
      makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:1:g1', opponent: 'rival' }),
    ];
    renderTimeline(matches);
    const userTags = screen.getByLabelText('Your fighters');
    expect(within(userTags).getByAltText(mario.name)).toBeInTheDocument();
    const opponentTags = screen.getByLabelText('Opponent fighters');
    expect(within(opponentTags).getByAltText(luigi.name)).toBeInTheDocument();
    expect(screen.getByText('vs')).toBeInTheDocument();
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

  it('shows a "Watch VOD" link when a game in the set carries a vodUrl', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 100,
        win: true,
        externalId: 'sgg:1:g1',
        roundText: 'Grand Final',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ];
    renderTimeline(matches);

    const link = screen.getByRole('link', { name: 'Watch VOD for Grand Final' });
    expect(link).toHaveAttribute('href', '/vod?match=g1');
    expect(link).not.toHaveAttribute('target');
    expect(link).not.toHaveAttribute('rel');
  });

  it('shows the VOD link when only one game in a multi-game set carries the vodUrl', () => {
    const matches = [
      makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:1:g1' }),
      makeMatch({
        id: 'g2',
        time: 200,
        win: false,
        externalId: 'sgg:1:g2',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
      makeMatch({ id: 'g3', time: 300, win: true, externalId: 'sgg:1:g3' }),
    ];
    renderTimeline(matches);

    expect(screen.getByRole('link', { name: /Watch VOD/ })).toHaveAttribute(
      'href',
      '/vod?match=g2',
    );
  });

  it('omits the "Watch VOD" link when no game in the set carries a vodUrl (current production data)', () => {
    const matches = [makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:1:g1' })];
    renderTimeline(matches);
    expect(screen.queryByText('Watch VOD')).not.toBeInTheDocument();
  });

  it('shows clickable timestamp chips with deep links when the set has vodTimestamps', () => {
    const matches = [
      makeMatch({
        id: 'g1',
        time: 100,
        win: true,
        externalId: 'sgg:1:g1',
        roundText: 'Grand Final',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { seconds: 490, note: 'lost ledge trump war' },
          { seconds: 161, note: 'missed punish on shield' },
        ],
      }),
    ];
    renderTimeline(matches);

    const firstChip = screen.getByRole('link', { name: '2:41' });
    expect(firstChip).toHaveAttribute('href', 'https://youtube.com/watch?v=abc123&t=161s');
    expect(screen.getByRole('link', { name: '8:10' })).toBeInTheDocument();
  });

  it('always shows a VOD edit affordance, even when the set has no vodUrl yet', () => {
    const matches = [
      makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:1:g1', roundText: 'Pools' }),
    ];
    renderTimeline(matches);
    expect(screen.getByRole('button', { name: 'Edit VOD notes for Pools' })).toBeInTheDocument();
  });

  it('opens the VOD notes dialog from the edit affordance', async () => {
    const user = userEvent.setup();
    const matches = [
      makeMatch({
        id: 'g1',
        time: 100,
        win: true,
        externalId: 'sgg:1:g1',
        roundText: 'Grand Final',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ];
    renderTimeline(matches);

    await user.click(screen.getByRole('button', { name: 'Edit VOD notes for Grand Final' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'VOD Notes' })).toBeInTheDocument();
  });
});

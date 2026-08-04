import { describe, expect, it } from 'vitest';
import '@/i18n';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { ReviewGroundingCard } from './ReviewGroundingCard';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'Rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

function renderCard(eventMatches: Match[]) {
  return render(
    <MemoryRouter>
      <ReviewGroundingCard eventMatches={eventMatches} />
    </MemoryRouter>,
  );
}

describe('ReviewGroundingCard', () => {
  it('renders one block per event match that has annotations: match label, Annotate-in-VOD-Manager link to /vod?match=<matchId>, timestamp chips via formatTimestamp, tag badges', () => {
    const annotated = makeMatch({
      id: 'match-1',
      time: 1_700_000_000_000,
      win: true,
      opponent: 'Sharkz',
      vodTimestamps: [
        { id: 'ts-1', seconds: 95, note: 'missed punish' },
        { id: 'ts-2', seconds: 200, note: '' },
      ],
      tags: ['grab-heavy', 'edgeguard'],
    });
    renderCard([annotated]);

    expect(screen.getByText('vs Sharkz')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Annotate in VOD Manager' });
    expect(link).toHaveAttribute('href', '/vod?match=match-1');

    expect(screen.getByText('1:35')).toBeInTheDocument();
    expect(screen.getByText('3:20')).toBeInTheDocument();
    expect(screen.getByText('grab-heavy')).toBeInTheDocument();
    expect(screen.getByText('edgeguard')).toBeInTheDocument();
  });

  it('matches with zero annotations render no block; sub-sections without content are omitted entirely', () => {
    const annotatedTagsOnly = makeMatch({
      id: 'match-tags-only',
      time: 1000,
      win: true,
      opponent: 'TagsOnly',
      tags: ['neutral-heavy'],
    });
    const unannotated = makeMatch({
      id: 'match-none',
      time: 2000,
      win: false,
      opponent: 'NoAnnotations',
    });
    renderCard([annotatedTagsOnly, unannotated]);

    expect(screen.getByText('vs TagsOnly')).toBeInTheDocument();
    expect(screen.queryByText('vs NoAnnotations')).not.toBeInTheDocument();

    // Sub-sections without content are omitted: the tags-only match has no
    // timestamp chips at all (only the tag badge renders).
    const block = screen.getByText('vs TagsOnly').closest<HTMLElement>('.rounded-md')!;
    expect(within(block).getByText('neutral-heavy')).toBeInTheDocument();
    expect(within(block).queryByText(/^\d+:\d{2}$/)).not.toBeInTheDocument();
  });

  it('no editing affordance exists — no inputs, no buttons besides links', () => {
    const annotated = makeMatch({
      id: 'match-1',
      time: 1000,
      win: true,
      opponent: 'Sharkz',
      vodTimestamps: [{ id: 'ts-1', seconds: 10, note: 'note' }],
      tags: ['rushdown'],
    });
    renderCard([annotated]);

    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    // The only interactive affordance is the link into the VOD Manager.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('honest empty state: zero annotated matches renders postEvent.grounding.empty.* plus the outline Open-VOD-Manager button linking /vod — and zero placeholder chips', () => {
    const unannotated = makeMatch({ id: 'match-none', time: 1000, win: true });
    renderCard([unannotated]);

    expect(screen.getByText('Nothing annotated yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Open a match in the VOD Manager to add timestamps and tag the key moments — they'll appear here.",
      ),
    ).toBeInTheDocument();

    const cta = screen.getByRole('link', { name: 'Open VOD Manager' });
    expect(cta).toHaveAttribute('href', '/vod');

    expect(screen.queryByText(/^\d+:\d{2}$/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(1);
  });
});

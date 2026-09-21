import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { CareerTimelineSlot } from './CareerTimelineSlot';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

const PLACEHOLDER_PHRASES = [
  /coming soon/i,
  /work in progress/i,
  /placeholder/i,
  /work-in-progress/i,
];

describe('CareerTimelineSlot', () => {
  it('renders with its stable data attribute and holds exactly two cards', () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `${i}`, time: i * 1000, win: true }),
    );
    const { container } = render(<CareerTimelineSlot matches={matches} />);

    const slot = container.querySelector('[data-slot="career-timeline-interim"]');
    expect(slot).not.toBeNull();
    const cards = slot!.querySelectorAll(':scope > [data-slot="card"]');
    expect(cards.length).toBe(2);
  });

  it('renders no placeholder, coming-soon or work-in-progress copy anywhere in the slot', () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `${i}`, time: i * 1000, win: true }),
    );
    const { container } = render(<CareerTimelineSlot matches={matches} />);

    const text = container.textContent ?? '';
    for (const phrase of PLACEHOLDER_PHRASES) {
      expect(text).not.toMatch(phrase);
    }
  });

  it('renders the Rating Curve and Monthly Performance titles', () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `${i}`, time: i * 1000, win: true }),
    );
    render(<CareerTimelineSlot matches={matches} />);

    expect(screen.getByText('Rating Curve')).toBeInTheDocument();
    expect(screen.getByText('Monthly Performance')).toBeInTheDocument();
  });
});

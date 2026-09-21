import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { MatchupOrPlayerCard } from './MatchupOrPlayerCard';

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

/** Below `matchupOrPlayer.ts`'s own floors (20 games, 3 distinct opponents) — the template's `hidden` branch. */
function tinyFixture(): Match[] {
  const now = Date.now();
  return Array.from({ length: 5 }, (_, i) =>
    makeMatch({
      id: `m${i}`,
      time: now - i * 86_400_000,
      opponent: 'onlyOpponent',
      win: i % 2 === 0,
    }),
  );
}

/** >=20 games across >=3 distinct opponents, evenly split — clears both floors so the template asserts a real (non-`hidden`) read. */
function largeFixture(): Match[] {
  const now = Date.now();
  const opponents = ['alice', 'bob', 'carol', 'dave'];
  return Array.from({ length: 40 }, (_, i) =>
    makeMatch({
      id: `m${i}`,
      time: now - i * 86_400_000,
      opponent: opponents[i % opponents.length],
      win: i % 3 !== 0,
    }),
  );
}

describe('MatchupOrPlayerCard', () => {
  it('renders nothing (an empty container) when the engine reports the read hidden', () => {
    const { container } = render(
      <MatchupOrPlayerCard matchupMatches={tinyFixture()} horizon="last30" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing over zero matches', () => {
    const { container } = render(<MatchupOrPlayerCard matchupMatches={[]} horizon="last30" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a real insight-card frame (chip, verdict, evidence) once the template clears its floors', () => {
    render(<MatchupOrPlayerCard matchupMatches={largeFixture()} horizon="last30" />);
    // `opponent_id: 10` resolves to Luigi (SpriteList) — the "matchup" entity
    // is the OPPONENT CHARACTER name, never the free-text `match.opponent`
    // tag (that free-text field names the human, not the pairing).
    expect(screen.getAllByText(/vs Luigi/).length).toBeGreaterThan(0);
  });
});

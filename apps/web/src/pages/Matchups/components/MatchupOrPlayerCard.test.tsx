import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { MatchupOrPlayerCard, useMatchupOrPlayerInsight } from './MatchupOrPlayerCard';

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

/**
 * Plan 39.1-24 (gap closure, Task 2): `MatchupOrPlayerCard` no longer
 * computes its own insight — a host calls `useMatchupOrPlayerInsight` ONCE
 * and hands the result down (so `MatchupsPage`'s `FilteredMatchList`
 * terminus can share the SAME insight for `resolveClaim`), mirroring
 * `FighterInsightRail`'s Task 1 pattern. This harness reproduces that real
 * usage pattern, wrapped in a `MemoryRouter` since the card now renders a
 * real `<Link>` door.
 */
function CardTestHarness({
  matchupMatches,
  horizon,
  doorCarry,
}: {
  matchupMatches: Match[];
  horizon: HorizonKey;
  doorCarry?: URLSearchParams;
}) {
  const insight = useMatchupOrPlayerInsight({ matchupMatches, horizon });
  return (
    <MatchupOrPlayerCard matchupMatches={matchupMatches} insight={insight} doorCarry={doorCarry} />
  );
}

function renderCard(
  matchupMatches: Match[],
  horizon: HorizonKey = 'last30',
  doorCarry?: URLSearchParams,
) {
  return render(
    <MemoryRouter>
      <CardTestHarness matchupMatches={matchupMatches} horizon={horizon} doorCarry={doorCarry} />
    </MemoryRouter>,
  );
}

describe('MatchupOrPlayerCard', () => {
  it('renders nothing (an empty container) when the engine reports the read hidden', () => {
    const { container } = renderCard(tinyFixture());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing over zero matches', () => {
    const { container } = renderCard([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a real insight-card frame (chip, verdict, evidence) once the template clears its floors', () => {
    renderCard(largeFixture());
    // `opponent_id: 10` resolves to Luigi (SpriteList) — the "matchup" entity
    // is the OPPONENT CHARACTER name, never the free-text `match.opponent`
    // tag (that free-text field names the human, not the pairing).
    expect(screen.getAllByText(/vs Luigi/).length).toBeGreaterThan(0);
  });

  describe('T-39.1-24 (gap closure, DD-09 reachability): counted-games + opponent doors', () => {
    it('renders a primary counted-games door anchored to #matchup-table, then the opponent fallback door', () => {
      const { container } = renderCard(largeFixture());
      const card = container.querySelector('[data-slot="insight-card"]') as HTMLElement;
      const doors = within(card).getAllByRole('link');
      expect(doors.length).toBe(2);

      const primary = doors[0]!;
      const href = primary.getAttribute('href') ?? '';
      expect(href).toMatch(/claim=/);
      expect(href).toMatch(/#matchup-table$/);
      expect(primary.textContent ?? '').toMatch(/see the \d+ games?/i);

      const secondary = doors[1]!;
      expect(secondary.textContent ?? '').toMatch(/open opponent/i);
    });
  });

  describe('T-39.1-26 (gap closure): doorCarry keeps host context on the games door', () => {
    it('with a doorCarry prop, the games door href keeps the carried params', () => {
      const carry = new URLSearchParams({ fighter: '1', vs: '10' });
      const { container } = renderCard(largeFixture(), 'last30', carry);
      const card = container.querySelector('[data-slot="insight-card"]') as HTMLElement;
      const doors = within(card).getAllByRole('link');
      expect(doors[0]!.getAttribute('href') ?? '').toContain('fighter=1');
      expect(doors[0]!.getAttribute('href') ?? '').toContain('vs=10');
    });

    it('without doorCarry, the href stays unchanged (no fighter/vs leak)', () => {
      const { container } = renderCard(largeFixture());
      const card = container.querySelector('[data-slot="insight-card"]') as HTMLElement;
      const doors = within(card).getAllByRole('link');
      const href = doors[0]!.getAttribute('href') ?? '';
      expect(href).not.toContain('fighter=');
      expect(href).toMatch(/#matchup-table$/);
    });
  });
});

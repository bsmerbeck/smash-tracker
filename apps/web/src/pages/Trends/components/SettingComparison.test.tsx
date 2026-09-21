import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { SettingComparison } from './SettingComparison';

const NOW = Date.now();

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

function renderCard(matches: Match[], horizon: 'last30' | 'lastEvent' | 'last90' = 'last30') {
  return render(
    <MemoryRouter>
      <SettingComparison matches={matches} horizon={horizon} />
    </MemoryRouter>,
  );
}

/** N online games and M offline games, evenly spread, no 2-loss streaks that would matter here. */
function buildSplit(onlineCount: number, offlineCount: number, offlineWin = true): Match[] {
  const games: Match[] = [];
  for (let i = 0; i < onlineCount; i++) {
    games.push(
      makeMatch({
        id: `on${i}`,
        time: NOW - (onlineCount - i) * 60_000,
        win: true,
        matchType: 'quickplay',
      }),
    );
  }
  for (let i = 0; i < offlineCount; i++) {
    games.push(
      makeMatch({
        id: `off${i}`,
        time: NOW - (offlineCount - i) * 60_000,
        win: offlineWin,
        matchType: 'offline-tourney',
      }),
    );
  }
  return games;
}

// `apps/web/src/components/analytics/insightCopy.test.ts`'s concatenation
// scanner (D-05) only walks `components/analytics/` and `components/charts/`
// — this file lives under `pages/` and is structurally out of that guard's
// scope (its own test asserts the guard never reaches `pages/`), so this
// plan's own acceptance criterion ("asserted by the copy guard passing with
// this file in scope") does not literally hold for a `pages/` component.
// Manually verified instead: `verdict`/`evidence` below are each built from
// exactly ONE `t()` call — no rendered sentence concatenates two translated
// fragments with JSX text or a string literal.

describe('SettingComparison', () => {
  it('renders online before offline on a fixture where offline is winning', () => {
    const { container } = renderCard(buildSplit(10, 10, true));
    const labels = [...container.querySelectorAll('[class*="uppercase"]')].map(
      (n) => n.textContent,
    );
    const onlineIndex = labels.indexOf('Online');
    const offlineIndex = labels.indexOf('Offline');
    expect(onlineIndex).toBeGreaterThanOrEqual(0);
    expect(offlineIndex).toBeGreaterThan(onlineIndex);
  });

  it('renders the abstained sentence naming offline with zero offline games, and no percent for the empty side', () => {
    renderCard(buildSplit(10, 0));
    expect(screen.getByText('Not enough offline games to compare (0).')).toBeInTheDocument();
    const offlineLabel = screen.getByText('Offline');
    const figureRoot = offlineLabel.closest('div');
    expect(figureRoot?.textContent).not.toMatch(/%/);
  });

  it('is eligible with exactly 8 games on each side', () => {
    renderCard(buildSplit(8, 8, false));
    expect(screen.queryByText(/unlocks? the online\/offline comparison/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Not enough (online|offline) games to compare/),
    ).not.toBeInTheDocument();
  });

  it('abstains with 7 games on one side (below COHORT_MIN_SIDE_GAMES, the locked meter text)', () => {
    // 7 offline games is NOT zero (so `SettingGap` is `locked`, not `thin` —
    // `thin` triggers only when a side is literally empty; see
    // `renders the abstained sentence...` above for that case).
    renderCard(buildSplit(20, 7, false));
    expect(
      screen.getByText('Setting — 1 more offline game unlocks the online/offline comparison.'),
    ).toBeInTheDocument();
  });

  it('renders no unspecified footnote when the unspecified count is zero', () => {
    renderCard(buildSplit(10, 10));
    expect(screen.queryByText(/unspecified/i)).not.toBeInTheDocument();
  });

  it('renders the unspecified bucket only as a muted footnote (never a third tile) when its count is above zero', () => {
    const games = [
      ...buildSplit(10, 10),
      makeMatch({ id: 'u1', time: NOW - 1000, win: true, matchType: 'none' }),
    ];
    const { container } = renderCard(games);
    const labels = [...container.querySelectorAll('[class*="uppercase"]')].map(
      (n) => n.textContent,
    );
    expect(labels).not.toContain('Unspecified');
    expect(screen.getByText('1 unspecified game not counted.')).toBeInTheDocument();
  });
});

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Fighter, Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { DashboardContext, type DashboardContextValue } from '../DashboardContext';
import { WinLossTracker } from './WinLossTracker';

const mario = SpriteList.find((s) => s.id === 1)!;

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

// No default parameter: `renderTracker(matches, undefined)` must actually
// pass `undefined` through (a JS default parameter treats an explicit
// `undefined` argument as "use the default", silently defeating the
// no-fighter-selected test case below).
function renderTracker(matches: Match[], fighter: Fighter | undefined) {
  const contextValue: DashboardContextValue = {
    fighterSprites: [mario],
    fighter,
    setFighter: vi.fn(),
  };
  return render(
    <DashboardContext.Provider value={contextValue}>
      <WinLossTracker matches={matches} />
    </DashboardContext.Provider>,
  );
}

/**
 * Plan 39.1-17 (UIX-04): the last page-local stat component on this surface
 * is gone, replaced by the ONE stat idiom (`StatRow`/`StatFigure`) — no more
 * `flex justify-evenly` collision (owner's "garbage spacing" note).
 */
describe('WinLossTracker', () => {
  it('renders wins, rate, and losses through the StatRow primitive', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true }),
      makeMatch({ id: '2', time: 2, win: true }),
      makeMatch({ id: '3', time: 3, win: false }),
    ];

    const { container } = renderTracker(matches, mario);

    expect(screen.getByText('Wins')).toBeInTheDocument();
    expect(screen.getByText('Rate')).toBeInTheDocument();
    expect(screen.getByText('Losses')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    // The grid `StatRow` primitive is present — never the old collision class.
    expect(container.querySelector('[class*="justify-evenly"]')).toBeNull();
  });

  it('shows the no-match-data state when the selected fighter has no games, and renders no stat figures', () => {
    renderTracker([], mario);

    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
    expect(screen.queryByText('Wins')).not.toBeInTheDocument();
    expect(screen.queryByText('Losses')).not.toBeInTheDocument();
  });

  it('shows the no-match-data state when no fighter is selected at all', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true })];
    renderTracker(matches, undefined);

    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('scopes the record to the selected fighter only, ignoring other fighters’ matches', () => {
    const luigi = SpriteList.find((s) => s.id === 10)!;
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, fighter_id: mario.id }),
      makeMatch({ id: '2', time: 2, win: false, fighter_id: luigi.id }),
    ];

    renderTracker(matches, mario);

    // Only mario's one win counts — the record is 1-0 (100%), not 1-1.
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('declares no page-local Stat/HeroCard/StatBlock/SettingBlock component (UIX-04, §13.4)', () => {
    const selfPath = fileURLToPath(import.meta.url);
    const sourcePath = selfPath.replace(/\.test\.tsx$/, '.tsx');
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/\bfunction\s+(Stat|HeroCard|StatBlock|SettingBlock)\b/);
  });
});

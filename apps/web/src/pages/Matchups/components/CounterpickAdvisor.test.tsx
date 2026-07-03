import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { CounterpickAdvisor } from './CounterpickAdvisor';

// Real stage ids/names from packages/shared/src/stageData.ts — CounterpickAdvisor
// looks the name up by id via `stagesById`, so test fixtures must use ids that
// actually resolve (a synthetic id would render as "Unknown stage").
const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const BIG_BATTLEFIELD = { id: 2, name: 'Big Battlefield' };
const SMASHVILLE = { id: 83, name: 'Smashville' };
const TOWN_AND_CITY = { id: 85, name: 'Town and City' };

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: BATTLEFIELD,
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function matchesOnStage(
  stage: { id: number; name: string },
  wins: number,
  losses: number,
): Match[] {
  const result: Match[] = [];
  for (let i = 0; i < wins; i++) {
    result.push(makeMatch({ id: `${stage.name}-w${i}`, map: stage, win: true }));
  }
  for (let i = 0; i < losses; i++) {
    result.push(makeMatch({ id: `${stage.name}-l${i}`, map: stage, win: false }));
  }
  return result;
}

describe('CounterpickAdvisor', () => {
  it('shows a gather-more-data hint when no stage has the minimum sample size', () => {
    render(<CounterpickAdvisor matchupMatches={matchesOnStage(BATTLEFIELD, 1, 0)} />);
    expect(screen.getByText(/Gather more data/)).toBeInTheDocument();
    expect(screen.queryByText('Pick these')).not.toBeInTheDocument();
  });

  it('excludes stages below the 2-game threshold from picks/bans', () => {
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 5, 0), // qualifies, best
      ...matchesOnStage(TOWN_AND_CITY, 1, 0), // below threshold — excluded
    ];
    render(<CounterpickAdvisor matchupMatches={matches} />);
    expect(screen.getByText('Pick these')).toBeInTheDocument();
    expect(screen.queryByText(/Town and City/)).not.toBeInTheDocument();
  });

  it('ranks the best stage first under "Pick these"', () => {
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 5, 0), // 100%, n=5 — best
      ...matchesOnStage(TOWN_AND_CITY, 3, 2), // 60%, n=5
    ];
    render(<CounterpickAdvisor matchupMatches={matches} />);

    const pickSection = screen.getByText('Pick these').closest('div')!;
    const items = pickSection.querySelectorAll('li');
    expect(items[0]?.textContent).toContain('Battlefield');
  });

  it('splits picks and bans without overlap when there are exactly enough qualifying stages', () => {
    // 4 qualifying stages: top 3 -> picks, remaining 1 -> bans.
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 5, 0),
      ...matchesOnStage(TOWN_AND_CITY, 4, 1),
      ...matchesOnStage(SMASHVILLE, 3, 2),
      ...matchesOnStage(BIG_BATTLEFIELD, 0, 5),
    ];
    render(<CounterpickAdvisor matchupMatches={matches} />);

    const pickSection = screen.getByText('Pick these').closest('div')!;
    const banSection = screen.getByText('Ban / avoid these').closest('div')!;

    expect(pickSection.querySelectorAll('li')).toHaveLength(3);
    expect(banSection.querySelectorAll('li')).toHaveLength(1);
    expect(banSection.textContent).toContain('Big Battlefield');
    expect(pickSection.textContent).not.toContain('Big Battlefield');
  });

  it('does not show a bans section when every qualifying stage is already a pick', () => {
    const matches = [...matchesOnStage(BATTLEFIELD, 5, 0), ...matchesOnStage(TOWN_AND_CITY, 4, 1)];
    render(<CounterpickAdvisor matchupMatches={matches} />);

    expect(screen.getByText('Pick these')).toBeInTheDocument();
    expect(screen.queryByText('Ban / avoid these')).not.toBeInTheDocument();
  });

  it('shows worst stage first under "Ban / avoid these"', () => {
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 5, 0),
      ...matchesOnStage(TOWN_AND_CITY, 4, 1),
      ...matchesOnStage(SMASHVILLE, 2, 3), // worse than Big Battlefield below
      ...matchesOnStage(BIG_BATTLEFIELD, 0, 5), // worst
    ];
    render(<CounterpickAdvisor matchupMatches={matches} />);

    const banSection = screen.getByText('Ban / avoid these').closest('div')!;
    const items = banSection.querySelectorAll('li');
    expect(items[0]?.textContent).toContain('Big Battlefield');
  });

  it('shows the record, rate, and sample size for each stage row', () => {
    const matches = matchesOnStage(BATTLEFIELD, 3, 2);
    render(<CounterpickAdvisor matchupMatches={matches} />);
    expect(screen.getByText(/3-2 \(60% over 5\)/)).toBeInTheDocument();
  });
});

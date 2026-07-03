import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { StageTiles, buildTopStageTiles } from './StageTiles';

function makeMatch(
  id: string,
  time: number,
  win: boolean,
  stageId: number,
  stageName: string,
): Match {
  return {
    id,
    time,
    win,
    fighter_id: 1,
    opponent_id: 2,
    map: { id: stageId, name: stageName },
    opponent: '',
    notes: '',
    matchType: 'none',
  };
}

describe('buildTopStageTiles', () => {
  it('excludes the "no selection" sentinel stage (id 0)', () => {
    const matches = [
      makeMatch('1', 1, true, 0, 'no selection'),
      makeMatch('2', 2, true, 1, 'Battlefield'),
    ];
    const tiles = buildTopStageTiles(matches);
    expect(tiles.map((t) => t.stage.id)).toEqual([1]);
  });

  it('orders stages by usage (sample size) descending', () => {
    const matches = [
      // Stage 1: 3 games
      makeMatch('1', 1, true, 1, 'Battlefield'),
      makeMatch('2', 2, true, 1, 'Battlefield'),
      makeMatch('3', 3, false, 1, 'Battlefield'),
      // Stage 3: 1 game
      makeMatch('4', 4, true, 3, 'Final Destination'),
      // Stage 2: 2 games
      makeMatch('5', 5, true, 2, 'Big Battlefield'),
      makeMatch('6', 6, false, 2, 'Big Battlefield'),
    ];
    const tiles = buildTopStageTiles(matches);
    expect(tiles.map((t) => t.stage.id)).toEqual([1, 2, 3]);
    expect(tiles[0]?.record.total).toBe(3);
  });

  it('caps the result at the top 6 stages', () => {
    const matches: Match[] = [];
    const stageIds = [1, 2, 3, 4, 5, 6, 7, 39, 40, 44];
    stageIds.forEach((stageId, i) => {
      // Give earlier stages more games so ordering is deterministic and all
      // qualify ahead of later ones.
      const count = stageIds.length - i;
      for (let g = 0; g < count; g++) {
        matches.push(makeMatch(`${stageId}-${g}`, i * 10 + g, true, stageId, `Stage ${stageId}`));
      }
    });
    const tiles = buildTopStageTiles(matches);
    expect(tiles).toHaveLength(6);
    expect(tiles.map((t) => t.stage.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('StageTiles', () => {
  it('shows an empty state when there is no stage data', () => {
    render(<StageTiles matches={[]} />);
    expect(screen.getByText('No stage data to report yet.')).toBeInTheDocument();
  });

  it('renders real stage art for stages that have it', () => {
    const matches = [makeMatch('1', 1, true, 1, 'Battlefield')];
    const { container } = render(<StageTiles matches={matches} />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', '/assets/stages/1-battlefield.jpg');
  });

  it('renders a fallback abbreviation tile for stages without art', () => {
    const matches = [makeMatch('1', 1, true, 2, 'Big Battlefield')];
    const { container } = render(<StageTiles matches={matches} />);
    // Big Battlefield has url: '' in the reference data, so it should fall
    // back to the abbreviation tile instead of an <img>.
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('BB')).toBeInTheDocument();
  });

  it('shows the record and win rate for each tile', () => {
    const matches = [
      makeMatch('1', 1, true, 1, 'Battlefield'),
      makeMatch('2', 2, true, 1, 'Battlefield'),
      makeMatch('3', 3, false, 1, 'Battlefield'),
    ];
    render(<StageTiles matches={matches} />);
    expect(screen.getByText('Battlefield')).toBeInTheDocument();
    expect(screen.getByText(/2-1/)).toBeInTheDocument();
    expect(screen.getByText(/67%/)).toBeInTheDocument();
  });
});

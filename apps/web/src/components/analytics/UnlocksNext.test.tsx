import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnlocksNext, type UnlocksNextMeters } from './UnlocksNext';

describe('UnlocksNext', () => {
  it("renders the chip, name, and each meter's sentence and count label", () => {
    const meters: UnlocksNextMeters = [
      { sentence: 'Play 5 more games with Terry.', have: 3, need: 8, countLabel: '3 of 8 games' },
      {
        sentence: 'Play 3 more sets against Falcon.',
        have: 5,
        need: 8,
        countLabel: '5 of 8 sets',
      },
    ];
    render(
      <UnlocksNext chip={<span>Unlocks next · locked</span>} name="Unlocks next" meters={meters} />,
    );
    expect(screen.getByText('Unlocks next · locked')).toBeInTheDocument();
    expect(screen.getByText('Play 5 more games with Terry.')).toBeInTheDocument();
    expect(screen.getByText('3 of 8 games')).toBeInTheDocument();
    expect(screen.getByText('Play 3 more sets against Falcon.')).toBeInTheDocument();
    expect(screen.getByText('5 of 8 sets')).toBeInTheDocument();
  });

  it("each meter's track carries an image role whose accessible name is the countLabel prop", () => {
    const meters: UnlocksNextMeters = [
      { sentence: 'Play 5 more games with Terry.', have: 3, need: 8, countLabel: '3 of 8 games' },
    ];
    render(<UnlocksNext chip={<span>chip</span>} name="Unlocks next" meters={meters} />);
    expect(screen.getByRole('img', { name: '3 of 8 games' })).toBeInTheDocument();
  });

  it('renders no doors and no dismiss control', () => {
    const meters: UnlocksNextMeters = [
      { sentence: 'sentence', have: 1, need: 8, countLabel: '1 of 8 games' },
    ];
    render(<UnlocksNext chip={<span>chip</span>} name="Unlocks next" meters={meters} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('a four-meter array is rejected by the type checker', () => {
    // @ts-expect-error — UnlocksNextMeters caps at three entries
    const meters: UnlocksNextMeters = [
      { sentence: 'a', have: 1, need: 8, countLabel: 'a' },
      { sentence: 'b', have: 1, need: 8, countLabel: 'b' },
      { sentence: 'c', have: 1, need: 8, countLabel: 'c' },
      { sentence: 'd', have: 1, need: 8, countLabel: 'd' },
    ];
    expect(meters).toBeTruthy();
  });

  it('reads no salience field anywhere in its own source', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/UnlocksNext.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/salience/i);
  });
});

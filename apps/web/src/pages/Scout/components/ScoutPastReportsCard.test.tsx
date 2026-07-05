import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScoutReportRecord } from '@smash-tracker/shared';
import { ScoutPastReportsCard } from './ScoutPastReportsCard';

const RECORDS: ScoutReportRecord[] = [
  {
    id: 'r1',
    createdAt: 1_700_000_000_000,
    model: 'claude-opus-4-8',
    player: { id: 1802316, gamerTag: 'Pandem1c' },
    report: {
      overview: 'overview',
      gameplan: [],
      stageStrategy: { bans: [], picks: [], reasoning: '' },
      headToHead: null,
      watchFor: [],
      confidenceNotes: '',
    },
  },
  {
    id: 'r2',
    createdAt: 1_700_100_000_000,
    model: 'claude-opus-4-8',
    player: { id: 999, gamerTag: 'PowPow' },
    report: {
      overview: 'overview 2',
      gameplan: [],
      stageStrategy: { bans: [], picks: [], reasoning: '' },
      headToHead: null,
      watchFor: [],
      confidenceNotes: '',
    },
  },
];

describe('ScoutPastReportsCard', () => {
  it('renders one entry per report, showing gamer tag and date', () => {
    render(<ScoutPastReportsCard reports={RECORDS} onSelect={() => {}} />);

    expect(screen.getByText('Pandem1c')).toBeInTheDocument();
    expect(screen.getByText('PowPow')).toBeInTheDocument();
  });

  it('calls onSelect with the clicked record', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ScoutPastReportsCard reports={RECORDS} onSelect={onSelect} />);

    await user.click(screen.getByText('Pandem1c'));

    expect(onSelect).toHaveBeenCalledWith(RECORDS[0]);
  });
});

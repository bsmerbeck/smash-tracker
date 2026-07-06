import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScoutReportRecord } from '@smash-tracker/shared';
import { ScoutReportHistorySelector } from './ScoutReportHistorySelector';

function makeRecord(id: string, createdAt: number): ScoutReportRecord {
  return {
    id,
    createdAt,
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
  };
}

// Newest-first, matching GET /api/reports ordering.
const REPORTS: ScoutReportRecord[] = [
  makeRecord('r3', 1_700_300_000_000),
  makeRecord('r2', 1_700_200_000_000),
  makeRecord('r1', 1_700_100_000_000),
];

describe('ScoutReportHistorySelector', () => {
  it('shows "Report N of total" counting from the oldest, for the newest report by default', () => {
    render(<ScoutReportHistorySelector reports={REPORTS} index={0} onChange={() => {}} />);
    expect(screen.getByText(/Report 3 of 3/)).toBeInTheDocument();
  });

  it('moves to an older report and back with prev/next', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScoutReportHistorySelector reports={REPORTS} index={0} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Older report' }));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('disables "newer" at the newest report and "older" at the oldest', () => {
    const { rerender } = render(
      <ScoutReportHistorySelector reports={REPORTS} index={0} onChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Newer report' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Older report' })).not.toBeDisabled();

    rerender(<ScoutReportHistorySelector reports={REPORTS} index={2} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Older report' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Newer report' })).not.toBeDisabled();
  });

  it('renders nothing for an out-of-range index', () => {
    const { container } = render(
      <ScoutReportHistorySelector reports={REPORTS} index={99} onChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScoutReportRecord } from '@smash-tracker/shared';
import { ScoutAiReportCard } from './ScoutAiReportCard';

const RECORD: ScoutReportRecord = {
  id: 'r1',
  createdAt: Date.now() - 60 * 1000,
  model: 'claude-opus-4-8',
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  report: {
    overview: 'A fast-falling Fox/Falco player who plays aggressively.',
    gameplan: ['Punish landing lag hard.', 'Avoid neutral vs their dash dance.'],
    characterStrategy: {
      picks: ['Mario'],
      reasoning: 'Game 1: Mario; if they swap to Falco, keep Mario.',
    },
    stageStrategy: {
      bans: ['Final Destination'],
      picks: ['Battlefield'],
      reasoning: 'They perform best on flat stages with no platforms.',
    },
    headToHead: null,
    watchFor: ['Likes to shine spike off stage.'],
    confidenceNotes: 'Only 20 games sampled — treat character splits as light samples.',
  },
};

describe('ScoutAiReportCard', () => {
  it('renders the overview, gameplan, stage strategy, watch-for, and confidence notes', () => {
    render(<ScoutAiReportCard record={RECORD} />);

    expect(screen.getAllByText(RECORD.report.overview).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Punish landing lag hard.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Avoid neutral vs their dash dance.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Final Destination').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Battlefield').length).toBeGreaterThan(0);
    expect(screen.getAllByText(RECORD.report.stageStrategy.reasoning).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Likes to shine spike off stage.').length).toBeGreaterThan(0);
    expect(screen.getAllByText(RECORD.report.confidenceNotes).length).toBeGreaterThan(0);
  });

  it('renders the character strategy section when present', () => {
    render(<ScoutAiReportCard record={RECORD} />);

    expect(screen.getAllByText('Character strategy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mario').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Game 1: Mario; if they swap to Falco, keep Mario.').length,
    ).toBeGreaterThan(0);
  });

  it('does not render a character strategy section when absent (pre-B.1 stored record)', () => {
    const record: ScoutReportRecord = {
      ...RECORD,
      report: { ...RECORD.report, characterStrategy: undefined },
    };
    render(<ScoutAiReportCard record={record} />);
    expect(screen.queryByText('Character strategy')).not.toBeInTheDocument();
  });

  it('does not render a head-to-head section when headToHead is null', () => {
    render(<ScoutAiReportCard record={RECORD} />);
    expect(screen.queryByText('Head-to-head')).not.toBeInTheDocument();
  });

  it('renders the head-to-head section when present', () => {
    const record: ScoutReportRecord = {
      ...RECORD,
      report: {
        ...RECORD.report,
        headToHead: 'You are 2-1 against this player, all on Battlefield.',
      },
    };
    render(<ScoutAiReportCard record={record} />);
    expect(screen.getAllByText('Head-to-head').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('You are 2-1 against this player, all on Battlefield.').length,
    ).toBeGreaterThan(0);
  });

  it('shows a "Generated <relative date>" line', () => {
    render(<ScoutAiReportCard record={RECORD} />);
    expect(screen.getByText(/Generated .*ago/)).toBeInTheDocument();
  });
});

describe('ScoutAiReportCard — download', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it('downloads a Markdown blob named after the gamer tag and date on click', async () => {
    const user = userEvent.setup();
    render(<ScoutAiReportCard record={RECORD} />);

    await user.click(screen.getByRole('button', { name: /Download \(\.md\)/ }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const [blobArg] = createObjectURL.mock.calls[0] as [Blob];
    expect(blobArg.type).toContain('text/markdown');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

describe('ScoutAiReportCard — print', () => {
  it('calls window.print() when the print button is clicked', async () => {
    const user = userEvent.setup();
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<ScoutAiReportCard record={RECORD} />);

    await user.click(screen.getByRole('button', { name: /Print \/ Save as PDF/ }));

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});

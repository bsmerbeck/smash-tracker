import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GeneratedScoutReport } from '@smash-tracker/shared';
import { ScoutAiReportCard } from './ScoutAiReportCard';

const REPORT: GeneratedScoutReport = {
  overview: 'A fast-falling Fox/Falco player who plays aggressively.',
  gameplan: ['Punish landing lag hard.', 'Avoid neutral vs their dash dance.'],
  stageStrategy: {
    bans: ['Final Destination'],
    picks: ['Battlefield'],
    reasoning: 'They perform best on flat stages with no platforms.',
  },
  headToHead: null,
  watchFor: ['Likes to shine spike off stage.'],
  confidenceNotes: 'Only 20 games sampled — treat character splits as light samples.',
};

describe('ScoutAiReportCard', () => {
  it('renders the overview, gameplan, stage strategy, watch-for, and confidence notes', () => {
    render(<ScoutAiReportCard report={REPORT} />);

    expect(screen.getByText(REPORT.overview)).toBeInTheDocument();
    expect(screen.getByText('Punish landing lag hard.')).toBeInTheDocument();
    expect(screen.getByText('Avoid neutral vs their dash dance.')).toBeInTheDocument();
    expect(screen.getByText('Final Destination')).toBeInTheDocument();
    expect(screen.getByText('Battlefield')).toBeInTheDocument();
    expect(screen.getByText(REPORT.stageStrategy.reasoning)).toBeInTheDocument();
    expect(screen.getByText('Likes to shine spike off stage.')).toBeInTheDocument();
    expect(screen.getByText(REPORT.confidenceNotes)).toBeInTheDocument();
  });

  it('does not render a head-to-head section when headToHead is null', () => {
    render(<ScoutAiReportCard report={REPORT} />);
    expect(screen.queryByText('Head-to-head')).not.toBeInTheDocument();
  });

  it('renders the head-to-head section when present', () => {
    render(
      <ScoutAiReportCard
        report={{ ...REPORT, headToHead: 'You are 2-1 against this player, all on Battlefield.' }}
      />,
    );
    expect(screen.getByText('Head-to-head')).toBeInTheDocument();
    expect(
      screen.getByText('You are 2-1 against this player, all on Battlefield.'),
    ).toBeInTheDocument();
  });
});

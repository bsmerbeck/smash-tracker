import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ScoutReportData } from '@smash-tracker/shared';
import { ScoutReportHeader } from './ScoutReportHeader';

function baseReport(overrides: Partial<ScoutReportData['player']> = {}): ScoutReportData {
  return {
    player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239', ...overrides },
    sampledSets: 3,
    sampledGames: 6,
    characters: [],
    stages: [],
    recentEvents: [],
    commonOpponents: [],
  };
}

describe('ScoutReportHeader', () => {
  it('links to start.gg for a pre-V9-B report with no source field (back-compat)', () => {
    render(<ScoutReportHeader report={baseReport()} />);
    const link = screen.getByRole('link', { name: /View Pandem1c on start\.gg/ });
    expect(link).toHaveAttribute('href', 'https://start.gg/user/07dc2239');
    expect(screen.getByText(/Public start\.gg data/)).toBeInTheDocument();
  });

  it('links to parry.gg for a parrygg-sourced report', () => {
    const report: ScoutReportData = {
      player: {
        gamerTag: 'Pandem1c',
        source: 'parrygg',
        parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
      },
      sampledSets: 1,
      sampledGames: 2,
      characters: [],
      stages: [],
      recentEvents: [],
      commonOpponents: [],
    };
    render(<ScoutReportHeader report={report} />);
    const link = screen.getByRole('link', { name: /View Pandem1c on parry\.gg/ });
    expect(link).toHaveAttribute(
      'href',
      'https://parry.gg/profile/019ce9ba-debd-7e11-84a2-77258f52644e',
    );
    expect(screen.getByText(/Public parry\.gg data/)).toBeInTheDocument();
  });

  it('renders no profile link when no identifying slug/id is available', () => {
    render(<ScoutReportHeader report={baseReport({ userSlug: undefined })} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('V13: a combined report links to BOTH sites and shows the combined caption', () => {
    const report: ScoutReportData = {
      player: {
        source: 'combined',
        id: 1802316,
        userSlug: 'user/07dc2239',
        parryUserId: '019ce9ba-debd-7e11-84a2-77258f52644e',
        gamerTag: 'Pandem1c',
      },
      sampledSets: 5,
      sampledGames: 12,
      characters: [],
      stages: [],
      recentEvents: [],
      commonOpponents: [],
    };
    render(<ScoutReportHeader report={report} />);
    expect(screen.getByRole('link', { name: /View Pandem1c on start\.gg/ })).toHaveAttribute(
      'href',
      'https://start.gg/user/07dc2239',
    );
    expect(screen.getByRole('link', { name: /View Pandem1c on parry\.gg/ })).toHaveAttribute(
      'href',
      'https://parry.gg/profile/019ce9ba-debd-7e11-84a2-77258f52644e',
    );
    expect(screen.getByText(/Public start\.gg \+ parry\.gg data/)).toBeInTheDocument();
  });
});

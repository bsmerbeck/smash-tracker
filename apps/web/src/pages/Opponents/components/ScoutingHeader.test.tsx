import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { OpponentProfile } from '@/lib/stats';
import { ScoutingHeader } from '@/pages/Opponents/components/ScoutingHeader';

/**
 * 38-10 (38-UAT test 22, F18): a single-month encounter span must read
 * "Met at 1 tournament in Jul 2026" — never the dangling
 * "between Jul 2026" the hard-coded "between" template produced.
 */
function makeProfile(): OpponentProfile {
  return {
    opponent: 'moton',
    record: { wins: 1, losses: 1, total: 2, winRate: 50 },
    firstPlayedAt: Date.UTC(2026, 6, 10),
    lastPlayedAt: Date.UTC(2026, 6, 12),
    byTheirFighter: [],
    byStage: [],
    recent: [],
  } as unknown as OpponentProfile;
}

describe('ScoutingHeader — encounter context line (38-10)', () => {
  it('a same-month span reads "in <month>", with no "between"', () => {
    render(
      <ScoutingHeader
        profile={makeProfile()}
        encounterContext={{
          tournamentCount: 1,
          span: { start: Date.UTC(2026, 6, 10), end: Date.UTC(2026, 6, 12) },
        }}
        source="startgg"
      />,
    );
    expect(screen.getByText('Met at 1 tournament in Jul 2026')).toBeInTheDocument();
    expect(screen.queryByText(/between/)).not.toBeInTheDocument();
  });

  it('a multi-month span keeps "between <start> and <end>"', () => {
    render(
      <ScoutingHeader
        profile={makeProfile()}
        encounterContext={{
          tournamentCount: 2,
          span: { start: Date.UTC(2026, 6, 10), end: Date.UTC(2026, 8, 12) },
        }}
        source="startgg"
      />,
    );
    expect(
      screen.getByText('Met at 2 tournaments between Jul 2026 and Sep 2026'),
    ).toBeInTheDocument();
  });
});

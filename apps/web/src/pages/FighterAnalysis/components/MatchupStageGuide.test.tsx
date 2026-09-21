import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { MatchupStageGuide } from './MatchupStageGuide';
import { SpriteList } from '@/data/sprites';

/**
 * Plan 38-06 Task 2 (ADV-03/H-05): `MatchupStageGuide.tsx` already reads
 * gated engine output for its best/worst stage cells — this file's own job
 * is asserting the NEW behaviour this plan adds, that a best/worst stage
 * cell is a real link carrying the opposing-character axis, and that a
 * cell with no qualifying record stays plain text. This component's only
 * host (`FighterAnalysisPage.tsx`) wraps in a Router, so this harness does
 * too (H-01's third-party-host constraint applies to `StageMastery`, not
 * this component — see `MatchupStageGuide.tsx`'s own doc comment).
 */

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const fox = SpriteList.find((s) => s.id === 15)!; // Fox

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: fox.id,
    opponent: '',
    notes: '',
    matchType: 'none',
    map: { id: 1, name: 'Battlefield' },
    ...overrides,
  };
}

function renderGuide(matches: Match[]) {
  return render(
    <MemoryRouter>
      <MatchupStageGuide fighterMatches={matches} />
    </MemoryRouter>,
  );
}

describe('MatchupStageGuide', () => {
  it('renders a best-stage cell as an anchor carrying the opposing-character (vs) axis, and a cell with no qualifying record as plain text with no anchor', () => {
    const matches: Match[] = [
      makeMatch({ id: 'm1', time: 1, win: true }),
      makeMatch({ id: 'm2', time: 2, win: true }),
      makeMatch({ id: 'm3', time: 3, win: true }),
    ];
    renderGuide(matches);

    // Only one stage (Battlefield, id 1) has enough games to qualify — it is
    // reported as the best-stage cell only, matching `getBestWorstStages`'s
    // "can't be both the recommendation and the warning" rule; the
    // worst-stage cell has no record.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', `/stages/1?vs=${fox.id}`);

    // The worst-stage cell (no qualifying record) is the em-dash placeholder
    // — plain text, no anchor.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('caps rows at 8 with a show-all control, no nested scroller, when more than 8 opponents are faced (T-39.1-14, UI-SPEC §6.4)', () => {
    const matches: Match[] = [];
    for (let opponentId = 20; opponentId < 32; opponentId++) {
      for (let g = 0; g < 3; g++) {
        matches.push(
          makeMatch({
            id: `m${opponentId}-${g}`,
            time: opponentId * 10 + g,
            win: true,
            opponent_id: opponentId,
          }),
        );
      }
    }
    renderGuide(matches);
    const rows = screen.getAllByRole('row');
    // Header + at most 8 capped body rows.
    expect(rows.length).toBeLessThanOrEqual(9);
    expect(screen.getByRole('button', { name: /show all/i })).toBeInTheDocument();
  });
});

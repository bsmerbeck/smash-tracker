import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { MatchupStageTable } from './MatchupStageTable';

const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const BIG_BATTLEFIELD = { id: 2, name: 'Big Battlefield' };
/** Not present in `stagesById` — an id `getStageRecords` groups on its own (never folded into id 0), but still counts as "no recognised stage" per item 8. */
const UNRECOGNISED_STAGE = { id: 9999, name: 'Mystery Stage' };

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

function bodyRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-slot="table-body"] tr'));
}

describe('MatchupStageTable (39.1-31, item 8)', () => {
  it('lists only the recognised stage, discloses the no-map + unrecognised-id games in one footnote, and the rows plus footnote fully account for every game', () => {
    const matches: Match[] = [
      makeMatch({ id: 'bf0', map: BATTLEFIELD, win: true }),
      makeMatch({ id: 'bf1', map: BATTLEFIELD, win: true }),
      makeMatch({ id: 'bf2', map: BATTLEFIELD, win: false }),
      makeMatch({ id: 'nomap0', map: undefined }),
      makeMatch({ id: 'nomap1', map: undefined }),
      makeMatch({ id: 'unk0', map: UNRECOGNISED_STAGE }),
    ];
    const { container } = render(<MatchupStageTable matchupMatches={matches} />);

    const rows = bodyRows(container);
    expect(rows.length).toBe(1);
    expect(within(rows[0]!).getByText('Battlefield')).toBeInTheDocument();

    expect(screen.queryByText(/\bUNK\b/)).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();

    const footnote = container.querySelector('[data-slot="stage-table-no-stage"]');
    expect(footnote).toBeInTheDocument();
    expect(footnote!.textContent).toBe('3 games with no stage recorded');

    // Row totals (wins + losses parsed off the row's own record cell) plus
    // the footnote's own count equal the pairing's full game count.
    const rowGames = rows.reduce((sum, row) => {
      const [wins, losses] = (within(row).getByText(/^\d+-\d+$/).textContent ?? '0-0')
        .split('-')
        .map(Number);
      return sum + (wins ?? 0) + (losses ?? 0);
    }, 0);
    expect(rowGames + 3).toBe(matches.length);
  });

  it('uses the singular footnote for exactly one unstaged game', () => {
    const matches: Match[] = [
      makeMatch({ id: 'bf0', map: BATTLEFIELD, win: true }),
      makeMatch({ id: 'nomap0', map: undefined }),
    ];
    const { container } = render(<MatchupStageTable matchupMatches={matches} />);

    const footnote = container.querySelector('[data-slot="stage-table-no-stage"]');
    expect(footnote?.textContent).toBe('1 game with no stage recorded');
  });

  it('renders only the footnote (no table, no empty copy) when every game is unstaged', () => {
    const matches: Match[] = [
      makeMatch({ id: 'nomap0', map: undefined }),
      makeMatch({ id: 'nomap1', map: undefined }),
      makeMatch({ id: 'nomap2', map: undefined }),
    ];
    const { container } = render(<MatchupStageTable matchupMatches={matches} />);

    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('[data-slot="stage-table-no-stage"]')).toBeInTheDocument();
    expect(screen.queryByText('No matches recorded for this matchup yet.')).not.toBeInTheDocument();
  });

  it('renders the existing empty copy and no footnote when there are no games at all', () => {
    const { container } = render(<MatchupStageTable matchupMatches={[]} />);

    expect(screen.getByText('No matches recorded for this matchup yet.')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="stage-table-no-stage"]')).toBeNull();
  });

  it('breaks an equal-total tie deterministically by ascending stage id', () => {
    const matches: Match[] = [
      makeMatch({ id: 'bb0', map: BIG_BATTLEFIELD, win: true }),
      makeMatch({ id: 'bb1', map: BIG_BATTLEFIELD, win: false }),
      makeMatch({ id: 'bf0', map: BATTLEFIELD, win: true }),
      makeMatch({ id: 'bf1', map: BATTLEFIELD, win: false }),
    ];
    const { container } = render(<MatchupStageTable matchupMatches={matches} />);

    const rows = bodyRows(container);
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain('Battlefield');
    expect(rows[1]!.textContent).toContain('Big Battlefield');
  });
});

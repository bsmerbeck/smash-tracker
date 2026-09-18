import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { MatchupTable, MATCHUP_TABLE_ANCHOR_ID } from './MatchupTable';

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

/**
 * `selectedMatchIds`/`setSelectedMatchIds` come from `MatchupsContext`
 * (D-07, CHRT-02) — this fixture always supplies both, matching the shape
 * production's `MatchupsPage` provides.
 */
function renderTable(
  matchupMatches: Match[],
  overrides: Partial<MatchupsContextValue> = {},
): { setSelectedMatchIds: ReturnType<typeof vi.fn> } {
  const setSelectedMatchIds = vi.fn();
  const contextValue: MatchupsContextValue = {
    fighterSprites: [],
    fighter: undefined,
    setFighter: vi.fn(),
    opponent: undefined,
    setOpponent: vi.fn(),
    fighterUsageById: new Map(),
    opponentUsage: [],
    selectedMatchIds: null,
    setSelectedMatchIds,
    ...overrides,
  };

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MatchupsContext.Provider value={contextValue}>
          <MatchupTable matchupMatches={matchupMatches} />
        </MatchupsContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { setSelectedMatchIds };
}

describe('MatchupTable', () => {
  it('renders the existing no-matches sentence byte-for-byte when there is no selection and zero matches', () => {
    renderTable([]);
    expect(screen.getByText('No matches reported yet!')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('exports MATCHUP_TABLE_ANCHOR_ID as the module-scope scroll target id', () => {
    expect(MATCHUP_TABLE_ANCHOR_ID).toBe('matchup-table');
  });

  describe('with a selection active (D-07, CHRT-02)', () => {
    const matches = [
      makeMatch({ id: 'm1', time: 3000, win: true }),
      makeMatch({ id: 'm2', time: 2000, win: false }),
      makeMatch({ id: 'm3', time: 1000, win: true }),
    ];

    it('filters to exactly one row and shows the singular notice for a one-id selection', () => {
      renderTable(matches, { selectedMatchIds: new Set(['m2']) });

      expect(screen.getAllByRole('row')).toHaveLength(2); // header + 1 data row
      expect(screen.getByText('Showing 1 match from the chart.')).toBeInTheDocument();
    });

    it('filters to two rows and shows the plural notice for a two-id selection', () => {
      renderTable(matches, { selectedMatchIds: new Set(['m1', 'm3']) });

      expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 data rows
      expect(screen.getByText('Showing 2 matches from the chart.')).toBeInTheDocument();
    });

    it('never re-sorts: a selection narrows the existing newest-first order', () => {
      renderTable(matches, { selectedMatchIds: new Set(['m1', 'm2', 'm3']) });

      const cells = screen.getAllByRole('row').slice(1); // drop header row
      // Newest first: m1 (time 3000), m2 (2000), m3 (1000) — the win/loss
      // column values in that order prove the sort was preserved, not redone.
      expect(cells[0]).toHaveTextContent('Win');
      expect(cells[1]).toHaveTextContent('Loss');
      expect(cells[2]).toHaveTextContent('Win');
    });

    it('activating the clear action calls setSelectedMatchIds(null)', async () => {
      const user = userEvent.setup();
      const { setSelectedMatchIds } = renderTable(matches, {
        selectedMatchIds: new Set(['m2']),
      });

      await user.click(screen.getByRole('button', { name: 'Show all matches' }));

      expect(setSelectedMatchIds).toHaveBeenCalledWith(null);
    });

    it('a selection matching zero of the current matches renders the notice and clear control, never the no-matches sentence, and no table', () => {
      renderTable(matches, { selectedMatchIds: new Set(['does-not-exist']) });

      expect(screen.getByText('Showing 0 matches from the chart.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show all matches' })).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByText('No matches reported yet!')).not.toBeInTheDocument();
    });

    it('a selection against zero underlying matches also renders the notice, never the no-matches sentence', () => {
      renderTable([], { selectedMatchIds: new Set(['does-not-exist']) });

      expect(screen.getByText('Showing 0 matches from the chart.')).toBeInTheDocument();
      expect(screen.queryByText('No matches reported yet!')).not.toBeInTheDocument();
    });
  });

  it('with no selection, renders every match unfiltered and no notice', () => {
    renderTable([
      makeMatch({ id: 'm1', time: 3000, win: true }),
      makeMatch({ id: 'm2', time: 2000, win: false }),
    ]);

    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 data rows
    expect(screen.queryByRole('button', { name: 'Show all matches' })).not.toBeInTheDocument();
  });
});

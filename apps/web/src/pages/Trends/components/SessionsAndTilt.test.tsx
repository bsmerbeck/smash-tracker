import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import {
  SessionsAndTilt,
  TILT_HIGHLIGHT_THRESHOLD,
  buildSessionsHeadline,
} from './SessionsAndTilt';
import { getSessions } from '@/lib/stats';
import * as drillDownParamsModule from '@/lib/drillDownParams';

/**
 * WR-03 (38-REVIEW-FIX): a partial mock of `matchesDrillDown` — see
 * `OpponentHubPage.test.tsx`'s identical mock for the full rationale. Used
 * as the observable signal that `FilteredMatchList`'s D-16 memo actually
 * hits its cache across an unrelated re-render.
 */
vi.mock('@/lib/drillDownParams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/drillDownParams')>();
  return { ...actual, matchesDrillDown: vi.fn(actual.matchesDrillDown) };
});

function sessionsTree(ui: React.ReactElement, queryClient: QueryClient) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(sessionsTree(ui, queryClient));
  return { ...result, queryClient };
}

const HOUR = 60 * 60 * 1000;

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

describe('buildSessionsHeadline', () => {
  it('returns zeroed/null headline for no sessions', () => {
    expect(buildSessionsHeadline([])).toEqual({
      totalSessions: 0,
      avgGamesPerSession: 0,
      bestSession: null,
      worstTiltSession: null,
    });
  });

  it('computes total sessions and average games per session', () => {
    const matches = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: 1, win: true }),
      // gap > default 3h starts a new session
      makeMatch({ id: '3', time: 5 * HOUR, win: false }),
    ];
    const sessions = getSessions(matches);
    const headline = buildSessionsHeadline(sessions);

    expect(headline.totalSessions).toBe(2);
    expect(headline.avgGamesPerSession).toBe(1.5);
  });

  it('picks the session with the best net wins as bestSession', () => {
    const matches = [
      // Session A: 1-2 (net -1)
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: 1, win: false }),
      makeMatch({ id: '3', time: 2, win: false }),
      // Session B: 3-0 (net +3) — should win
      makeMatch({ id: '4', time: 10 * HOUR, win: true }),
      makeMatch({ id: '5', time: 10 * HOUR + 1, win: true }),
      makeMatch({ id: '6', time: 10 * HOUR + 2, win: true }),
    ];
    const sessions = getSessions(matches);
    const headline = buildSessionsHeadline(sessions);

    expect(headline.bestSession?.wins).toBe(3);
    expect(headline.bestSession?.losses).toBe(0);
  });

  it('picks the session with the longest loss run as worstTiltSession', () => {
    const matches = [
      // Session A: loss run of 1
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: 1, win: false }),
      // Session B: loss run of 3
      makeMatch({ id: '3', time: 10 * HOUR, win: false }),
      makeMatch({ id: '4', time: 10 * HOUR + 1, win: false }),
      makeMatch({ id: '5', time: 10 * HOUR + 2, win: false }),
    ];
    const sessions = getSessions(matches);
    const headline = buildSessionsHeadline(sessions);

    expect(headline.worstTiltSession?.longestLossRun).toBe(3);
  });

  it('reports worstTiltSession as null when there are no losses at all', () => {
    const matches = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: 1, win: true }),
    ];
    const headline = buildSessionsHeadline(getSessions(matches));
    expect(headline.worstTiltSession).toBeNull();
  });
});

describe('SessionsAndTilt component', () => {
  it('shows an empty state with no match data', () => {
    render(<SessionsAndTilt matches={[]} />);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('renders headline stats and a recent-sessions table row', () => {
    const matches = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: 1, win: false }),
    ];
    render(<SessionsAndTilt matches={matches} />);

    expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    expect(screen.getByText('Avg Games / Session')).toBeInTheDocument();
    expect(screen.getByText('Best Session')).toBeInTheDocument();
    expect(screen.getByText('Worst Tilt')).toBeInTheDocument();
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });

  it(`highlights a loss run >= ${TILT_HIGHLIGHT_THRESHOLD} with the destructive badge`, () => {
    const matches = [
      makeMatch({ id: '1', time: 0, win: false }),
      makeMatch({ id: '2', time: 1, win: false }),
      makeMatch({ id: '3', time: 2, win: false }),
    ];
    render(<SessionsAndTilt matches={matches} />);

    const badge = document.querySelector('[data-slot="badge"]');
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent('3');
    expect(badge?.className).toContain('destructive');
  });

  it('does not highlight a loss run below the threshold', () => {
    const matches = [
      makeMatch({ id: '1', time: 0, win: false }),
      makeMatch({ id: '2', time: 1, win: true }),
    ];
    render(<SessionsAndTilt matches={matches} />);

    // Longest loss run of 1 rendered as plain text, not a badge.
    const cell = screen.getAllByRole('cell').find((c) => c.textContent === '1');
    expect(cell?.querySelector('[data-slot="badge"]')).toBeNull();
  });

  describe('D-14: a session row opens the filtered match list for its inclusive window', () => {
    it('toggles an inline FilteredMatchList scoped to the session start/end window', async () => {
      const user = userEvent.setup();
      const sessionAStart = Date.UTC(2023, 5, 15, 12);
      const matches = [
        makeMatch({ id: '1', time: sessionAStart, win: true }),
        makeMatch({ id: '2', time: sessionAStart + 1, win: false }),
        // A second, distant session — must NOT appear in session A's window.
        makeMatch({ id: '3', time: Date.UTC(2024, 0, 10, 12), win: true }),
      ];
      renderWithProviders(<SessionsAndTilt matches={matches} />);

      const dateCell = screen.getAllByRole('cell').find((c) => c.textContent?.includes('2023'))!;
      const row = within(dateCell.closest('tr')!).getByRole('button', { name: /opens details/ });
      expect(row).toHaveAttribute('aria-expanded', 'false');

      await user.click(row);
      expect(row).toHaveAttribute('aria-expanded', 'true');
      // Two games narrowed to the first session's window; the summary line
      // proves the terminus actually narrowed rather than showing everything.
      expect(screen.getByText(/2 games/)).toBeInTheDocument();

      await user.click(row);
      expect(row).toHaveAttribute('aria-expanded', 'false');
    });
  });

  describe('WR-03 (38-REVIEW-FIX): D-16 memoization contract', () => {
    it('an unrelated re-render does not re-run the terminus narrowing predicate once a session is expanded', async () => {
      const matchesDrillDownSpy = vi.mocked(drillDownParamsModule.matchesDrillDown);
      const user = userEvent.setup();
      const sessionAStart = Date.UTC(2023, 5, 15, 12);
      const matches = [
        makeMatch({ id: '1', time: sessionAStart, win: true }),
        makeMatch({ id: '2', time: sessionAStart + 1, win: false }),
      ];
      const { rerender, queryClient } = renderWithProviders(<SessionsAndTilt matches={matches} />);

      const dateCell = screen.getAllByRole('cell').find((c) => c.textContent?.includes('2023'))!;
      const row = within(dateCell.closest('tr')!).getByRole('button', { name: /opens details/ });
      await user.click(row);
      expect(screen.getByText(/2 games/)).toBeInTheDocument();

      const callsBefore = matchesDrillDownSpy.mock.calls.length;
      expect(callsBefore).toBeGreaterThan(0);

      // Neither `SessionsAndTilt` nor `FilteredMatchList` is wrapped in
      // `React.memo`, so re-invoking `render()` on the same root always
      // re-runs both function bodies — the only thing under test is
      // whether that re-run recomputes `FilteredMatchList`'s own narrowing
      // memo. A stable per-session `axes` reference (looked up from a
      // memoized Map, never a fresh `{ from, to }` literal per render)
      // means it doesn't: `matchesDrillDown`'s call count stays flat.
      rerender(sessionsTree(<SessionsAndTilt matches={matches} />, queryClient));

      expect(screen.getByText(/2 games/)).toBeInTheDocument();
      expect(matchesDrillDownSpy.mock.calls.length).toBe(callsBefore);
    });
  });
});

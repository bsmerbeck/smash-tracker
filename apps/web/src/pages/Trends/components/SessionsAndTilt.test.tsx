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

  it('renders headline stat figures and a recent-session row', () => {
    const matches = [
      makeMatch({ id: '1', time: 0, win: true }),
      makeMatch({ id: '2', time: 1, win: false }),
    ];
    render(<SessionsAndTilt matches={matches} />);

    expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    expect(screen.getByText('Avg Games / Session')).toBeInTheDocument();
    expect(screen.getByText('Best Session')).toBeInTheDocument();
    expect(screen.getByText('Worst Tilt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /opens details/ })).toBeInTheDocument();
  });

  it(`highlights a loss run >= ${TILT_HIGHLIGHT_THRESHOLD} inline on the row`, () => {
    const matches = [
      makeMatch({ id: '1', time: 0, win: false }),
      makeMatch({ id: '2', time: 1, win: false }),
      makeMatch({ id: '3', time: 2, win: false }),
    ];
    render(<SessionsAndTilt matches={matches} />);

    // Both the "Worst Tilt" headline figure and the session row itself
    // render the same "3L run" text on this single-session fixture.
    expect(screen.getAllByText('3L run').length).toBeGreaterThanOrEqual(1);
  });

  it('does not highlight a loss run below the threshold on the row (only the headline figure states the count)', () => {
    const matches = [
      makeMatch({ id: '1', time: 0, win: false }),
      makeMatch({ id: '2', time: 1, win: true }),
    ];
    render(<SessionsAndTilt matches={matches} />);

    // The "Worst Tilt" headline figure always states the real count; only
    // the ROW's own destructive-tone highlight is threshold-gated. With one
    // session and a 1-loss run, exactly one "1L run" renders (the headline).
    expect(screen.getAllByText('1L run').length).toBe(1);
  });

  it('carries no stretch utility on its card root (UIX-04)', () => {
    const { container } = render(<SessionsAndTilt matches={[]} />);
    const cardRoot = container.querySelector('[data-slot="card"]');
    expect(cardRoot?.className).not.toMatch(/\bh-full\b/);
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

      const row = screen.getByRole('button', { name: /Jun 15, 2023.*opens details/ });
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

      const row = screen.getByRole('button', { name: /opens details/ });
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

  /**
   * Plan 39.1-40 OOS-4 (UI-SPEC §6.5 rules 1-2, §8.2 session row "date · … ·
   * Record"): a session row's date is never the row's flexible slot — it
   * reads whole (shrink-0 whitespace-nowrap, never truncate); the duration
   * and the loss-run tokens move to a wrapping meta line under the date.
   */
  describe('OOS-4: session dates read whole', () => {
    // One session of three straight losses (a 3L run on the row) lasting 25 min.
    const START = Date.UTC(2023, 10, 19, 18);
    const tiltSession = [
      makeMatch({ id: 'a', time: START, win: false }),
      makeMatch({ id: 'b', time: START + 10 * 60_000, win: false }),
      makeMatch({ id: 'c', time: START + 25 * 60_000, win: false }),
    ];
    const DATE_LABEL = new Date(START).toLocaleDateString('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    function sessionRow(): HTMLElement {
      const row = document.querySelector('[data-slot="bounded-list"] li');
      expect(row, 'no session row').not.toBeNull();
      return row as HTMLElement;
    }

    it("the row's date renders shrink-0 and whitespace-nowrap, never truncate", () => {
      renderWithProviders(<SessionsAndTilt matches={tiltSession} />);
      const date = within(sessionRow()).getByText(DATE_LABEL);
      expect(date.className).toMatch(/\bshrink-0\b/);
      expect(date.className).toMatch(/\bwhitespace-nowrap\b/);
      expect(date.className).not.toMatch(/\btruncate\b/);
      expect(date.className).not.toMatch(/\bflex-1\b/);
    });

    it('the duration and the loss-run tokens sit on a wrapping meta line under the date, not in the date line', () => {
      renderWithProviders(<SessionsAndTilt matches={tiltSession} />);
      const row = sessionRow();
      const date = within(row).getByText(DATE_LABEL);
      const duration = within(row).getByText('25 min');
      const lossRun = within(row).getByText('3L run');
      const meta = duration.parentElement!;
      expect(lossRun.parentElement).toBe(meta);
      for (const cls of ['flex', 'flex-wrap', 'gap-x-2', 'gap-y-0.5']) {
        expect(meta.classList.contains(cls), `meta line lacks ${cls}`).toBe(true);
      }
      expect(meta.contains(date)).toBe(false);
      expect(date.parentElement!.contains(duration)).toBe(false);
      // Under the date: the meta line follows the date's line in DOM order.
      expect(
        date.parentElement!.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('the row keeps its one DrillableRow overlay, its Record and its chevron, and expansion still mounts the FilteredMatchList', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SessionsAndTilt matches={tiltSession} />);
      const row = sessionRow();
      const overlays = within(row).getAllByRole('button', { name: /opens details/ });
      expect(overlays).toHaveLength(1);
      expect(overlays[0]!.getAttribute('aria-label')).toContain(DATE_LABEL);
      expect(overlays[0]).toHaveAttribute('aria-expanded', 'false');
      expect(row.querySelector('[data-slot="record"]')).not.toBeNull();
      expect(row.querySelector('svg[class*="chevron-right"]')).not.toBeNull();

      await user.click(overlays[0]!);
      expect(overlays[0]).toHaveAttribute('aria-expanded', 'true');
      expect(within(row).getByText(/3 games/)).toBeInTheDocument();
    });

    it('the card content carries the layout-neutral sessions-and-tilt hook (never the Card)', () => {
      const { container } = renderWithProviders(<SessionsAndTilt matches={tiltSession} />);
      const hook = container.querySelector('[data-slot="sessions-and-tilt"]');
      expect(hook).not.toBeNull();
      expect(hook!.matches('[data-slot="card"]')).toBe(false);
      expect(hook!.closest('[data-slot="card-content"]')).not.toBeNull();
      expect(hook!.querySelector('[data-slot="stat-row"]')).not.toBeNull();
      expect(hook!.querySelector('[data-slot="bounded-list"]')).not.toBeNull();
    });
  });

  it('bounds session rows with a show-all control once there are more than LIST_CAP_RAIL (5)', () => {
    const matches = Array.from({ length: 8 }, (_, i) =>
      makeMatch({ id: `s${i}`, time: i * 4 * HOUR, win: true }),
    );
    render(<SessionsAndTilt matches={matches} />);

    expect(screen.getByRole('button', { name: 'Show all 8' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /opens details/ }).length).toBe(5);
  });
});

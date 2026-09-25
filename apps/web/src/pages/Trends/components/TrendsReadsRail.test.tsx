import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { TrendsReadsRail, useTrendsInsights } from './TrendsReadsRail';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    getRedirectResult: mock.getRedirectResult,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const listMatches = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    matches: { list: (...args: unknown[]) => listMatches(...args) },
  },
}));

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

/**
 * A genuinely thin account: 3 games, none carrying an `eventName` — rendered
 * with `horizon="lastEvent"` so `RatingMove`'s recent sample is the empty
 * "no named event" window (0 games, below `ABSTENTION_FLOOR_GAMES` (3)) ->
 * `locked`. `RECENT_GAME_WINDOW`'s own game-count-based `last30` window would
 * instead take "the most recent N countable games", which can never be
 * smaller than the account's total game count — so a `last30`/`last90`
 * horizon can NEVER lock `RatingMove` on an account with >= `ABSTENTION_FLOOR_GAMES`
 * total games, structurally, regardless of how old those games are. The same
 * 3 games carry one qualifying 2-loss streak (loss, loss, win -> the third
 * game is a "spot") with only 1 spot (< `COHORT_MIN_SIDE_GAMES` 8 ->
 * `TiltCost` `locked` — `TiltCost`'s cohort split is horizon-independent, so
 * it locks the same way under any horizon). `SessionFatigue` has 0 long
 * (20+ game) sessions -> `hidden` (dropped entirely). Two locked candidates
 * merge into exactly one `UnlocksNext` card (D-14).
 */
function thinFixture(): Match[] {
  const base = NOW - 60 * DAY;
  return [
    makeMatch({ id: 'g1', time: base, win: false }),
    makeMatch({ id: 'g2', time: base + 60_000, win: false }),
    makeMatch({ id: 'g3', time: base + 120_000, win: true }),
  ];
}

/**
 * A large account whose late-session play differs sharply from its early-
 * session play across 10 sessions of 25 games each (>= `SESSION_FATIGUE_MIN_LONG_SESSIONS`
 * (10) long sessions) — `SessionFatigue` asserts (never `hidden`). Sessions
 * are 4h apart (over the 3h default gap); games inside a session are 60s
 * apart. The tail of each session (5 losses) also produces qualifying
 * 2-loss-streak "spots" for `TiltCost`.
 */
function sessionFatigueFixture(): Match[] {
  const SESSION_GAP_MS = 4 * HOUR;
  const GAME_GAP_MS = 60_000;
  const GAMES_PER_SESSION = 25;
  const SESSIONS = 10;
  const totalSpanMs = SESSIONS * GAMES_PER_SESSION * GAME_GAP_MS + (SESSIONS - 1) * SESSION_GAP_MS;
  let t = NOW - totalSpanMs - HOUR;
  const games: Match[] = [];
  for (let s = 0; s < SESSIONS; s++) {
    for (let g = 0; g < GAMES_PER_SESSION; g++) {
      const isLate = g >= 20;
      games.push(makeMatch({ id: `s${s}g${g}`, time: t, win: !isLate }));
      t += GAME_GAP_MS;
    }
    t += SESSION_GAP_MS;
  }
  return games;
}

/**
 * A small, alternating-result recent account: 5 games, no 2-loss streak
 * (so `TiltCost` never finds a spot -> no insight at all) and one session
 * (so `SessionFatigue` is `hidden`). `RatingMove`'s recent sample (5, all of
 * them) sits between `ABSTENTION_FLOOR_GAMES` (3) and `TREND_MIN_RECENT_GAMES`
 * (8) with no baseline to compare against -> `thin`, a direction-free FACT
 * card (not a line, not locked) — the one real regular card this rail can
 * render, carrying the rating-model door.
 */
function ratingCardFixture(): Match[] {
  return [
    makeMatch({ id: 'g1', time: NOW - 5 * 60_000, win: true }),
    makeMatch({ id: 'g2', time: NOW - 4 * 60_000, win: false }),
    makeMatch({ id: 'g3', time: NOW - 3 * 60_000, win: true }),
    makeMatch({ id: 'g4', time: NOW - 2 * 60_000, win: false }),
    makeMatch({ id: 'g5', time: NOW - 1 * 60_000, win: true }),
  ];
}

/**
 * Plan 39.1-24 (gap closure, Task 2): `TrendsReadsRail` no longer computes
 * its own `insights` — a host calls `useTrendsInsights` ONCE and hands the
 * result down (so a page-level terminus can share the SAME array for
 * `resolveClaim`), mirroring `FighterInsightRail`'s Task 1 pattern. This
 * harness reproduces that real usage pattern for the rail's own isolated
 * tests.
 */
function RailTestHarness({ matches, horizon }: { matches: Match[]; horizon: HorizonKey }) {
  const { insights, dismissedIds, dismiss, restoreAll } = useTrendsInsights({ matches, horizon });
  return (
    <TrendsReadsRail
      insights={insights}
      dismissedIds={dismissedIds}
      dismiss={dismiss}
      restoreAll={restoreAll}
      horizon={horizon}
    />
  );
}

function renderRail(matches: Match[], horizon: HorizonKey = 'last30') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <RailTestHarness matches={matches} horizon={horizon} />
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Only the rail's own wrapper divs — `UnlocksNext`/`InsightCard`'s own root ALSO repeats `data-card-kind` on itself, so an unscoped selector double-counts each card. */
const RAIL_CARD_SELECTOR = '[data-slot="insight-rail-card"]';

async function waitForSettled() {
  await waitFor(() =>
    expect(document.querySelector('[data-slot="trends-reads-rail"]')).toBeInTheDocument(),
  );
  await waitFor(() => expect(document.querySelector(RAIL_CARD_SELECTOR)).toBeInTheDocument());
}

describe('TrendsReadsRail', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    listMatches.mockResolvedValue([]);
    setMockUser(makeMockUser());
  });

  it('renders at most three cards for a normal account', async () => {
    const { container } = renderRail(sessionFatigueFixture());
    await waitForSettled();

    const cardKinds = [...container.querySelectorAll(RAIL_CARD_SELECTOR)];
    expect(cardKinds.length).toBeLessThanOrEqual(3);
  });

  it('renders exactly one unlock card for a thin account', async () => {
    const { container } = renderRail(thinFixture(), 'lastEvent');
    await waitForSettled();

    const unlocksNextCards = container.querySelectorAll(
      `${RAIL_CARD_SELECTOR}[data-card-kind="unlocks-next"]`,
    );
    const regularCards = container.querySelectorAll(
      `${RAIL_CARD_SELECTOR}[data-card-kind="regular"]`,
    );
    expect(unlocksNextCards.length).toBe(1);
    expect(regularCards.length).toBe(0);
  });

  it('renders the session-fatigue standing caveat whenever session fatigue renders', async () => {
    renderRail(sessionFatigueFixture());
    await waitForSettled();

    expect(
      screen.getByText(
        'Bracket depth also rises late in a session, so part of this gap is opponent strength.',
      ),
    ).toBeInTheDocument();
  });

  it('renders no session-fatigue caveat when session fatigue is hidden (fewer than 10 long sessions)', async () => {
    renderRail(thinFixture(), 'lastEvent');
    await waitForSettled();

    expect(
      screen.queryByText(
        'Bracket depth also rises late in a session, so part of this gap is opponent strength.',
      ),
    ).not.toBeInTheDocument();
  });

  it('carries the rating-model door on the rating-move card', async () => {
    renderRail(ratingCardFixture());
    await waitForSettled();

    expect(screen.getByRole('button', { name: 'Rating model note' })).toBeInTheDocument();
  });

  it("never renders zero cards when there are no matches at all (the engine's own degenerate fallback insight fills the rail)", async () => {
    const { container } = renderRail([]);
    await waitForSettled();

    const cardKinds = [...container.querySelectorAll(RAIL_CARD_SELECTOR)];
    expect(cardKinds.length).toBe(1);
    expect(cardKinds[0]?.getAttribute('data-card-kind')).toBe('regular');
  });

  describe('T-39.1-24 (gap closure, DD-09 reachability): counted-games door reaches the rating-move card, ratingModel note stays secondary', () => {
    it('renders a primary counted-games door followed by the rating-model note button, capped at 3', async () => {
      renderRail(ratingCardFixture());
      await waitForSettled();

      const card = document.querySelector(
        '[data-slot="insight-rail-card"][data-card-kind="regular"]',
      ) as HTMLElement;
      expect(card).not.toBeNull();

      const links = within(card).getAllByRole('link');
      expect(links.length).toBe(1);
      const href = links[0]!.getAttribute('href') ?? '';
      expect(href).toMatch(/claim=/);
      expect(href).toMatch(/#games$/);
      expect(links[0]!.textContent ?? '').toMatch(/see the \d+ games?/i);

      const ratingModelButton = within(card).getByRole('button', { name: 'Rating model note' });
      expect(ratingModelButton).toBeInTheDocument();

      // The games door precedes the rating-model button in DOM/tab order.
      const relation = links[0]!.compareDocumentPosition(ratingModelButton);
      expect(Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    });
  });

  describe('WR-C05 (39.1-REVIEW.md): locale-aware percent formatting in the evidence sentence', () => {
    afterEach(async () => {
      await i18n.changeLanguage('en');
    });

    it('renders the French percent convention (a space before the sign), never the English "NN%" glued form', async () => {
      await i18n.changeLanguage('fr');
      renderRail(sessionFatigueFixture());
      await waitForSettled();

      const evidence = [...document.querySelectorAll('[data-slot="insight-card-evidence"]')].map(
        (el) => el.textContent ?? '',
      );
      const withPercent = evidence.filter((text) => /%/.test(text));
      expect(withPercent.length).toBeGreaterThan(0);
      for (const text of withPercent) {
        expect(text).toMatch(/\d+\s%/);
        expect(text).not.toMatch(/\d+%/);
      }
    });
  });
});

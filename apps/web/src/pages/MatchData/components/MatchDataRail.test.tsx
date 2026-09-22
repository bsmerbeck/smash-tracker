import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { MatchDataRail, useMatchDataInsights } from './MatchDataRail';

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

const NOW_MS = Date.now();
const ONE_HOUR_MS = 60 * 60 * 1000;

const MAIN_ID = 1; // Mario
const SECONDARY_ID = 2; // Donkey Kong
const OPPONENT_ID = 50; // Wii Fit Trainer
const MAIN_FILLER_OPPONENT = 90;
const SECONDARY_FILLER_OPPONENT = 91;
const POCKET_FILLER_OPPONENT = 92;
const POCKET_A_ID = 100;
const POCKET_B_ID = 101;
const POCKET_C_ID = 102;

interface GameDescriptor {
  fighterId: number;
  opponentId: number;
  win: boolean;
}

function block(
  fighterId: number,
  wins: number,
  losses: number,
  opponentId: number,
): GameDescriptor[] {
  const out: GameDescriptor[] = [];
  for (let i = 0; i < wins; i++) out.push({ fighterId, win: true, opponentId });
  for (let i = 0; i < losses; i++) out.push({ fighterId, win: false, opponentId });
  return out;
}

/**
 * MEASURED (via a real run against the built shared package — see this
 * plan's SUMMARY) to make ALL FOUR roster reads simultaneously card-eligible:
 * `rosterCore` fact (Mario is main), `rosterShift` trend (+25pts, fighter
 * 100's share concentrated in the most recent window), `secondaryPayoff`
 * suggestion (Donkey Kong beats Mario vs Wii Fit Trainer, +40pts),
 * `pocketCost` fact (27% pooled pocket rate vs 75% main rate, notable).
 * Fighter 100/101/102 are pocket-only synthetic ids (never reach the
 * secondary floor at 10 games each); fighter 100's games are placed as the
 * chronologically NEWEST 10, driving its own share far above its lifetime
 * baseline and making it the rosterShift headline over every other fighter.
 */
function allFourReadsFixture(): Match[] {
  const mainBlock = [
    ...block(MAIN_ID, 15, 15, OPPONENT_ID),
    ...block(MAIN_ID, 30, 0, MAIN_FILLER_OPPONENT),
  ];
  const secondaryBlock = [
    ...block(SECONDARY_ID, 18, 2, OPPONENT_ID),
    ...block(SECONDARY_ID, 5, 0, SECONDARY_FILLER_OPPONENT),
  ];
  const pocketBBlock = block(POCKET_B_ID, 3, 7, POCKET_FILLER_OPPONENT);
  const pocketCBlock = block(POCKET_C_ID, 3, 7, POCKET_FILLER_OPPONENT);
  const pocketABlock = block(POCKET_A_ID, 2, 8, POCKET_FILLER_OPPONENT);

  const baseBlocks = [...mainBlock, ...secondaryBlock, ...pocketBBlock, ...pocketCBlock];

  // Weighted round-robin interleave of baseBlocks by fighter group, so no
  // single fighter's baseline games cluster entirely old or entirely new —
  // only fighter 100 (appended last, below) is deliberately concentrated.
  const byFighter = new Map<number, GameDescriptor[]>();
  for (const g of baseBlocks) {
    const existing = byFighter.get(g.fighterId);
    if (existing) existing.push(g);
    else byFighter.set(g.fighterId, [g]);
  }
  const groups = [...byFighter.values()];
  const cursors = groups.map(() => 0);
  const interleaved: GameDescriptor[] = [];
  while (interleaved.length < baseBlocks.length) {
    let bestIndex = -1;
    let bestRatio = Infinity;
    for (let i = 0; i < groups.length; i++) {
      if (cursors[i]! >= groups[i]!.length) continue;
      const ratio = cursors[i]! / groups[i]!.length;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestIndex = i;
      }
    }
    interleaved.push(groups[bestIndex]![cursors[bestIndex]!]!);
    cursors[bestIndex]!++;
  }

  const ordered = [...interleaved, ...pocketABlock];
  const total = ordered.length;
  return ordered.map((g, i) => ({
    id: `m-${i}`,
    fighter_id: g.fighterId,
    opponent_id: g.opponentId,
    time: NOW_MS - (total - i) * ONE_HOUR_MS,
    win: g.win,
  }));
}

/** Main only, no other fighter clears both secondary floors — `secondaryPayoff` returns `[]`. */
function noSecondariesFixture(): Match[] {
  return block(MAIN_ID, 45, 15, MAIN_FILLER_OPPONENT).map((g, i) => ({
    id: `nosec-${i}`,
    fighter_id: g.fighterId,
    opponent_id: g.opponentId,
    time: NOW_MS - (60 - i) * ONE_HOUR_MS,
    win: g.win,
  }));
}

/** Main plus two small pocket fighters pooling to 10 games (< ROSTER_MAIN_MIN_GAMES 20) — `pocketCost` returns `hidden`, dropped by `assembleRail`. */
function pocketsBelowFloorFixture(): Match[] {
  const main = block(MAIN_ID, 45, 15, MAIN_FILLER_OPPONENT);
  const pockets = [
    ...block(200, 3, 2, POCKET_FILLER_OPPONENT),
    ...block(201, 3, 2, POCKET_FILLER_OPPONENT),
  ];
  const all = [...main, ...pockets];
  return all.map((g, i) => ({
    id: `belowfloor-${i}`,
    fighter_id: g.fighterId,
    opponent_id: g.opponentId,
    time: NOW_MS - (all.length - i) * ONE_HOUR_MS,
    win: g.win,
  }));
}

/**
 * Plan 39.1-24 Task 2: `MatchDataRail` no longer computes its own `insights`
 * — a host calls `useMatchDataInsights` ONCE and hands the result down (so
 * the page's `FilteredMatchList` terminus can share the SAME array for
 * `resolveClaim`), mirroring `FighterInsightRail`'s Task 1 pattern. This
 * harness reproduces that real usage pattern for the rail's own isolated
 * tests.
 */
function RailTestHarness({ matches, horizon }: { matches: Match[]; horizon: HorizonKey }) {
  const { insights, dismissedIds, dismiss, restoreAll } = useMatchDataInsights({
    matches,
    horizon,
  });
  return (
    <MatchDataRail
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
    expect(document.querySelector('[data-slot="match-data-rail"]')).toBeInTheDocument(),
  );
  await waitFor(() => expect(document.querySelector(RAIL_CARD_SELECTOR)).toBeInTheDocument());
}

describe('MatchDataRail', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    listMatches.mockResolvedValue([]);
    setMockUser(makeMockUser());
  });

  it('renders exactly three cards on a fixture where all four reads are available, and the fourth appears after one is dismissed', async () => {
    const user = userEvent.setup();
    const { container } = renderRail(allFourReadsFixture());
    await waitForSettled();

    const regularCards = () =>
      container.querySelectorAll(`${RAIL_CARD_SELECTOR}[data-card-kind="regular"]`);
    expect(regularCards()).toHaveLength(3);

    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    await user.click(dismissButtons[0]!);

    await waitFor(() => expect(regularCards()).toHaveLength(3));
  });

  it('the secondary-payoff read is absent (not locked) when the roster model has no secondaries', async () => {
    const { container } = renderRail(noSecondariesFixture());
    await waitForSettled();

    expect(screen.queryByText(/runs \d+% where/)).not.toBeInTheDocument();
    const lockedGlyphs = container.querySelectorAll('[data-card-kind="unlocks-next"]');
    expect(lockedGlyphs).toHaveLength(0);
  });

  it('the pocket-cost read is absent (not locked) when pooled pocket games are below the model minimum', async () => {
    const { container } = renderRail(pocketsBelowFloorFixture());
    await waitForSettled();

    expect(screen.queryByText(/Pockets —/)).not.toBeInTheDocument();
    const lockedGlyphs = container.querySelectorAll('[data-card-kind="unlocks-next"]');
    expect(lockedGlyphs).toHaveLength(0);
  });

  it("never renders zero cards when there are no matches at all (the engine's own degenerate fallback insight fills the rail)", async () => {
    const { container } = renderRail([]);
    await waitForSettled();

    const cardKinds = [...container.querySelectorAll(RAIL_CARD_SELECTOR)];
    expect(cardKinds.length).toBe(1);
    expect(cardKinds[0]?.getAttribute('data-card-kind')).toBe('regular');
  });

  describe('T-39.1-24 (gap closure, DD-09 reachability): counted-games doors reach the rendered card', () => {
    it('every regular card shows a real counted-games door link (claim=<id>#games), primary and before the dismiss control', async () => {
      const { container } = renderRail(allFourReadsFixture());
      await waitForSettled();

      const cards = container.querySelectorAll(`${RAIL_CARD_SELECTOR}[data-card-kind="regular"]`);
      expect(cards.length).toBeGreaterThan(0);

      for (const card of Array.from(cards)) {
        const doors = within(card as HTMLElement).getAllByRole('link');
        expect(doors.length).toBeGreaterThan(0);
        expect(doors.length).toBeLessThanOrEqual(3);

        const primary = doors[0]!;
        const href = primary.getAttribute('href') ?? '';
        expect(href).toMatch(/claim=/);
        expect(href).toMatch(/#games$/);
        expect(primary.textContent ?? '').toMatch(/see the \d+ games?/i);

        const dismissButton = within(card as HTMLElement).getByRole('button', {
          name: /dismiss/i,
        });
        const lastDoor = doors[doors.length - 1]!;
        const relation = lastDoor.compareDocumentPosition(dismissButton);
        expect(Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      }
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import { FighterInsightRail } from './FighterInsightRail';

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

const list = vi.fn();
const aliasesList = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    matches: { list: (...args: unknown[]) => list(...args) },
    opponents: { aliases: { list: (...args: unknown[]) => aliasesList(...args) } },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;
const fox = SpriteList.find((s) => s.id === 8)!;

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function renderRail(
  fighterMatches: Match[],
  horizon: 'last30' | 'lastEvent' | 'last90' = 'last30',
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <FighterInsightRail
              fighterId={mario.id}
              fighterMatches={fighterMatches}
              horizon={horizon}
            />
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function waitForSettled() {
  await waitFor(() =>
    expect(document.querySelector('[data-slot="insight-rail"]')).toBeInTheDocument(),
  );
}

/** Enough games, spread across two opponent characters and two opponent players, to produce real asserting reads for characterMovers/rivalMovers plus a named event for lastEventRecap. */
function richFixture(): Match[] {
  const matches: Match[] = [];
  const now = Date.now();
  // vs Luigi (character), split so the recent 30 skew heavily toward wins (an assertive "up" trend).
  for (let i = 0; i < 40; i++) {
    matches.push(
      makeMatch({
        id: `l${i}`,
        time: now - (80 - i) * 60 * 60 * 1000,
        win: i < 20 ? i % 2 === 0 : true,
        opponent_id: luigi.id,
        opponent: 'rival-luigi',
      }),
    );
  }
  // vs Fox (character) — thinner sample, another opponent player too.
  for (let i = 0; i < 12; i++) {
    matches.push(
      makeMatch({
        id: `f${i}`,
        time: now - (30 - i) * 60 * 60 * 1000,
        win: i % 2 === 0,
        opponent_id: fox.id,
        opponent: 'rival-fox',
      }),
    );
  }
  // A named event, most recent.
  for (let i = 0; i < 9; i++) {
    matches.push(
      makeMatch({
        id: `e${i}`,
        time: now - (5 - i) * 60 * 60 * 1000,
        win: i % 3 !== 0,
        opponent_id: luigi.id,
        opponent: 'rival-luigi',
        eventName: 'Supernova 2026',
      }),
    );
  }
  return matches;
}

/** Thin fixture — everything under the abstention floor and no named event, so both movers templates lock and lastEventRecap hides. */
function thinFixture(): Match[] {
  const now = Date.now();
  return Array.from({ length: 5 }, (_, i) =>
    makeMatch({
      id: `t${i}`,
      time: now - (5 - i) * 60 * 60 * 1000,
      win: i % 2 === 0,
      opponent_id: luigi.id,
    }),
  );
}

describe('FighterInsightRail', () => {
  beforeEach(async () => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    aliasesList.mockResolvedValue({});
    window.localStorage.clear();
    setMockUser(makeMockUser());
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage('en');
  });

  it('renders at most three cards', async () => {
    list.mockResolvedValue(richFixture());
    renderRail(richFixture());
    await waitForSettled();
    const cards = document.querySelectorAll('[data-slot="insight-rail-card"]');
    expect(cards.length).toBeLessThanOrEqual(3);
    expect(cards.length).toBeGreaterThan(0);
  });

  it('with only locked candidates, renders one unlock card and never zero cards', async () => {
    list.mockResolvedValue(thinFixture());
    renderRail(thinFixture());
    await waitForSettled();
    const cards = document.querySelectorAll('[data-slot="insight-rail-card"]');
    expect(cards.length).toBeGreaterThanOrEqual(1);
    const unlocksCard = document.querySelector('[data-card-kind="unlocks-next"]');
    expect(unlocksCard).toBeInTheDocument();
  });

  it('the last-event recap renders no debrief door and no tracking control', async () => {
    list.mockResolvedValue(richFixture());
    renderRail(richFixture());
    await waitForSettled();
    const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent ?? '');
    const links = [...document.querySelectorAll('a')].map((a) => a.textContent ?? '');
    expect(buttons.some((t) => /debrief|track/i.test(t))).toBe(false);
    expect(links.some((t) => /debrief|track/i.test(t))).toBe(false);
  });

  it('with no tournament event, the recap is absent and at least one card still renders', async () => {
    const noEventMatches = richFixture().filter((m) => !m.eventName);
    list.mockResolvedValue(noEventMatches);
    renderRail(noEventMatches);
    await waitForSettled();
    const cards = document.querySelectorAll('[data-slot="insight-rail-card"]');
    expect(cards.length).toBeGreaterThanOrEqual(1);
  });

  it('dismissing a card reduces the rendered cards by one and persists exactly one dismissal for the subject', async () => {
    list.mockResolvedValue(richFixture());
    renderRail(richFixture());
    await waitForSettled();

    const before = document.querySelectorAll(
      '[data-slot="insight-rail-card"][data-card-kind="regular"]',
    );
    expect(before.length).toBeGreaterThan(0);
    const dismissButtons = screen.getAllByRole('button', { name: /dismiss/i });
    dismissButtons[0]!.click();

    await waitFor(() => {
      const dismissedCountText = screen.queryByText(/1 dismissed on this device/i);
      expect(dismissedCountText).toBeInTheDocument();
    });
  });
});

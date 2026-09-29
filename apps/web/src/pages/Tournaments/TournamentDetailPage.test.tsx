import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { EVENT_ANCHOR_PROXIMITY_MS } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { TournamentDetailPage } from './TournamentDetailPage';
import { StageDetailPage } from '@/pages/Stages/StageDetailPage';
import { SpriteList } from '@/data/sprites';
import { usePrepBrief } from '@/hooks/usePrepBrief';
import { derivePrepSurfaceMode } from '@/lib/prepSurfaceMode';

vi.mock('@/hooks/usePrepBrief', () => ({
  usePrepBrief: vi.fn(),
}));

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
const listTournaments = vi.fn();
const setTierOverride = vi.fn();
const createVodShare = vi.fn();
const getMe = vi.fn();
const listAliases = vi.fn();

/** Phase 30.3 (Gate 6): the always-present `GET /api/users/me` profile shape. */
function defaultProfile(overrides: { isDemoAccount?: boolean } = {}) {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: null,
    ...overrides,
  };
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      // Plan 39.2-10: every Track host reads the subject's watchlist.
      watchlist: {
        list: vi.fn().mockResolvedValue({ items: [] }),
        track: vi.fn(),
        untrack: vi.fn(),
      },
      users: {
        getMe: (...args: unknown[]) => getMe(...args),
      },
      matches: {
        list: (...args: unknown[]) => listMatches(...args),
      },
      tournaments: {
        list: (...args: unknown[]) => listTournaments(...args),
        setTierOverride: (...args: unknown[]) => setTierOverride(...args),
      },
      vodShares: {
        create: (...args: unknown[]) => createVodShare(...args),
      },
      opponents: {
        aliases: {
          list: (...args: unknown[]) => listAliases(...args),
        },
      },
    },
  };
});

const mockUsePrepBrief = vi.mocked(usePrepBrief);

/** Convenience wrapper matching `usePrepBrief`'s consumed shape (`isPending`/`isError`/`data.activated`). */
function mockPrepBrief(state: {
  isPending: boolean;
  isError?: boolean;
  activated?: boolean;
  reviewAt?: number;
}) {
  mockUsePrepBrief.mockReturnValue({
    isPending: state.isPending,
    isError: Boolean(state.isError),
    data:
      state.isPending || state.isError
        ? undefined
        : {
            activated: Boolean(state.activated),
            ...(state.reviewAt !== undefined ? { reviewAt: state.reviewAt } : {}),
          },
  } as unknown as ReturnType<typeof usePrepBrief>);
}

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  const eventId = overrides.eventId ?? 42;
  return {
    eventId,
    eventName: 'Ultimate Singles',
    firstSetAt: Date.UTC(2021, 0, 1),
    lastSetAt: Date.UTC(2021, 0, 1, 6),
    setsPlayed: 1,
    // Phase 7: GET /api/tournaments always fills entryKey from the RTDB
    // child key on read — defaulted here to match the numeric eventId so
    // existing fixtures keep routing the same way without every call site
    // needing to pass one explicitly.
    entryKey: String(eventId),
    ...overrides,
  };
}

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    eventName: 'Ultimate Singles',
    source: 'startgg',
    ...overrides,
  };
}

function renderPage(eventId = '42') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/tournaments/${eventId}`]}>
        <AuthProvider>
          <TooltipProvider>
            <Routes>
              <Route path="/tournaments/:eventId" element={<TournamentDetailPage />} />
              <Route path="/trends" element={<div>Trends page</div>} />
            </Routes>
          </TooltipProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * CR-03 (38-REVIEW-FIX): the real cross-page chain the pre-fix bug broke —
 * `TournamentDetailPage` mounted alongside the REAL `StageDetailPage` (not a
 * stub), so a "Stages Played" row's destination is exercised end-to-end
 * rather than only asserting the raw `href` string. Needs
 * `AnalyticsFilterProvider` (`StageDetailPage` reads `useFilteredMatches`)
 * on top of `renderPage`'s harness.
 */
function renderTournamentAndStagePages(eventId = '42') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/tournaments/${eventId}`]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/tournaments/:eventId" element={<TournamentDetailPage />} />
                <Route path="/stages/:stageId" element={<StageDetailPage />} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TournamentDetailPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    getMe.mockResolvedValue(defaultProfile());
    listAliases.mockResolvedValue({});
    // Default: resolved, no brief — individual prep-CTA tests override this.
    mockPrepBrief({ isPending: false, activated: false });
  });

  it('shows a friendly not-found state for an unknown eventId', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
    listMatches.mockResolvedValue([]);

    renderPage('999');

    expect(await screen.findByText('Tournament not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Trends' })).toHaveAttribute('href', '/trends');
  });

  it('renders the header, set timeline, characters/stages, and retrospective for a known entry', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: 42,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        numEntrants: 512,
        seed: 408,
        placement: 257,
      }),
    ]);
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'g1',
        time: Date.UTC(2021, 0, 1, 1),
        win: true,
        externalId: 'sgg:100:g1',
        roundText: 'Winners Round 1',
        tournamentName: 'The Big House 9',
      }),
      makeMatch({
        id: 'g2',
        time: Date.UTC(2021, 0, 1, 1, 5),
        win: true,
        externalId: 'sgg:100:g2',
        roundText: 'Winners Round 1',
        tournamentName: 'The Big House 9',
      }),
    ]);

    renderPage('42');

    // Header: tournament name, seed->placement badge.
    expect(await screen.findByText('The Big House 9')).toBeInTheDocument();
    expect(screen.getByText('Outperformed seed: 408 → 257')).toBeInTheDocument();
    expect(screen.getByText('512 entrants')).toBeInTheDocument();

    // Event Results: resync hint when topStandings hasn't synced.
    expect(screen.getByText('Event Results')).toBeInTheDocument();
    expect(screen.getByText('Full results attach on your next start.gg sync.')).toBeInTheDocument();

    // Set timeline: the single set's round label and result.
    expect(screen.getByText('Set Timeline')).toBeInTheDocument();
    expect(screen.getAllByText('Winners Round 1').length).toBeGreaterThan(0);

    // Characters & stages summary cards.
    expect(screen.getByText('Your Characters')).toBeInTheDocument();
    expect(screen.getByText(/Opponents/)).toBeInTheDocument();
    expect(screen.getByText('Stages Played')).toBeInTheDocument();

    // Advisor Retrospective renders (all-no-data since there's no pre-tournament history).
    expect(screen.getByText('Advisor Retrospective')).toBeInTheDocument();
    expect(
      screen.getByText('Not enough pre-tournament data to grade these picks.'),
    ).toBeInTheDocument();
  });

  it('omits the seed/placement badge cleanly when absent', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({ eventId: 42, seed: undefined, placement: undefined }),
    ]);
    listMatches.mockResolvedValue([]);

    renderPage('42');

    await screen.findByText('Set Timeline');
    expect(screen.queryByText(/Outperformed seed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Underperformed seed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Matched seed/)).not.toBeInTheDocument();
  });

  describe('tier badge and provenance line (TIER-02, T-05, DD-02, DD-03)', () => {
    it('shows an OUTLINED estimated Supermajor and its provenance sentence for an offline 1,581-entrant entry', async () => {
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 42,
          tournamentName: 'Supernova 2026',
          numEntrants: 1581,
          isOnline: false,
        }),
      ]);
      listMatches.mockResolvedValue([]);

      renderPage('42');

      await screen.findByText('Set Timeline');
      const block = document.querySelector('[data-slot="tournament-tier"]') as HTMLElement;
      expect(block).not.toBeNull();
      const badge = block.querySelector('[data-slot="tier-badge"]') as HTMLElement;
      expect(badge).toHaveTextContent('Supermajor');
      expect(badge).toHaveAttribute('data-tier', 'supermajor');
      expect(badge).toHaveAttribute('data-basis', 'estimated');
      expect(badge).toHaveAttribute('data-variant', 'outline');
      expect(within(block).getByText('Estimated from 1,581 entrants')).toBeInTheDocument();
      // An offline main event shows neither the setting nor the kind badge (DD-03).
      expect(within(block).queryByText('Online')).not.toBeInTheDocument();
      expect(within(block).queryByText('Side event')).not.toBeInTheDocument();
    });

    it('shows "Tier unknown" with the Online badge and its reason for an online entry, never an estimate', async () => {
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 42,
          tournamentName: 'Online Weekly',
          numEntrants: 5605,
          isOnline: true,
        }),
      ]);
      listMatches.mockResolvedValue([]);

      renderPage('42');

      await screen.findByText('Set Timeline');
      const block = document.querySelector('[data-slot="tournament-tier"]') as HTMLElement;
      const badge = block.querySelector('[data-slot="tier-badge"]') as HTMLElement;
      expect(badge).toHaveTextContent('Tier unknown');
      expect(badge).toHaveAttribute('data-basis', 'unknown');
      expect(badge).toHaveAttribute('data-variant', 'outline');
      expect(badge.querySelector('[data-slot="tier-glyph"]')).toBeNull();
      expect(within(block).getByText('Online')).toBeInTheDocument();
      expect(within(block).getByText("Online events aren't estimated")).toBeInTheDocument();
    });

    it('shows a solid manual badge naming its source when an override is stored', async () => {
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 42,
          numEntrants: 412,
          isOnline: false,
          tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 1 },
        }),
      ]);
      listMatches.mockResolvedValue([]);

      renderPage('42');

      await screen.findByText('Set Timeline');
      const block = document.querySelector('[data-slot="tournament-tier"]') as HTMLElement;
      const badge = block.querySelector('[data-slot="tier-badge"]') as HTMLElement;
      expect(badge).toHaveAttribute('data-tier', 'major');
      expect(badge).toHaveAttribute('data-basis', 'manual');
      expect(badge).toHaveAttribute('data-variant', 'secondary');
      expect(within(block).getByText('Set manually')).toBeInTheDocument();
    });

    it('mounts the tier override card beside the ruleset card, for an admin-imported entry too', async () => {
      listTournaments.mockResolvedValue([
        makeEntry({
          eventId: 42,
          origin: 'admin-imported',
          provider: 'startgg',
        } as Partial<TournamentEntry>),
      ]);
      listMatches.mockResolvedValue([]);

      renderPage('42');

      await screen.findByText('Set Timeline');
      const tierCard = document.querySelector('[data-slot="tier-override"]') as HTMLElement;
      expect(tierCard).not.toBeNull();
      expect(within(tierCard).getByText('Tier for this event')).toBeInTheDocument();
      expect(screen.getByText('Ruleset for this event')).toBeInTheDocument();
      // One grid row holds both cards (UI-SPEC §8.2), tier card first.
      expect(tierCard.closest('[data-slot="page-grid"]')).toBe(
        screen.getByText('Ruleset for this event').closest('[data-slot="page-grid"]'),
      );
    });

    it('saving an override PATCHes the entry, refetches the registry, and the header turns into a solid manual badge', async () => {
      const user = userEvent.setup();
      const base = makeEntry({ eventId: 42, numEntrants: 412, isOnline: false });
      listTournaments
        .mockResolvedValueOnce([base])
        .mockResolvedValue([
          { ...base, tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 5 } },
        ]);
      setTierOverride.mockResolvedValue({
        entryKey: '42',
        tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 5 },
      });
      listMatches.mockResolvedValue([]);

      renderPage('42');

      await screen.findByText('Set Timeline');
      const header = document.querySelector(
        '[data-slot="tournament-tier"] [data-slot="tier-badge"]',
      );
      expect(header).toHaveAttribute('data-variant', 'outline');

      await user.click(screen.getByRole('combobox', { name: 'Override tier' }));
      await user.click(await screen.findByRole('option', { name: 'Major' }));

      await waitFor(() => expect(setTierOverride).toHaveBeenCalledWith('42', { tier: 'major' }));
      await waitFor(() => {
        const badge = document.querySelector(
          '[data-slot="tournament-tier"] [data-slot="tier-badge"]',
        );
        expect(badge).toHaveAttribute('data-basis', 'manual');
        expect(badge).toHaveAttribute('data-variant', 'secondary');
      });
      expect(listTournaments).toHaveBeenCalledTimes(2);
    });

    it('states an unknown setting on the provenance line and labels a side event', async () => {
      listTournaments.mockResolvedValue([
        makeEntry({ eventId: 42, eventName: 'Squad Strike', numEntrants: 100 }),
      ]);
      listMatches.mockResolvedValue([]);

      renderPage('42');

      await screen.findByText('Set Timeline');
      const block = document.querySelector('[data-slot="tournament-tier"]') as HTMLElement;
      expect(within(block).getByText('Side event')).toBeInTheDocument();
      expect(within(block).getByText("Side events don't inherit a tier")).toBeInTheDocument();
    });
  });

  it('renders Event Results with a winner callout and start.gg deep link when synced', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: 42,
        slug: 'tournament/the-box-juice-box-26',
        eventSlug: 'tournament/the-box-juice-box-26/event/ultimate-singles',
        topStandings: [
          { placement: 1, name: 'Champ', gamerTag: 'Champ' },
          { placement: 2, name: 'RunnerUp', gamerTag: 'RunnerUp' },
        ],
      }),
    ]);
    listMatches.mockResolvedValue([]);

    renderPage('42');

    await screen.findByText('Event Results');
    expect(screen.getByText('Champ won this event')).toBeInTheDocument();
    expect(screen.getByText('RunnerUp')).toBeInTheDocument();

    const startggLink = screen.getByRole('link', { name: /View on start\.gg/ });
    expect(startggLink).toHaveAttribute(
      'href',
      'https://start.gg/tournament/the-box-juice-box-26/event/ultimate-singles',
    );
  });

  it('renders a parry.gg entry gracefully — no numeric eventId, no start.gg links', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: undefined,
        entryKey: 'pgg-the-big-house-9',
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        source: 'parrygg',
        slug: undefined,
        eventSlug: undefined,
        topStandings: undefined,
      }),
    ]);
    listMatches.mockResolvedValue([]);

    renderPage('pgg-the-big-house-9');

    expect(await screen.findByText('The Big House 9')).toBeInTheDocument();
    // Event Results falls back to the resync hint since topStandings never
    // synced for a parry.gg entry — no crash, no start.gg-only affordance.
    expect(screen.getByText('Full results attach on your next start.gg sync.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View on start\.gg/ })).not.toBeInTheDocument();
  });

  it('shows the Generate recap action for a synced entry and opens the dialog', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 42, setsPlayed: 3 })]);
    listMatches.mockResolvedValue([]);
    const user = userEvent.setup();

    renderPage('42');

    const generateButton = await screen.findByRole('button', { name: 'Generate recap' });
    await user.click(generateButton);

    expect(await screen.findByText('Generate a recap card')).toBeInTheDocument();
  });

  it('omits the Generate recap action when the entry has no completed sets', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 42, setsPlayed: 0 })]);
    listMatches.mockResolvedValue([]);

    renderPage('42');

    await screen.findByText('Set Timeline');
    expect(screen.queryByRole('button', { name: 'Generate recap' })).not.toBeInTheDocument();
  });

  it('generating a recap posts kind recap + entryKey and shows a copyable link', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 42, entryKey: '42', setsPlayed: 3 })]);
    listMatches.mockResolvedValue([]);
    createVodShare.mockResolvedValue({
      shareId: 'share-1',
      token: 'tok',
      url: 'https://grandfinals.gg/s/tok',
    });
    const user = userEvent.setup();

    renderPage('42');

    await user.click(await screen.findByRole('button', { name: 'Generate recap' }));
    await user.click(await screen.findByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(createVodShare).toHaveBeenCalledTimes(1));
    expect(createVodShare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'recap', entryKey: '42' }),
    );

    expect(await screen.findByText('Recap link ready')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://grandfinals.gg/s/tok')).toBeInTheDocument();
  });

  // Phase 30.3 (Gate 6, owner/Codex hard gate): recap creation disabled for
  // a demo/research account, with a positive control.
  it('disables Generate recap with an explanation for a demo account', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 42, setsPlayed: 3 })]);
    listMatches.mockResolvedValue([]);
    getMe.mockResolvedValue(defaultProfile({ isDemoAccount: true }));

    renderPage('42');

    const generateButton = await screen.findByRole('button', { name: 'Generate recap' });
    expect(generateButton).toBeDisabled();
    expect(generateButton).toHaveAttribute('title', 'Disabled for public-data research accounts.');
  });

  it('positive control: keeps Generate recap enabled for an ordinary account', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventId: 42, setsPlayed: 3 })]);
    listMatches.mockResolvedValue([]);
    getMe.mockResolvedValue(defaultProfile({ isDemoAccount: false }));

    renderPage('42');

    expect(await screen.findByRole('button', { name: 'Generate recap' })).toBeEnabled();
  });

  describe('prep brief CTA', () => {
    it('renders Start prep brief for an upcoming entry with no existing brief', async () => {
      const futureEntry = makeEntry({ eventId: 42, firstSetAt: Date.now() + 86_400_000 });
      listTournaments.mockResolvedValue([futureEntry]);
      listMatches.mockResolvedValue([]);
      mockPrepBrief({ isPending: false, activated: false });

      renderPage('42');

      const cta = await screen.findByTestId('tournament-prep-cta');
      expect(cta).toHaveTextContent('Start prep brief');
      expect(cta).toHaveAttribute('href', `/tournaments/${futureEntry.entryKey}/prep`);
    });

    it('renders Open prep brief once a brief is activated', async () => {
      listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
      listMatches.mockResolvedValue([]);
      mockPrepBrief({ isPending: false, activated: true });

      renderPage('42');

      expect(await screen.findByTestId('tournament-prep-cta')).toHaveTextContent('Open prep brief');
    });

    it('keeps Open prep brief reachable for a past-dated entry with an activated brief (D-03)', async () => {
      // makeEntry defaults firstSetAt to a 2021 date — already in the past.
      listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
      listMatches.mockResolvedValue([]);
      mockPrepBrief({ isPending: false, activated: true });

      renderPage('42');

      expect(await screen.findByTestId('tournament-prep-cta')).toHaveTextContent('Open prep brief');
    });

    it('shows no prep action for a past-dated entry with no existing brief', async () => {
      listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
      listMatches.mockResolvedValue([]);
      mockPrepBrief({ isPending: false, activated: false });

      renderPage('42');

      await screen.findByText('Set Timeline');
      expect(screen.queryByTestId('tournament-prep-cta')).not.toBeInTheDocument();
    });

    it('shows no prep action while the prep query is still pending', async () => {
      listTournaments.mockResolvedValue([
        makeEntry({ eventId: 42, firstSetAt: Date.now() + 86_400_000 }),
      ]);
      listMatches.mockResolvedValue([]);
      mockPrepBrief({ isPending: true });

      renderPage('42');

      await screen.findByText('Set Timeline');
      expect(screen.queryByTestId('tournament-prep-cta')).not.toBeInTheDocument();
    });

    it('shows no prep action while the prep query has errored (WR-02, 260725-juj unknown-is-not-zero)', async () => {
      listTournaments.mockResolvedValue([
        makeEntry({ eventId: 42, firstSetAt: Date.now() + 86_400_000 }),
      ]);
      listMatches.mockResolvedValue([]);
      mockPrepBrief({ isPending: false, isError: true });

      renderPage('42');

      await screen.findByText('Set Timeline');
      expect(screen.queryByTestId('tournament-prep-cta')).not.toBeInTheDocument();
    });

    it('renders both the prep CTA and the recap button when both are eligible', async () => {
      listTournaments.mockResolvedValue([makeEntry({ eventId: 42, setsPlayed: 3 })]);
      listMatches.mockResolvedValue([]);
      mockPrepBrief({ isPending: false, activated: true });

      renderPage('42');

      expect(await screen.findByTestId('tournament-prep-cta')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Generate recap' })).toBeInTheDocument();
    });

    // Plan 39-12 (PREP-05, D-13, review C1-H6): `debrief` refines `reopen` —
    // both need an activated brief; only the SERVER's reviewAt separates
    // them, through the destination page's own derivePrepSurfaceMode.
    describe('debrief state (plan 39-12)', () => {
      const HOUR_MS = 60 * 60 * 1000;

      it('shows Debrief this event for an ACTIVATED entry whose server reviewAt has passed, linking to the prep page', async () => {
        const entry = makeEntry({ eventId: 42 });
        listTournaments.mockResolvedValue([entry]);
        listMatches.mockResolvedValue([]);
        mockPrepBrief({ isPending: false, activated: true, reviewAt: Date.now() - HOUR_MS });

        renderPage('42');

        const cta = await screen.findByTestId('tournament-prep-cta');
        expect(cta).toHaveTextContent('Debrief this event');
        expect(cta).toHaveAttribute('href', `/tournaments/${entry.entryKey}/prep`);
      });

      it('the debrief-qualifying status resolves to review on the destination (derivePrepSurfaceMode), so the CTA cannot land on prep', () => {
        expect(derivePrepSurfaceMode({ activated: true, reviewAt: Date.now() - HOUR_MS })).toBe(
          'review',
        );
        // The rejected pre-review condition (not activated, event passed) never resolves to review.
        expect(derivePrepSurfaceMode({ activated: false, reviewAt: Date.now() - HOUR_MS })).toBe(
          'prep',
        );
      });

      it.each([
        ['absent', undefined],
        ['still in the future', Date.now() + 24 * HOUR_MS],
      ])(
        'shows Open prep brief (reopen) for an activated entry whose reviewAt is %s',
        async (_label, reviewAt) => {
          listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
          listMatches.mockResolvedValue([]);
          mockPrepBrief({ isPending: false, activated: true, reviewAt });

          renderPage('42');

          expect(await screen.findByTestId('tournament-prep-cta')).toHaveTextContent(
            'Open prep brief',
          );
        },
      );

      it('a NOT-activated past entry with a passed reviewAt shows no debrief CTA (it could never land in review)', async () => {
        listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
        listMatches.mockResolvedValue([]);
        mockPrepBrief({ isPending: false, activated: false, reviewAt: Date.now() - HOUR_MS });

        renderPage('42');

        await screen.findByText('Set Timeline');
        expect(screen.queryByTestId('tournament-prep-cta')).not.toBeInTheDocument();
      });

      it('an imported entry with a debrief-qualifying status still renders no CTA (the origin guard comes first)', async () => {
        listTournaments.mockResolvedValue([
          makeEntry({ eventId: 42, origin: 'admin-imported' } as Partial<TournamentEntry>),
        ]);
        listMatches.mockResolvedValue([]);
        mockPrepBrief({ isPending: false, activated: true, reviewAt: Date.now() - HOUR_MS });

        renderPage('42');

        await screen.findByText('Set Timeline');
        expect(screen.queryByTestId('tournament-prep-cta')).not.toBeInTheDocument();
      });

      it('a pending brief query still renders no CTA', async () => {
        listTournaments.mockResolvedValue([makeEntry({ eventId: 42 })]);
        listMatches.mockResolvedValue([]);
        mockPrepBrief({ isPending: true });

        renderPage('42');

        await screen.findByText('Set Timeline');
        expect(screen.queryByTestId('tournament-prep-cta')).not.toBeInTheDocument();
      });

      it('start, reopen and debrief render the SAME button element — label only differs', async () => {
        const shapes: { tag: string; className: string; href: string | null; text: string }[] = [];
        const cases = [
          { entry: { firstSetAt: Date.now() + 24 * HOUR_MS }, brief: { activated: false } },
          { entry: {}, brief: { activated: true } },
          { entry: {}, brief: { activated: true, reviewAt: Date.now() - HOUR_MS } },
        ];
        for (const { entry, brief } of cases) {
          listTournaments.mockResolvedValue([makeEntry({ eventId: 42, ...entry })]);
          listMatches.mockResolvedValue([]);
          mockPrepBrief({ isPending: false, ...brief });
          const view = renderPage('42');
          const cta = await screen.findByTestId('tournament-prep-cta');
          shapes.push({
            tag: cta.tagName,
            className: cta.className,
            href: cta.getAttribute('href'),
            text: cta.textContent ?? '',
          });
          view.unmount();
        }

        expect(shapes.map((shape) => shape.text)).toEqual([
          'Start prep brief',
          'Open prep brief',
          'Debrief this event',
        ]);
        for (const shape of shapes.slice(1)) {
          expect(shape.tag).toBe(shapes[0]!.tag);
          expect(shape.className).toBe(shapes[0]!.className);
          expect(shape.href).toBe(shapes[0]!.href);
        }
      });
    });
  });

  /** Phase 30.3 (Gate 4): admin-imported historical snapshots. */
  describe('admin-imported historical entries', () => {
    function makeImportedEntry(overrides: Record<string, unknown> = {}): TournamentEntry {
      return makeEntry({
        origin: 'admin-imported',
        provider: 'startgg',
        ...overrides,
      } as Partial<TournamentEntry>);
    }

    it('renders the imported snapshot notice with source and freshness', async () => {
      listTournaments.mockResolvedValue([
        makeImportedEntry({
          provenance: {
            source: 'research-import',
            importedAtMs: Date.UTC(2026, 7, 1, 12),
            asOfMs: Date.UTC(2026, 6, 15, 12),
          },
        }),
      ]);
      listMatches.mockResolvedValue([]);

      renderPage('42');

      expect(await screen.findByTestId('imported-snapshot-notice')).toBeInTheDocument();
      expect(screen.getByText('Imported event snapshot')).toBeInTheDocument();
      expect(screen.getByText(/Source: start\.gg \(public data\)/)).toBeInTheDocument();
      expect(screen.getByText(/Data as of Jul 15, 2026/)).toBeInTheDocument();
    });

    it('NEVER shows the prep CTA for an imported entry, even future-dated with a startable brief', async () => {
      // Under the non-imported rules this exact setup renders "Start prep
      // brief" (see the prep brief CTA describe above) — the owner directive
      // says imported events must never surface registration/seeded/live
      // prep controls, so the origin discriminator must win over the dates.
      listTournaments.mockResolvedValue([
        makeImportedEntry({ firstSetAt: Date.now() + 86_400_000 }),
      ]);
      listMatches.mockResolvedValue([]);
      mockPrepBrief({ isPending: false, activated: false });

      renderPage('42');

      await screen.findByText('Set Timeline');
      expect(screen.queryByTestId('tournament-prep-cta')).not.toBeInTheDocument();
    });

    it('suppresses even the reopen CTA for an imported entry with an activated brief', async () => {
      listTournaments.mockResolvedValue([makeImportedEntry()]);
      listMatches.mockResolvedValue([]);
      mockPrepBrief({ isPending: false, activated: true });

      renderPage('42');

      await screen.findByText('Set Timeline');
      expect(screen.queryByTestId('tournament-prep-cta')).not.toBeInTheDocument();
    });

    it("says standings weren't recorded instead of promising a future sync", async () => {
      listTournaments.mockResolvedValue([makeImportedEntry({ topStandings: undefined })]);
      listMatches.mockResolvedValue([]);

      renderPage('42');

      await screen.findByText('Event Results');
      expect(
        screen.getByText("Top standings weren't recorded in this import."),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Full results attach on your next start.gg sync.'),
      ).not.toBeInTheDocument();
    });

    it('keeps the Generate recap action — a recap is not a prep control', async () => {
      listTournaments.mockResolvedValue([makeImportedEntry({ setsPlayed: 3 })]);
      listMatches.mockResolvedValue([]);

      renderPage('42');

      expect(await screen.findByRole('button', { name: 'Generate recap' })).toBeInTheDocument();
    });
  });
});

/**
 * CR-03 (38-REVIEW-FIX): the actual TournamentDetailPage -> CharactersAndStages
 * -> StageDetailPage chain, rendered end-to-end (real StageDetailPage, not a
 * stub) — pre-fix, `entry.entryKey` (a foreign registry key, unrelated to
 * `eventSeries.ts`'s anchor-key format) was passed as the `event=` param, so
 * `StageDetailPage`'s anchor lookup always missed and the destination always
 * rendered its "nothing recorded" empty state, for every real tournament
 * entry, every time.
 */
describe('TournamentDetailPage -> StageDetailPage stage-row drill-down (CR-03)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    getMe.mockResolvedValue(defaultProfile());
    listAliases.mockResolvedValue({});
    mockPrepBrief({ isPending: false, activated: false });
  });

  it('a "Stages Played" row lands on a StageDetailPage that shows this event\'s games, not the empty state', async () => {
    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: 42,
        eventName: 'Ultimate Singles',
        firstSetAt: Date.UTC(2021, 0, 1),
        lastSetAt: Date.UTC(2021, 0, 1, 6),
      }),
    ]);
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'g1',
        time: Date.UTC(2021, 0, 1, 1),
        win: true,
        externalId: 'sgg:100:g1',
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'g2',
        time: Date.UTC(2021, 0, 1, 1, 5),
        win: false,
        externalId: 'sgg:100:g2',
        map: { id: 1, name: 'Battlefield' },
      }),
      makeMatch({
        id: 'g3',
        time: Date.UTC(2021, 0, 1, 1, 10),
        win: true,
        externalId: 'sgg:100:g3',
        map: { id: 1, name: 'Battlefield' },
      }),
    ]);

    const user = userEvent.setup();
    renderTournamentAndStagePages('42');

    await screen.findByText('Stages Played');
    const stageLink = screen.getByRole('link', {
      name: 'Battlefield — Stages Played, opens details',
    });
    // Pre-fix this was `/stages/1?event=42` (the raw entryKey) — a key
    // StageDetailPage's own event series never produces.
    expect(stageLink.getAttribute('href')).toMatch(/^\/stages\/1\?event=/);
    expect(stageLink.getAttribute('href')).not.toContain('event=42');

    await user.click(stageLink);

    // The empty state never renders, AND the by-opponent table shows this
    // opponent's real record from the three fixture games above.
    expect(screen.queryByText('No games recorded on this stage yet.')).not.toBeInTheDocument();
    expect(await screen.findByText('By Opponent')).toBeInTheDocument();
    // Plan 39.1-39: stage-detail rows are DrillableRows (shared accessible name).
    const rivalLink = screen.getByRole('link', { name: 'rival — By Opponent, opens details' });
    expect(rivalLink).toBeInTheDocument();
    const row = rivalLink.closest('tr')!;
    expect(row.textContent).toContain('2');
    expect(row.textContent).toContain('1');
    expect(screen.getAllByText('3 games · low confidence').length).toBeGreaterThan(0);
  });
});

/**
 * WR-04/WR-05 (38-REVIEW-FIX): CR-03's per-stage lookup computed exactly ONE
 * anchor key per stage — the block containing the EARLIEST match on that
 * stage. `buildStageEventSeries` (what `StageDetailPage` actually queries)
 * splits a stage's matches into a NEW anchor block whenever two consecutive
 * plays are more than `EVENT_ANCHOR_PROXIMITY_MS` apart — a real condition
 * for a multi-day entry. WR-04 fixed the block resolved from being always
 * the EARLIEST one; WR-05 then found that the "Stages Played" aggregate
 * row's displayed W-L/games figure spans EVERY block for the stage, while a
 * single `event=<key>` link can only ever resolve to ONE block — for this
 * fixture's two games (one per block), that meant the row read "1-1 · 2
 * games" but its link landed on a destination showing only 1 of them, with
 * nothing disclosing the narrowing. This test now asserts the row's link
 * instead spans a `from`/`to` date window covering every block, so the
 * destination lists BOTH games — exactly what the row's own "2 games" count
 * promises.
 */
describe('TournamentDetailPage -> StageDetailPage stage-row drill-down across a proximity-window gap (WR-04/WR-05)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    getMe.mockResolvedValue(defaultProfile());
    listAliases.mockResolvedValue({});
    mockPrepBrief({ isPending: false, activated: false });
  });

  it("links a stage played across a proximity-window gap to a window spanning every block, matching the row's own aggregate count", async () => {
    const earlyTime = Date.UTC(2021, 0, 1);
    // Strictly more than the proximity window apart — the engine's own
    // `splitTournamentBlocks` starts a new block past this gap.
    const lateTime = earlyTime + EVENT_ANCHOR_PROXIMITY_MS + 24 * 60 * 60 * 1000;

    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: 42,
        eventName: 'Ultimate Singles',
        firstSetAt: earlyTime,
        lastSetAt: lateTime,
      }),
    ]);
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'early-game',
        time: earlyTime,
        win: true,
        opponent: 'earlyrival',
        map: { id: 2, name: 'Big Battlefield' },
      }),
      makeMatch({
        id: 'late-game',
        time: lateTime,
        win: false,
        opponent: 'laterival',
        map: { id: 2, name: 'Big Battlefield' },
      }),
    ]);

    const user = userEvent.setup();
    renderTournamentAndStagePages('42');

    await screen.findByText('Stages Played');
    // The row's own aggregate count spans both blocks: 1 win + 1 loss = 2
    // games — this is the number the destination must match exactly. (Other
    // cards on this page, e.g. "Your Characters", may show the identical
    // "1-1 · 2 games" text for this fixture's single fighter matchup, so
    // this only asserts the text renders somewhere, not that it's unique.)
    expect(screen.getAllByText('1-1 · 2 games').length).toBeGreaterThan(0);
    const stageLink = screen.getByRole('link', {
      name: 'Big Battlefield — Stages Played, opens details',
    });
    // WR-05: more than one block for this stage — the link now carries an
    // inclusive from/to window (drillDownParams.ts's existing axes) spanning
    // both blocks' match times, never a single `event=` anchor that could
    // only ever resolve to one of them.
    const href = stageLink.getAttribute('href')!;
    expect(href).not.toContain('event=');
    expect(href).toContain(`from=${earlyTime}`);
    expect(href).toContain(`to=${lateTime}`);

    await user.click(stageLink);

    // Both blocks' games show up on the destination — exactly the 2 games
    // the row's own count promised, not just the most recent block's 1.
    expect(await screen.findByText('By Opponent')).toBeInTheDocument();
    // Plan 39.1-39: stage-detail rows are DrillableRows (shared accessible name).
    expect(
      screen.getByRole('link', { name: 'laterival — By Opponent, opens details' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'earlyrival — By Opponent, opens details' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('No games recorded on this stage yet.')).not.toBeInTheDocument();
  });

  it("keeps a single-block stage's link on the unchanged event= anchor form", async () => {
    const time = Date.UTC(2021, 0, 1);

    listTournaments.mockResolvedValue([
      makeEntry({
        eventId: 42,
        eventName: 'Ultimate Singles',
        firstSetAt: time,
        lastSetAt: time,
      }),
    ]);
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'only-game',
        time,
        win: true,
        opponent: 'solorival',
        map: { id: 2, name: 'Big Battlefield' },
      }),
    ]);

    renderTournamentAndStagePages('42');

    await screen.findByText('Stages Played');
    const stageLink = screen.getByRole('link', {
      name: 'Big Battlefield — Stages Played, opens details',
    });
    // A single block: byte-identical to the pre-WR-05 `event=<key>` link —
    // no `from`/`to` at all.
    const href = stageLink.getAttribute('href')!;
    expect(href).toMatch(/^\/stages\/2\?event=/);
    expect(href).not.toContain('from=');
    expect(href).not.toContain('to=');
  });
});

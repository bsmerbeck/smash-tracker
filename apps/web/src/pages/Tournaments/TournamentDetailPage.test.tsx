import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { TournamentDetailPage } from './TournamentDetailPage';
import { SpriteList } from '@/data/sprites';
import { usePrepBrief } from '@/hooks/usePrepBrief';

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
const createVodShare = vi.fn();
const getMe = vi.fn();

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
      users: {
        getMe: (...args: unknown[]) => getMe(...args),
      },
      matches: {
        list: (...args: unknown[]) => listMatches(...args),
      },
      tournaments: {
        list: (...args: unknown[]) => listTournaments(...args),
      },
      vodShares: {
        create: (...args: unknown[]) => createVodShare(...args),
      },
    },
  };
});

const mockUsePrepBrief = vi.mocked(usePrepBrief);

/** Convenience wrapper matching `usePrepBrief`'s consumed shape (`isPending`/`isError`/`data.activated`). */
function mockPrepBrief(state: { isPending: boolean; isError?: boolean; activated?: boolean }) {
  mockUsePrepBrief.mockReturnValue({
    isPending: state.isPending,
    isError: Boolean(state.isError),
    data: state.isPending || state.isError ? undefined : { activated: Boolean(state.activated) },
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

describe('TournamentDetailPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    getMe.mockResolvedValue(defaultProfile());
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

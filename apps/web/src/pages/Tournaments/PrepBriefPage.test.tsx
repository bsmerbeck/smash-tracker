import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TournamentEntry } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { usePrepBrief, useActivatePrepBrief, useReopenPrepBrief } from '@/hooks/usePrepBrief';
import { PrepBriefPage } from './PrepBriefPage';

const activateMutateSpy = vi.fn();
const reopenMutateSpy = vi.fn();

vi.mock('@/hooks/usePrepBrief', () => ({
  usePrepBrief: vi.fn(),
  useActivatePrepBrief: vi.fn(),
  useReopenPrepBrief: vi.fn(),
  // The two cards this page composes call these unconditionally — stubbed
  // here as inert spies since no test in this file exercises them directly.
  useAddLikelyOpponent: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveLikelyOpponent: () => ({ mutate: vi.fn(), isPending: false }),
  useTogglePrepChecklistItem: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
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

const listTournaments = vi.fn();
const listMatches = vi.fn();
const listAliases = vi.fn();
const listOpponents = vi.fn();
const listOpponentNotes = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      tournaments: {
        list: (...args: unknown[]) => listTournaments(...args),
      },
      matches: {
        list: (...args: unknown[]) => listMatches(...args),
      },
      opponents: {
        list: (...args: unknown[]) => listOpponents(...args),
        aliases: {
          list: (...args: unknown[]) => listAliases(...args),
        },
        notes: {
          list: (...args: unknown[]) => listOpponentNotes(...args),
        },
      },
    },
  };
});

const mockUsePrepBrief = vi.mocked(usePrepBrief);
const mockUseActivatePrepBrief = vi.mocked(useActivatePrepBrief);
const mockUseReopenPrepBrief = vi.mocked(useReopenPrepBrief);

const ENTRY_KEY = 'entry-abc';

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  return {
    eventId: 1,
    eventName: 'Ultimate Singles',
    firstSetAt: Date.UTC(2021, 0, 1),
    lastSetAt: Date.UTC(2021, 0, 1, 6),
    setsPlayed: 1,
    entryKey: ENTRY_KEY,
    ...overrides,
  };
}

/** Mirrors `usePrepBrief`'s consumed shape (`isPending`/`isError`/`data`). */
function mockBriefStatus(state: {
  isPending?: boolean;
  isError?: boolean;
  activated?: boolean;
  eventDate?: number;
}) {
  const isPending = state.isPending ?? false;
  const isError = state.isError ?? false;
  mockUsePrepBrief.mockReturnValue({
    isPending,
    isError,
    data:
      isPending || isError
        ? undefined
        : {
            activated: Boolean(state.activated),
            brief: state.activated
              ? {
                  eventDate: state.eventDate ?? Date.now() + 86_400_000,
                  activatedAt: Date.now(),
                  lastOpenedAt: Date.now(),
                  checklist: {},
                  likelyOpponents: {},
                }
              : undefined,
          },
  } as unknown as ReturnType<typeof usePrepBrief>);
}

/**
 * WR-04 harness: a component rendered AS the Route's `element` that can
 * navigate to a second entryKey path on the same route pattern from within
 * an already-mounted tree, mirroring how React Router reuses the same
 * `PrepBriefPage` instance across a param-only change (it does not remount
 * just because `useParams().entryKey` changes).
 */
function ProxyPage({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => navigate(to)}>
        navigate-to-second-entry
      </button>
      <PrepBriefPage />
    </div>
  );
}

function renderPage(entryKey = ENTRY_KEY) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/tournaments/${entryKey}/prep`]}>
        <AuthProvider>
          <Routes>
            <Route path="/tournaments/:entryKey/prep" element={<PrepBriefPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PrepBriefPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    listTournaments.mockResolvedValue([makeEntry()]);
    listMatches.mockResolvedValue([]);
    listAliases.mockResolvedValue({});
    listOpponents.mockResolvedValue([]);
    listOpponentNotes.mockResolvedValue({});
    mockUseActivatePrepBrief.mockReturnValue({
      mutate: activateMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useActivatePrepBrief>);
    mockUseReopenPrepBrief.mockReturnValue({
      mutate: reopenMutateSpy,
      isPending: false,
    } as unknown as ReturnType<typeof useReopenPrepBrief>);
  });

  it('activates exactly once and never reopens when the brief is not activated', async () => {
    mockBriefStatus({ activated: false });

    renderPage();

    await screen.findByText('Prep checklist');
    expect(activateMutateSpy).toHaveBeenCalledTimes(1);
    expect(reopenMutateSpy).not.toHaveBeenCalled();
  });

  it('reopens exactly once with a non-empty open id and never activates when already activated', async () => {
    mockBriefStatus({ activated: true });

    renderPage();

    await screen.findByText('Prep checklist');
    expect(reopenMutateSpy).toHaveBeenCalledTimes(1);
    expect(activateMutateSpy).not.toHaveBeenCalled();
    const [openIdArg] = reopenMutateSpy.mock.calls[0]!;
    expect(typeof openIdArg).toBe('string');
    expect(openIdArg.length).toBeGreaterThan(0);
  });

  it('does not fire a second mutation on a re-render caused by a query refetch', async () => {
    mockBriefStatus({ activated: false });

    const { rerender } = renderPage();

    await screen.findByText('Prep checklist');
    expect(activateMutateSpy).toHaveBeenCalledTimes(1);

    // Simulate the query object identity changing on a refetch resolution.
    mockBriefStatus({ activated: false });
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={[`/tournaments/${ENTRY_KEY}/prep`]}>
          <AuthProvider>
            <Routes>
              <Route path="/tournaments/:entryKey/prep" element={<PrepBriefPage />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Prep checklist');
    expect(activateMutateSpy).toHaveBeenCalledTimes(1);
    expect(reopenMutateSpy).not.toHaveBeenCalled();
  });

  it('fires activation again for a second entryKey when the same instance stays mounted across a param change (WR-04)', async () => {
    const SECOND_ENTRY_KEY = 'entry-def';
    listTournaments.mockResolvedValue([
      makeEntry(),
      makeEntry({ eventId: 2, entryKey: SECOND_ENTRY_KEY }),
    ]);
    mockBriefStatus({ activated: false });
    const user = userEvent.setup();

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={[`/tournaments/${ENTRY_KEY}/prep`]}>
          <AuthProvider>
            <Routes>
              <Route
                path="/tournaments/:entryKey/prep"
                element={<ProxyPage to={`/tournaments/${SECOND_ENTRY_KEY}/prep`} />}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Prep checklist');
    expect(activateMutateSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'navigate-to-second-entry' }));

    await screen.findByText('Prep checklist');
    expect(activateMutateSpy).toHaveBeenCalledTimes(2);
  });

  it('renders the event name and both card titles', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventName: 'Genesis 10' })]);
    mockBriefStatus({ activated: false });

    renderPage();

    expect(await screen.findByText('Genesis 10')).toBeInTheDocument();
    expect(screen.getByText('Likely opponents')).toBeInTheDocument();
    expect(screen.getByText('Prep checklist')).toBeInTheDocument();
  });

  it('renders an activated brief whose eventDate is in the past rather than a not-found state', async () => {
    mockBriefStatus({ activated: true, eventDate: Date.UTC(2020, 0, 1) });

    renderPage();

    expect(await screen.findByText('Prep checklist')).toBeInTheDocument();
    expect(screen.queryByText('Tournament not found')).not.toBeInTheDocument();
  });

  it('shows the loading copy while the brief query is pending', async () => {
    mockBriefStatus({ isPending: true });

    renderPage();

    expect(await screen.findByText('Loading your prep brief...')).toBeInTheDocument();
  });

  it('shows the error copy when the brief query errors', async () => {
    mockBriefStatus({ isError: true });

    renderPage();

    expect(
      await screen.findByText('Something went wrong loading your prep brief. Please try again.'),
    ).toBeInTheDocument();
  });
});

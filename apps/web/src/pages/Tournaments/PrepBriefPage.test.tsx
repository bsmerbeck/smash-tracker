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
const postCanonicalEventSpy = vi.fn();

// A stand-in for the real `PrepPaidReportsCard` (27-10, tested exhaustively
// in its own colocated test file). It fires the SAME canonical-event poster
// on mount that the real card fires, so this suite proves PrepBriefPage's
// conditional composition is what structurally prevents `prep_offer_viewed`
// from firing when the card doesn't mount — not some quirk of the real
// card's own internal once-only guard.
vi.mock('@/pages/Tournaments/prepPaid/PrepPaidReportsCard', () => ({
  PrepPaidReportsCard: () => {
    postCanonicalEventSpy('prep_offer_viewed', {});
    return <div data-testid="prep-paid-reports-card">AI prep reports</div>;
  },
}));

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
  /**
   * Left `unknown`, not `boolean`, on purpose: RPT-04's strict-check case
   * needs to pass a non-boolean truthy value through to the real page.
   */
  paidReportsAvailable?: unknown;
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
            paidReportsAvailable: state.paidReportsAvailable,
            brief: state.activated
              ? {
                  eventDate: state.eventDate ?? Date.now() + 86_400_000,
                  activatedAt: Date.now(),
                  lastOpenedAt: Date.now(),
                  checklist: {},
                  likelyOpponents: {},
                  scoutBindings: {},
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

describe('paid placement structural absence (RPT-04)', () => {
  const RESERVED_PLACEMENT_OR_HIDDEN_STYLE =
    /data-[a-z-]*(placement|offer|promo|upsell)|display:\s*none/i;

  /**
   * The three assertions every not-rendered case must make (27-11-PLAN.md
   * Task 1, action item 4): the card's accessible name is absent, the
   * canonical-event poster was never called, and nothing in the rendered
   * output carries a reserved-placement or hidden-style marker.
   */
  function expectNoPaidPlacement(container: HTMLElement) {
    expect(screen.queryByText('AI prep reports')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prep-paid-reports-card')).not.toBeInTheDocument();
    expect(postCanonicalEventSpy).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toMatch(RESERVED_PLACEMENT_OR_HIDDEN_STYLE);
  }

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

  it('renders zero paid affordance when paidReportsAvailable is absent from the brief response', async () => {
    mockBriefStatus({ activated: true });

    const { container } = renderPage();

    await screen.findByText('Prep checklist');
    expectNoPaidPlacement(container);
  });

  it('renders zero paid affordance when paidReportsAvailable is explicitly false', async () => {
    mockBriefStatus({ activated: true, paidReportsAvailable: false });

    const { container } = renderPage();

    await screen.findByText('Prep checklist');
    expectNoPaidPlacement(container);
  });

  it('renders zero paid affordance when paidReportsAvailable is a non-boolean truthy value (strict check, not truthiness)', async () => {
    mockBriefStatus({ activated: true, paidReportsAvailable: 'true' });

    const { container } = renderPage();

    await screen.findByText('Prep checklist');
    expectNoPaidPlacement(container);
  });

  it('mounts the paid card between the Likely opponents card and the Checklist card, in that DOM order, only when paidReportsAvailable is strictly true', async () => {
    mockBriefStatus({ activated: true, paidReportsAvailable: true });

    renderPage();

    await screen.findByText('Prep checklist');
    const paidCard = await screen.findByTestId('prep-paid-reports-card');
    expect(paidCard).toBeInTheDocument();
    expect(postCanonicalEventSpy).toHaveBeenCalledWith('prep_offer_viewed', {});

    const likelyCard = screen.getByText('Likely opponents');
    const checklistCard = screen.getByText('Prep checklist');

    // Document-position comparison, not text order: proves the card sits
    // structurally between the two Phase 26 cards rather than merely
    // appearing somewhere after "Likely opponents" in the rendered text.
    expect(
      likelyCard.compareDocumentPosition(paidCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      paidCard.compareDocumentPosition(checklistCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders zero paid affordance while the brief query is pending, regardless of any eventual paidReportsAvailable value', async () => {
    mockBriefStatus({ isPending: true });

    const { container } = renderPage();

    await screen.findByText('Loading your prep brief...');
    expectNoPaidPlacement(container);
  });

  it('renders zero paid affordance when the brief query errors', async () => {
    mockBriefStatus({ isError: true });

    const { container } = renderPage();

    await screen.findByText('Something went wrong loading your prep brief. Please try again.');
    expectNoPaidPlacement(container);
  });

  it('renders zero paid affordance on the not-found branch, even when paidReportsAvailable is strictly true', async () => {
    listTournaments.mockResolvedValue([]);
    mockBriefStatus({ activated: true, paidReportsAvailable: true });

    const { container } = renderPage();

    await screen.findByText('Tournament not found');
    expectNoPaidPlacement(container);
  });
});

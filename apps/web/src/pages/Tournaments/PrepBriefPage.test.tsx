import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { usePrepBrief, useActivatePrepBrief, useReopenPrepBrief } from '@/hooks/usePrepBrief';
import { PrepBriefPage } from './PrepBriefPage';

const activateMutateSpy = vi.fn();
const reopenMutateSpy = vi.fn();
const postCanonicalEventSpy = vi.fn();
const reviewToggleMutateSpy = vi.fn();
const synthesisCardRenderSpy = vi.fn();

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

// A stand-in for the real `PostEventSynthesisCard` (28-09, tested
// exhaustively in its own colocated test file, which itself pulls in
// `useCredits`/`useSynthesisJob`/`usePracticePlan`/`useSubmitSynthesis`/
// `usePostEventCheckoutReturn`). This suite only needs to prove WHERE and
// WHEN `PrepBriefPage` mounts it — the strict-true gate and the section
// order — never its own internal states.
vi.mock('@/pages/Tournaments/postEventPaid/PostEventSynthesisCard', () => ({
  PostEventSynthesisCard: (props: { entryKey: string; annotatedEvidenceCount: number }) => {
    synthesisCardRenderSpy(props);
    return <div data-testid="postevent-synthesis-card">AI practice plan</div>;
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
  useToggleReviewChecklistItem: () => ({
    mutate: reviewToggleMutateSpy,
    isPending: false,
    variables: undefined,
  }),
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
   * The top-level, EFFECTIVE `PrepBriefStatus.reviewAt` field (28-04/28-10)
   * — the ONLY input `derivePrepSurfaceMode` reads. Deliberately a sibling
   * of `eventDate` (not derived from it): INV-5 requires a fixture where
   * `eventDate` is wildly in the past but `reviewAt` is absent to still
   * render prep, proving the page never re-derives mode from entry dates.
   */
  reviewAt?: number;
  reviewChecklist?: Record<string, true>;
  likelyOpponents?: Record<string, true>;
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
            reviewAt: state.reviewAt,
            brief: state.activated
              ? {
                  eventDate: state.eventDate ?? Date.now() + 86_400_000,
                  activatedAt: Date.now(),
                  lastOpenedAt: Date.now(),
                  checklist: {},
                  likelyOpponents: state.likelyOpponents ?? {},
                  scoutBindings: {},
                  reviewChecklist: state.reviewChecklist ?? {},
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
          {/* review mode's ResultsContextCard renders a Tooltip on every
              alias-inferred manual row (INV-8) — a real `TooltipProvider`
              ancestor is required, matching the page's real render tree
              (`MainLayout.tsx` provides one in production). */}
          <TooltipProvider>
            <Routes>
              <Route path="/tournaments/:entryKey/prep" element={<PrepBriefPage />} />
            </Routes>
          </TooltipProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Builds a minimal valid `Match` fixture, mirroring `ResultsContextCard.test.tsx`'s helper. */
function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'Rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
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
    // Keeps the exact same tree SHAPE `renderPage()` produces (including the
    // `TooltipProvider` wrapper) — a mismatched shape here would make React
    // unmount/remount `PrepBriefPage` at the root instead of reconciling it,
    // which would spuriously reset the single-fire guard this test proves.
    mockBriefStatus({ activated: false });
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={[`/tournaments/${ENTRY_KEY}/prep`]}>
          <AuthProvider>
            <TooltipProvider>
              <Routes>
                <Route path="/tournaments/:entryKey/prep" element={<PrepBriefPage />} />
              </Routes>
            </TooltipProvider>
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

describe('review mode composition (28-10)', () => {
  const RESERVED_PLACEMENT_OR_HIDDEN_STYLE =
    /data-[a-z-]*(placement|offer|promo|upsell)|display:\s*none/i;

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

  it('INV-5: mode derives from the server reviewAt answer only', async () => {
    // A fixture with WILDLY past entry dates but NO reviewAt still renders
    // prep — the client must never re-derive mode from
    // entry.firstSetAt/lastSetAt/eventDate (owner invariant 5, client half).
    listTournaments.mockResolvedValue([
      makeEntry({ firstSetAt: Date.UTC(2000, 0, 1), lastSetAt: Date.UTC(2000, 0, 1, 6) }),
    ]);
    mockBriefStatus({ activated: true, reviewAt: undefined, eventDate: Date.UTC(2000, 0, 1) });
    const { unmount: unmountNoReviewAt } = renderPage();
    await screen.findByText('Prep checklist');
    expect(screen.queryByText('Post-event review')).not.toBeInTheDocument();
    unmountNoReviewAt();
    activateMutateSpy.mockClear();
    reopenMutateSpy.mockClear();

    // The frozen reviewAt is in the past -> review.
    mockBriefStatus({ activated: true, reviewAt: Date.now() - 60_000 });
    const { unmount: unmountPastReviewAt } = renderPage();
    await screen.findByText('Post-event review');
    expect(screen.queryByText('Prep checklist')).not.toBeInTheDocument();
    unmountPastReviewAt();
    activateMutateSpy.mockClear();
    reopenMutateSpy.mockClear();

    // The candidate reviewAt is still in the future -> not converted yet, prep.
    mockBriefStatus({ activated: true, reviewAt: Date.now() + 60_000 });
    renderPage();
    await screen.findByText('Prep checklist');
    expect(screen.queryByText('Post-event review')).not.toBeInTheDocument();
  });

  it('review-mode section order matches the UI-SPEC: header, mode strip, results, checklist, grounding, [gated card], collapsed prep', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventName: 'Genesis 10' })]);
    mockBriefStatus({
      activated: true,
      reviewAt: Date.now() - 60_000,
      paidReportsAvailable: true,
    });

    renderPage();

    const header = await screen.findByText('Genesis 10');
    const modeStrip = screen.getByText('Post-event review');
    const results = screen.getByText('Your results');
    const checklist = screen.getByText('Review checklist');
    const grounding = screen.getByText('Your annotations');
    const synthesis = screen.getByTestId('postevent-synthesis-card');
    const collapsedTrigger = screen.getByText('Your original prep brief');

    const nodesInOrder = [
      header,
      modeStrip,
      results,
      checklist,
      grounding,
      synthesis,
      collapsedTrigger,
    ];
    for (let i = 0; i < nodesInOrder.length - 1; i += 1) {
      expect(
        nodesInOrder[i]!.compareDocumentPosition(nodesInOrder[i + 1]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('the collapsed prep section renders LikelyOpponentsCard + PrepChecklistCard functional and collapsed by default; PrepPaidReportsCard is NOT inside it — in review mode with the gate on, the synthesis card is the SOLE monetized element', async () => {
    mockBriefStatus({
      activated: true,
      reviewAt: Date.now() - 60_000,
      paidReportsAvailable: true,
    });
    const user = userEvent.setup();

    renderPage();

    await screen.findByText('Post-event review');

    const trigger = screen.getByRole('button', { name: /Your original prep brief/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Likely opponents')).toBeInTheDocument();
    expect(screen.getByText('Prep checklist')).toBeInTheDocument();

    // PrepPaidReportsCard never mounts inside (or anywhere in) review mode —
    // the synthesis card is the sole monetized element.
    expect(screen.queryByTestId('prep-paid-reports-card')).not.toBeInTheDocument();
    expect(postCanonicalEventSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('postevent-synthesis-card')).toBeInTheDocument();
  });

  it('INV-6: gate-off structural absence in review mode', async () => {
    const gateOffValues: unknown[] = [undefined, false, 'true'];

    for (const paidReportsAvailable of gateOffValues) {
      mockBriefStatus({
        activated: true,
        reviewAt: Date.now() - 60_000,
        paidReportsAvailable,
      });
      const user = userEvent.setup();
      const { container, unmount } = renderPage();

      await screen.findByText('Post-event review');

      // Structurally absent, three ways: accessible name/testid absent, no
      // postEventPaid copy anywhere, no reserved-placement/hidden-style marker.
      expect(screen.queryByTestId('postevent-synthesis-card')).not.toBeInTheDocument();
      expect(screen.queryByText('AI practice plan')).not.toBeInTheDocument();
      expect(synthesisCardRenderSpy).not.toHaveBeenCalled();
      expect(container.innerHTML).not.toMatch(RESERVED_PLACEMENT_OR_HIDDEN_STYLE);

      // The free review stays fully functional in the SAME render: results,
      // checklist toggling, and grounding are all present and interactive.
      expect(screen.getByText('Your results')).toBeInTheDocument();
      expect(screen.getByText('Review checklist')).toBeInTheDocument();
      expect(screen.getByText('Your annotations')).toBeInTheDocument();

      const checklistItem = screen.getByRole('checkbox', {
        name: 'Attach VODs to your matches from this event',
      });
      await user.click(checklistItem);
      expect(reviewToggleMutateSpy).toHaveBeenCalledWith({ itemId: 'attachVods', checked: true });

      unmount();
      reviewToggleMutateSpy.mockClear();
      synthesisCardRenderSpy.mockClear();
    }
  });

  it('strict true renders the synthesis card between grounding and collapsed prep', async () => {
    mockBriefStatus({
      activated: true,
      reviewAt: Date.now() - 60_000,
      paidReportsAvailable: true,
    });

    renderPage();

    await screen.findByText('Post-event review');
    const grounding = screen.getByText('Your annotations');
    const synthesis = screen.getByTestId('postevent-synthesis-card');
    const collapsedTrigger = screen.getByText('Your original prep brief');

    expect(
      grounding.compareDocumentPosition(synthesis) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      synthesis.compareDocumentPosition(collapsedTrigger) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('prep mode renders byte-identically to Phase 27', async () => {
    mockBriefStatus({ activated: true, reviewAt: undefined });

    renderPage();

    await screen.findByText('Prep checklist');
    expect(screen.getByText('Likely opponents')).toBeInTheDocument();

    // No review-mode surface renders in prep mode.
    expect(screen.queryByText('Post-event review')).not.toBeInTheDocument();
    expect(screen.queryByText('Your results')).not.toBeInTheDocument();
    expect(screen.queryByText('Review checklist')).not.toBeInTheDocument();
    expect(screen.queryByText('Your annotations')).not.toBeInTheDocument();
    expect(screen.queryByText('Your original prep brief')).not.toBeInTheDocument();
    expect(screen.queryByTestId('postevent-synthesis-card')).not.toBeInTheDocument();
  });

  it('the mount activate-or-open mutation fires exactly once per entryKey in BOTH modes', async () => {
    // prep mode (unactivated brief -> activate).
    mockBriefStatus({ activated: false });
    const { unmount: unmountPrep } = renderPage();
    await screen.findByText('Prep checklist');
    expect(activateMutateSpy).toHaveBeenCalledTimes(1);
    expect(reopenMutateSpy).not.toHaveBeenCalled();
    unmountPrep();
    activateMutateSpy.mockClear();
    reopenMutateSpy.mockClear();

    // review mode (activated brief, reviewAt in the past -> reopen).
    mockBriefStatus({ activated: true, reviewAt: Date.now() - 60_000 });
    renderPage();
    await screen.findByText('Post-event review');
    expect(reopenMutateSpy).toHaveBeenCalledTimes(1);
    expect(activateMutateSpy).not.toHaveBeenCalled();
  });

  it('WR-02: annotatedEvidenceCount mirrors the server rule — VOD timestamps only, over the synced+manual union', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventName: 'Ultimate Singles' })]);
    listMatches.mockResolvedValue([
      // Direction (a): an event match with ONLY match-level tags — the old
      // predicate counted it, the server's 409 rule does not.
      makeMatch({
        id: 'tags-only',
        time: Date.UTC(2021, 0, 1, 2),
        win: true,
        eventName: 'Ultimate Singles',
        tags: ['punish'],
      }),
      // Direction (b): a source-less curated-opponent row with NO eventName
      // (inferred-manual, inside the padded window) carrying a real VOD
      // timestamp — outside matchesForEntry, but inside the server's
      // selectReviewResultsContext union, so it DOES count.
      makeMatch({
        id: 'inferred-manual',
        time: Date.UTC(2021, 0, 1, 3),
        win: false,
        opponent: 'CuratedRival',
        vodTimestamps: [{ id: 'ts-0', seconds: 42, note: 'clean punish', tags: [] }],
      }),
    ]);
    mockBriefStatus({
      activated: true,
      reviewAt: Date.now() - 60_000,
      paidReportsAvailable: true,
      likelyOpponents: { CuratedRival: true },
    });

    renderPage();

    await screen.findByTestId('postevent-synthesis-card');
    expect(synthesisCardRenderSpy).toHaveBeenCalledWith(
      expect.objectContaining({ annotatedEvidenceCount: 1 }),
    );
  });

  it('results context feeds alias-resolved matches through selectReviewResultsContext', async () => {
    listTournaments.mockResolvedValue([makeEntry({ eventName: 'Ultimate Singles' })]);
    listAliases.mockResolvedValue({ armada_raw: 'ArmadaAlias' });
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        time: Date.UTC(2021, 0, 1, 3),
        win: true,
        opponent: 'armada_raw',
        eventName: 'Ultimate Singles',
      }),
    ]);
    mockBriefStatus({
      activated: true,
      reviewAt: Date.now() - 60_000,
      likelyOpponents: { ArmadaAlias: true },
    });

    renderPage();

    await screen.findByText('Post-event review');
    expect(await screen.findByText('ArmadaAlias')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });
});

/**
 * Phase 30.3 (Gate 6, prep-bypass closure, explicit owner instruction): a
 * direct/deep-linked navigation to `/tournaments/:entryKey/prep` for an
 * admin-imported entry must expose NO prep activation, mirroring
 * `TournamentDetailPage.tsx`'s existing CTA guard (which this exact route
 * bypasses entirely) and `DashboardPrepActionSlot.tsx`'s own origin guard
 * (which only stops the row from being OFFERED as a link). Every fixture
 * here is deliberately FUTURE-DATED (`firstSetAt`/`lastSetAt` ahead of
 * `Date.now()`) so the protection cannot pass by accident just because real
 * imported events happen to be historical — only an explicit
 * `origin === 'admin-imported'` check can prove the fix.
 */
describe('PrepBriefPage — admin-imported entry (prep-bypass closure)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
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
    mockBriefStatus({ activated: false });
  });

  function makeFutureImportedEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
    const now = Date.now();
    return makeEntry({
      firstSetAt: now + 86_400_000,
      lastSetAt: now + 86_400_000 + 3_600_000,
      ...overrides,
      // origin is a web-local extension (`historicalTournament.ts`), not on
      // the shared `TournamentEntry` type — cast at the call site, matching
      // `TournamentDetailPage.test.tsx`'s own established fixture pattern.
    } as Partial<TournamentEntry>) as TournamentEntry;
  }

  it('never fires activate or reopen for a future-dated admin-imported entry', async () => {
    listTournaments.mockResolvedValue([
      { ...makeFutureImportedEntry(), origin: 'admin-imported', provider: 'startgg' },
    ]);

    renderPage();

    expect(await screen.findByTestId('prep-imported-blocked')).toBeInTheDocument();
    expect(activateMutateSpy).not.toHaveBeenCalled();
    expect(reopenMutateSpy).not.toHaveBeenCalled();
  });

  it('renders the imported-snapshot notice and a blocked explanation instead of the prep UI', async () => {
    listTournaments.mockResolvedValue([
      { ...makeFutureImportedEntry(), origin: 'admin-imported', provider: 'startgg' },
    ]);

    renderPage();

    expect(await screen.findByTestId('imported-snapshot-notice')).toBeInTheDocument();
    expect(screen.getByText("Prep isn't available for this event")).toBeInTheDocument();
    expect(
      screen.getByText(
        'This is an imported historical record of public data — tournament prep only applies to your own upcoming events.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Prep checklist')).not.toBeInTheDocument();
    expect(screen.queryByText('Likely opponents')).not.toBeInTheDocument();
  });

  it('the blocked state links back to the tournament detail page, never dead-ending', async () => {
    listTournaments.mockResolvedValue([
      { ...makeFutureImportedEntry(), origin: 'admin-imported', provider: 'startgg' },
    ]);

    renderPage();

    const backLink = await screen.findByRole('link', { name: 'Back to tournament' });
    expect(backLink).toHaveAttribute('href', `/tournaments/${ENTRY_KEY}`);
  });

  it('positive control: a future-dated NON-imported entry still activates normally', async () => {
    listTournaments.mockResolvedValue([makeFutureImportedEntry()]);

    renderPage();

    await screen.findByText('Prep checklist');
    expect(activateMutateSpy).toHaveBeenCalledTimes(1);
    expect(reopenMutateSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('prep-imported-blocked')).not.toBeInTheDocument();
  });

  it('still never activates even once an already-activated brief exists for the imported entryKey (reopen also blocked)', async () => {
    listTournaments.mockResolvedValue([
      { ...makeFutureImportedEntry(), origin: 'admin-imported', provider: 'startgg' },
    ]);
    mockBriefStatus({ activated: true });

    renderPage();

    expect(await screen.findByTestId('prep-imported-blocked')).toBeInTheDocument();
    expect(activateMutateSpy).not.toHaveBeenCalled();
    expect(reopenMutateSpy).not.toHaveBeenCalled();
  });
});

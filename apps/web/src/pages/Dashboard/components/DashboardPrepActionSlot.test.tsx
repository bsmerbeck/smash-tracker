import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { PrepBriefStatus, TournamentEntry } from '@smash-tracker/shared';
import { FOURTEEN_DAYS_MS } from '@/lib/prepEntryPoints';
import { derivePrepSurfaceMode } from '@/lib/prepSurfaceMode';
import { DashboardPrepActionSlot } from './DashboardPrepActionSlot';

const useTournamentEntries = vi.fn();
vi.mock('@/hooks/useTournamentEntries', () => ({
  useTournamentEntries: () => useTournamentEntries(),
}));

const useProfile = vi.fn();
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => useProfile(),
}));

// Plan 39-12: the review state's server status. Keyed by entryKey; an
// `undefined` key (no candidate) is the hook's disabled, request-free call.
const usePrepBrief = vi.fn();
vi.mock('@/hooks/usePrepBrief', () => ({
  usePrepBrief: (entryKey: string | undefined) => usePrepBrief(entryKey),
}));

type BriefRead = PrepBriefStatus | 'pending' | 'error';
function mockBriefs(byKey: Record<string, BriefRead>) {
  usePrepBrief.mockImplementation((entryKey: string | undefined) => {
    const read = entryKey === undefined ? 'pending' : byKey[entryKey];
    if (read === undefined || read === 'pending') {
      return { data: undefined, isPending: true, isError: false, isSuccess: false };
    }
    if (read === 'error') {
      return { data: undefined, isPending: false, isError: true, isSuccess: false };
    }
    return { data: read, isPending: false, isError: false, isSuccess: true };
  });
}

vi.mock('@/pages/Tournaments/components/PrepManualEntryDialog', () => ({
  PrepManualEntryDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="mock-prep-manual-entry-dialog" /> : null,
}));

function makeEntry(overrides: Partial<TournamentEntry> & { entryKey: string }): TournamentEntry {
  return {
    eventName: 'Event',
    firstSetAt: 1,
    lastSetAt: 1,
    setsPlayed: 0,
    source: 'manual',
    ...overrides,
  };
}

function renderSlot() {
  return render(
    <MemoryRouter>
      <DashboardPrepActionSlot />
    </MemoryRouter>,
  );
}

describe('DashboardPrepActionSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBriefs({});
  });

  it('renders nothing while either query is pending — unknown is not "no upcoming event"', () => {
    useTournamentEntries.mockReturnValue({ data: undefined, isPending: true, isError: false });
    useProfile.mockReturnValue({ data: undefined, isPending: true, isError: false });
    renderSlot();
    expect(screen.queryByTestId('dashboard-prep-action-slot')).not.toBeInTheDocument();
  });

  it('renders nothing when either query errors', () => {
    useTournamentEntries.mockReturnValue({ data: undefined, isPending: false, isError: true });
    useProfile.mockReturnValue({
      data: { onboardingIntent: 'prepare' },
      isPending: false,
      isError: false,
    });
    renderSlot();
    expect(screen.queryByTestId('dashboard-prep-action-slot')).not.toBeInTheDocument();
  });

  it('renders the nearest of two future entries, ignoring a past entry', () => {
    const now = Date.now();
    const past = makeEntry({ entryKey: 'past', eventName: 'Old Locals', firstSetAt: now - 1000 });
    const nearFuture = makeEntry({
      entryKey: 'near',
      eventName: 'Nearest Regional',
      firstSetAt: now + 1000 * 60 * 60, // 1 hour out
    });
    const farFuture = makeEntry({
      entryKey: 'far',
      eventName: 'Far Major',
      firstSetAt: now + 1000 * 60 * 60 * 24 * 30, // 30 days out
    });
    useTournamentEntries.mockReturnValue({
      data: [past, farFuture, nearFuture],
      isPending: false,
      isError: false,
    });
    useProfile.mockReturnValue({
      data: { onboardingIntent: null },
      isPending: false,
      isError: false,
    });

    renderSlot();

    const slot = screen.getByTestId('dashboard-prep-action-slot');
    expect(slot).toHaveTextContent('Nearest Regional');
    expect(slot).not.toHaveTextContent('Far Major');
    expect(screen.getByRole('link', { name: 'Prep for this event' })).toHaveAttribute(
      'href',
      '/tournaments/near/prep',
    );
  });

  it('renders the add-event recovery path when no upcoming entry exists and intent is "prepare"', async () => {
    const user = userEvent.setup();
    useTournamentEntries.mockReturnValue({ data: [], isPending: false, isError: false });
    useProfile.mockReturnValue({
      data: { onboardingIntent: 'prepare' },
      isPending: false,
      isError: false,
    });

    renderSlot();

    const slot = screen.getByTestId('dashboard-prep-action-slot');
    expect(slot).toHaveTextContent('Add your upcoming event to start prepping');
    expect(screen.queryByTestId('mock-prep-manual-entry-dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add event' }));
    expect(screen.getByTestId('mock-prep-manual-entry-dialog')).toBeInTheDocument();
  });

  it('renders nothing (not even the test-id) with no upcoming entry and any other intent, including null', () => {
    useTournamentEntries.mockReturnValue({ data: [], isPending: false, isError: false });
    useProfile.mockReturnValue({
      data: { onboardingIntent: null },
      isPending: false,
      isError: false,
    });
    renderSlot();
    expect(screen.queryByTestId('dashboard-prep-action-slot')).not.toBeInTheDocument();

    useProfile.mockReturnValue({
      data: { onboardingIntent: 'track_improvement' },
      isPending: false,
      isError: false,
    });
    renderSlot();
    expect(screen.queryAllByTestId('dashboard-prep-action-slot')).toHaveLength(0);
  });

  // Phase 30.3 (Gate 6, prep-bypass closure, explicit owner instruction): a
  // FUTURE-DATED admin-imported fixture — the protection must reject it on
  // ORIGIN alone, never merely because real imported events happen to be
  // historical. A date-only guard would pass this by accident; only an
  // explicit origin check can prove the fix.
  it('excludes a future-dated admin-imported entry even though it qualifies on date alone', () => {
    const now = Date.now();
    const importedFuture = makeEntry({
      entryKey: 'imported-future',
      eventName: 'Mis-recorded Imported Snapshot',
      firstSetAt: now + 1000 * 60 * 60,
      origin: 'admin-imported',
    } as Partial<TournamentEntry> & { entryKey: string; origin: string });
    useTournamentEntries.mockReturnValue({
      data: [importedFuture],
      isPending: false,
      isError: false,
    });
    useProfile.mockReturnValue({
      data: { onboardingIntent: null },
      isPending: false,
      isError: false,
    });

    renderSlot();

    expect(screen.queryByTestId('dashboard-prep-action-slot')).not.toBeInTheDocument();
  });

  it('a genuine future entry wins over a future-dated admin-imported one, which is excluded outright', () => {
    const now = Date.now();
    const importedFuture = makeEntry({
      entryKey: 'imported-future',
      eventName: 'Mis-recorded Imported Snapshot',
      firstSetAt: now + 1000 * 60, // nearer in time than the genuine entry below
      origin: 'admin-imported',
    } as Partial<TournamentEntry> & { entryKey: string; origin: string });
    const genuineFuture = makeEntry({
      entryKey: 'genuine-future',
      eventName: 'Real Upcoming Regional',
      firstSetAt: now + 1000 * 60 * 60,
    });
    useTournamentEntries.mockReturnValue({
      data: [importedFuture, genuineFuture],
      isPending: false,
      isError: false,
    });
    useProfile.mockReturnValue({
      data: { onboardingIntent: null },
      isPending: false,
      isError: false,
    });

    renderSlot();

    const slot = screen.getByTestId('dashboard-prep-action-slot');
    expect(slot).toHaveTextContent('Real Upcoming Regional');
    expect(slot).not.toHaveTextContent('Mis-recorded Imported Snapshot');
    expect(screen.getByRole('link', { name: 'Prep for this event' })).toHaveAttribute(
      'href',
      '/tournaments/genuine-future/prep',
    );
  });
  describe('the review state (plan 39-12, D-13, C1-H6/C1-H7/C1-M6)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const NOW = Date.now();
    const inWindow: PrepBriefStatus = { activated: true, reviewAt: NOW - DAY_MS };
    const pastEntry = makeEntry({
      entryKey: 'past',
      eventName: 'Old Locals',
      firstSetAt: NOW - 3 * DAY_MS,
      lastSetAt: NOW - 3 * DAY_MS,
    });

    function withEntries(entries: TournamentEntry[], intent: string | null = null) {
      useTournamentEntries.mockReturnValue({ data: entries, isPending: false, isError: false });
      useProfile.mockReturnValue({
        data: { onboardingIntent: intent },
        isPending: false,
        isError: false,
      });
    }

    function slotState(): string | null {
      const slots = screen.queryAllByTestId('dashboard-prep-action-slot');
      expect(slots.length).toBeLessThanOrEqual(1);
      return slots[0]?.getAttribute('data-state') ?? null;
    }

    it('offers the review door for the most recent past entry whose server status is inside the fourteen-day window', () => {
      withEntries([pastEntry]);
      mockBriefs({ past: inWindow });
      renderSlot();

      expect(slotState()).toBe('review');
      expect(screen.getByTestId('dashboard-prep-action-slot')).toHaveTextContent(
        'Review Old Locals',
      );
      expect(screen.getByRole('link', { name: 'Review this event' })).toHaveAttribute(
        'href',
        '/tournaments/past/prep',
      );
      expect(screen.getByTestId('dashboard-prep-action-slot').textContent).not.toMatch(
        /Invalid Date|NaN/,
      );
    });

    it('the same qualifying status resolves to review on the destination page (derivePrepSurfaceMode)', () => {
      expect(derivePrepSurfaceMode(inWindow)).toBe('review');
    });

    it('C1-M6: a reviewable entry AND onboardingIntent "prepare" shows REVIEW, not add-event', () => {
      withEntries([pastEntry], 'prepare');
      mockBriefs({ past: inWindow });
      renderSlot();

      expect(slotState()).toBe('review');
      expect(screen.queryByRole('button', { name: 'Add event' })).not.toBeInTheDocument();
    });

    it('upcoming wins over a reviewable entry, and the review status is not even read', () => {
      const upcoming = makeEntry({
        entryKey: 'next',
        eventName: 'Next Regional',
        firstSetAt: NOW + DAY_MS,
      });
      withEntries([pastEntry, upcoming], 'prepare');
      mockBriefs({ past: inWindow });
      renderSlot();

      expect(slotState()).toBe('upcoming');
      expect(usePrepBrief).not.toHaveBeenCalledWith('past');
    });

    it.each<[string, PrepBriefStatus]>([
      ['not activated', { activated: false, reviewAt: NOW - DAY_MS }],
      ['activated with reviewAt absent', { activated: true }],
      ['reviewAt in the future', { activated: true, reviewAt: NOW + DAY_MS }],
      [
        'reviewAt older than fourteen days',
        { activated: true, reviewAt: NOW - FOURTEEN_DAYS_MS - DAY_MS },
      ],
    ])(
      'no review state when the server status is %s (falls to add-event / nothing)',
      (_label, status) => {
        withEntries([pastEntry], 'prepare');
        mockBriefs({ past: status });
        const { unmount } = renderSlot();
        expect(usePrepBrief).toHaveBeenCalledWith('past');
        expect(slotState()).toBe('addEvent');
        unmount();

        withEntries([pastEntry], null);
        renderSlot();
        expect(slotState()).toBeNull();
      },
    );

    it('a manually-entered event whose firstSetAt is the start of today opens NO review — no server reviewAt exists for it', () => {
      const startOfToday = new Date(NOW);
      startOfToday.setHours(0, 0, 0, 0);
      const manualToday = makeEntry({
        entryKey: 'today',
        eventName: 'Today Locals',
        source: 'manual',
        firstSetAt: startOfToday.getTime(),
        lastSetAt: startOfToday.getTime(),
      });
      withEntries([manualToday]);
      mockBriefs({ today: { activated: true } });
      renderSlot();

      expect(usePrepBrief).toHaveBeenCalledWith('today');
      expect(slotState()).toBeNull();
    });

    it('code review WEB-01: a PENDING review-status read renders nothing — never the add-event door the settled render would retract', () => {
      withEntries([pastEntry], 'prepare');
      mockBriefs({ past: 'pending' });
      renderSlot();
      expect(usePrepBrief).toHaveBeenCalledWith('past');
      expect(slotState()).toBeNull();
    });

    it('an ERRORED review-status read falls through to the next state, so a failing endpoint never hides the slot for good', () => {
      withEntries([pastEntry], 'prepare');
      mockBriefs({ past: 'error' });
      renderSlot();
      expect(slotState()).toBe('addEvent');
    });

    it('C1-H7: a past-dated ADMIN-IMPORTED entry never produces a review state, and its status is never read', () => {
      const importedRecent = makeEntry({
        entryKey: 'imported',
        eventName: 'Imported Major',
        firstSetAt: NOW - DAY_MS,
        lastSetAt: NOW - DAY_MS,
        origin: 'admin-imported',
      } as Partial<TournamentEntry> & { entryKey: string; origin: string });
      withEntries([importedRecent]);
      mockBriefs({ imported: inWindow });
      renderSlot();

      expect(slotState()).toBeNull();
      expect(usePrepBrief).not.toHaveBeenCalledWith('imported');
    });

    it('C1-H7: the origin check comes first — a MORE RECENT imported entry never displaces an older genuine one as the candidate', () => {
      const importedRecent = makeEntry({
        entryKey: 'imported',
        eventName: 'Imported Major',
        firstSetAt: NOW - DAY_MS,
        lastSetAt: NOW - DAY_MS,
        origin: 'admin-imported',
      } as Partial<TournamentEntry> & { entryKey: string; origin: string });
      withEntries([importedRecent, pastEntry]);
      mockBriefs({ imported: inWindow, past: inWindow });
      renderSlot();

      expect(slotState()).toBe('review');
      expect(screen.getByRole('link', { name: 'Review this event' })).toHaveAttribute(
        'href',
        '/tournaments/past/prep',
      );
      expect(usePrepBrief).not.toHaveBeenCalledWith('imported');
    });

    it('an entry with no usable end date leaves the slot in an existing state and renders no invalid date', () => {
      const undated = makeEntry({
        entryKey: 'undated',
        eventName: 'Undated Weekly',
        firstSetAt: 0,
        lastSetAt: 0,
      });
      withEntries([undated], 'prepare');
      mockBriefs({ undated: inWindow });
      const { container } = renderSlot();

      expect(slotState()).toBe('addEvent');
      expect(container.textContent).not.toMatch(/Invalid Date|NaN/);
      expect(usePrepBrief).not.toHaveBeenCalledWith('undated');
    });
  });
});

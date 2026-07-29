import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { TournamentEntry } from '@smash-tracker/shared';
import { DashboardPrepActionSlot } from './DashboardPrepActionSlot';

const useTournamentEntries = vi.fn();
vi.mock('@/hooks/useTournamentEntries', () => ({
  useTournamentEntries: () => useTournamentEntries(),
}));

const useProfile = vi.fn();
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => useProfile(),
}));

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
});

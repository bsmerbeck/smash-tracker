import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { toast } from 'sonner';
import { writeStoredDigest, analyticsDigestStorageKey } from '@/lib/analyticsDigest';
import { useDigest, type UseDigestResult } from '@/hooks/useDigest';
import { DigestCard } from './DigestCard';

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

let allMatches: Match[] = [];
vi.mock('@/hooks/useFilteredMatches', () => ({
  useFilteredMatches: () => ({ allMatches, isLoading: false, isFetching: false }),
}));

function digest(overrides: Partial<UseDigestResult> = {}): UseDigestResult {
  return {
    status: 'expanded',
    newGames: 41,
    newEvents: 2,
    since: Date.UTC(2026, 8, 21, 12),
    canMarkAsRead: true,
    markAsRead: vi.fn(),
    ...overrides,
  };
}

function renderCard(value: UseDigestResult) {
  return render(
    <MemoryRouter>
      <DigestCard digest={value} />
    </MemoryRouter>,
  );
}

describe('DigestCard states', () => {
  it('expanded: three counts, no deltas, the Mark as read button, the device note as a title', () => {
    const { container } = renderCard(digest());
    expect(container.querySelector('[data-slot="stat-row"]')).not.toBeNull();
    expect(screen.getByText('41')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('New games')).toBeInTheDocument();
    expect(screen.getByText('New events')).toBeInTheDocument();
    expect(screen.getByText('Tracked moved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: /since last visit/i })).toHaveAttribute(
      'title',
      'Read state is kept on this device.',
    );
    expect(screen.getByText(/^since /)).toBeInTheDocument();
  });

  it('quiet: the head and one muted line, with no button and no StatRow', () => {
    const { container } = renderCard(digest({ status: 'quiet', canMarkAsRead: false }));
    expect(container.querySelector('[data-slot="stat-row"]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-slot="insight-line"]')?.textContent).toMatch(
      /^Nothing new since .+\.$/,
    );
  });

  it('first visit: the start line with no button and no StatRow', () => {
    const { container } = renderCard(
      digest({ status: 'start', since: null, newGames: 0, newEvents: 0, canMarkAsRead: false }),
    );
    expect(container.querySelector('[data-slot="stat-row"]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(
      screen.getByText('Digest starts now — changes since this visit will show here.'),
    ).toBeInTheDocument();
  });

  it('loading: a skeleton, never zeros', () => {
    const { container } = renderCard(digest({ status: 'loading', newGames: 0, newEvents: 0 }));
    expect(container.querySelector('[data-slot="skeleton-block"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="stat-row"]')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('a disabled Mark as read does not act', async () => {
    const value = digest({ canMarkAsRead: false });
    renderCard(value);
    const button = screen.getByRole('button', { name: 'Mark as read' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(value.markAsRead).not.toHaveBeenCalled();
  });

  it('T-01: the reserved nudge slot renders after the summary when given, and nothing otherwise', () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <DigestCard digest={digest()} nudge={<p data-testid="nudge">later</p>} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('nudge')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <DigestCard digest={digest()} />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="nudge"]')).toBeNull();
  });
});

function Host() {
  return <DigestCard digest={useDigest()} />;
}

describe('DigestCard Mark as read (through the real hook)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    allMatches = Array.from({ length: 51 }, (_, i) => ({
      id: `g-${i}`,
      time: 10_000 + i,
      win: true,
      fighter_id: 1,
      opponent_id: 2,
    })) as Match[];
    writeStoredDigest('u1', null, { lastSeenAt: 5_000, lastSeenMatchCount: 10, tracked: {} });
  });

  it('reads 41 new games, then writes this device store once and collapses to the quiet line', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const { container } = render(
      <MemoryRouter>
        <Host />
      </MemoryRouter>,
    );
    expect(screen.getByText('41')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mark as read' }));

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]![0]).toBe(analyticsDigestStorageKey('u1', null));
    expect(toast).toHaveBeenCalledWith('Marked as read on this device.');
    expect(container.querySelector('[data-slot="stat-row"]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-slot="insight-line"]')?.textContent).toMatch(
      /^Nothing new since /,
    );
    set.mockRestore();
  });
});

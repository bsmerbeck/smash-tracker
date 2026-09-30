import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DigestMovedToken, Match } from '@smash-tracker/shared';
import { toast } from 'sonner';
import { writeStoredDigest, analyticsDigestStorageKey } from '@/lib/analyticsDigest';
import { useDigest, type UseDigestResult } from '@/hooks/useDigest';
import type { TrackedRowModel } from './trackedRowModel';
import { DigestCard } from './DigestCard';

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' } }) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

let allMatches: Match[] = [];
vi.mock('@/hooks/useFilteredMatches', () => ({
  useFilteredMatches: () => ({ allMatches, isLoading: false, isFetching: false }),
}));
vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: () => ({ data: { items: [] }, isSuccess: true, isError: false, isPending: false }),
}));
vi.mock('@/hooks/useOpponentAliases', () => ({ useOpponentAliases: () => ({ data: {} }) }));

function digest(overrides: Partial<UseDigestResult> = {}): UseDigestResult {
  return {
    status: 'expanded',
    newGames: 41,
    newEvents: 2,
    movedCount: 0,
    movedRows: [],
    moreCount: 0,
    movedByItemKey: new Map(),
    since: Date.UTC(2026, 8, 21, 12),
    visitLastSeenAt: null,
    snapshotReady: true,
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

function movedRow(index: number, token: DigestMovedToken): TrackedRowModel {
  return {
    itemKey: `opponent:rival${index}`,
    itemKeys: [`opponent:rival${index}`],
    kind: 'opponent',
    name: `Rival${index}`,
    href: `/opponents/rival${index}`,
    stageThumbUrl: null,
    stageName: null,
    wins: 14,
    losses: 22,
    total: 36,
    chip: null,
    recentWins: 8,
    recentLosses: 4,
    strip: [],
    movedToken: token,
  };
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

describe('DigestCard moved items (D-05, D-06)', () => {
  it('lists moved rows with their tokens, three counts and no "and more" link when five or fewer', () => {
    const rows = [movedRow(1, 'down'), movedRow(2, 'up'), movedRow(3, 'unlocked')];
    const { container } = renderCard(digest({ movedCount: 3, movedRows: rows }));
    const rendered = container.querySelectorAll('[data-slot="digest-moved-list"] > li');
    expect(rendered).toHaveLength(3);
    expect(rendered[0]?.textContent).toContain('moved — now trending down');
    expect(rendered[1]?.textContent).toContain('moved — now trending up');
    expect(rendered[2]?.textContent).toContain('moved — now enough games');
    expect(container.querySelector('[data-slot="digest-more"]')).toBeNull();
    // The moved figure is the count, not a dash.
    expect(container.querySelector('[data-slot="stat-row"]')?.textContent).toContain('3');
  });

  it('a seven-mover digest renders at most five rows and "and 2 more" targeting #tracked', () => {
    const rows = Array.from({ length: 5 }, (_, i) => movedRow(i + 1, 'up'));
    const { container } = renderCard(digest({ movedCount: 7, movedRows: rows, moreCount: 2 }));
    expect(container.querySelectorAll('[data-slot="digest-moved-list"] > li')).toHaveLength(5);
    const more = screen.getByRole('link', { name: 'and 2 more →' });
    expect(more).toHaveAttribute('href', '/dashboard#tracked');
  });

  it('new games but nothing moved says so in one muted line', () => {
    const { container } = renderCard(digest({ movedCount: 0 }));
    expect(container.querySelector('[data-slot="digest-none-moved"]')?.textContent).toBe(
      'No tracked item moved.',
    );
    expect(container.querySelector('[data-slot="digest-moved-list"]')).toBeNull();
  });

  it('while the tracked list is unresolved the moved figure is a dash and there is no moved line', () => {
    const { container } = renderCard(digest({ movedCount: null, canMarkAsRead: false }));
    expect(container.querySelector('[data-slot="digest-none-moved"]')).toBeNull();
    expect(container.querySelector('[data-slot="digest-moved-list"]')).toBeNull();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeDisabled();
  });

  it('the moved rows navigate: each row is a link to the item surface', () => {
    renderCard(digest({ movedCount: 1, movedRows: [movedRow(1, 'down')] }));
    const link = screen.getByRole('link', { name: /Rival1/ });
    expect(link).toHaveAttribute('href', '/opponents/rival1');
    expect(link.getAttribute('aria-label')).toContain('moved — now trending down');
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

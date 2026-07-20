import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import { ApiError } from '@/lib/api';
import { ReviewDeliveryPage } from './ReviewDeliveryPage';

const getDelivery = vi.fn();
const ackDelivery = vi.fn();
const markViewedDelivery = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      reviewDeliveries: {
        get: (...args: unknown[]) => getDelivery(...args),
        ack: (...args: unknown[]) => ackDelivery(...args),
        markViewed: (...args: unknown[]) => markViewedDelivery(...args),
      },
    },
  };
});

// A trivial stand-in mirroring ReviewComposerPage.test.tsx's own
// VodPlayer mock — this page's own citation seek-vs-switch logic (D-04) is
// what's under test here, not the real YouTube/Twitch embed (already
// covered by useVodPlayer.test.ts / VodManagerPage.test.tsx). `seekRef` is
// assigned synchronously during render (mirrors the real `VodPlayer`'s own
// `useEffect(() => { seekRef.current = seek })` closely enough for a mock).
const seekMock = vi.fn();
vi.mock('@/pages/VodManager/components/VodPlayer', () => ({
  VodPlayer: ({
    vodUrl,
    startSeconds,
    onReady,
    seekRef,
  }: {
    vodUrl: string;
    startSeconds?: number;
    onReady?: () => void;
    seekRef?: { current: ((seconds: number) => void) | null };
  }) => {
    if (seekRef) {
      seekRef.current = (seconds: number) => seekMock(vodUrl, seconds);
    }
    return (
      <div data-testid="vod-player" data-vod-url={vodUrl} data-start-seconds={startSeconds ?? ''}>
        <button type="button" onClick={onReady}>
          mock-ready
        </button>
      </div>
    );
  },
}));

function baseSnapshot(overrides: Partial<PublicShareSnapshot> = {}): PublicShareSnapshot {
  return {
    createdAt: 1_700_000_000_000,
    kind: 'coachReview',
    coachDisplayName: 'Coach Brendan',
    reviewPublishedAt: 1_700_000_000_000,
    sections: [
      {
        id: 'summary',
        kind: 'summary',
        title: null,
        body: 'Strong week overall.',
      },
      {
        id: 'priorities',
        kind: 'priorities',
        title: null,
        body:
          '1. Ledgetraps: {{cite:matchId=m1;seconds=42;label=missed%20ledgetrap}}\n' +
          '2. Roll habit: {{cite:matchId=m2;seconds=10;label=roll%20habit}}',
      },
    ],
    citationSources: [
      { sourceVodRef: 'm1', vodUrl: 'https://youtu.be/aaa111' },
      { sourceVodRef: 'm2', vodUrl: 'https://youtu.be/bbb222' },
    ],
    reviewedMomentsCount: 2,
    ...overrides,
  } as PublicShareSnapshot;
}

function renderDelivery(initialEntry = '/r/tok123') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/r/:token" element={<ReviewDeliveryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReviewDeliveryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    ackDelivery.mockResolvedValue({ acknowledged: true });
    markViewedDelivery.mockResolvedValue({ viewed: true });
  });

  it('renders coach identity, publication date, the now-playing source, and the delivered sections', async () => {
    getDelivery.mockResolvedValue(baseSnapshot());

    renderDelivery();

    expect(await screen.findByText('Review from Coach Brendan')).toBeInTheDocument();
    expect(screen.getByText(/Published/)).toBeInTheDocument();
    expect(screen.getByText('Now playing')).toBeInTheDocument();
    expect(screen.getByTestId('vod-player')).toHaveAttribute(
      'data-vod-url',
      'https://youtu.be/aaa111',
    );
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Priorities' })).toBeInTheDocument();
    expect(screen.getByText('Strong week overall.')).toBeInTheDocument();
  });

  it('renders the friendly unavailable page for a 404 (unknown/revoked token), leaking nothing', async () => {
    getDelivery.mockRejectedValue(new ApiError(404, 'This delivery is no longer available'));

    renderDelivery('/r/dead-token');

    expect(await screen.findByText('This review is no longer available')).toBeInTheDocument();
    expect(screen.queryByText('Now playing')).not.toBeInTheDocument();
  });

  it('a same-source citation click seeks the already-mounted player without switching source', async () => {
    getDelivery.mockResolvedValue(baseSnapshot());
    const user = userEvent.setup();
    renderDelivery();

    await screen.findByTestId('vod-player');
    const sameSourceChip = await screen.findByRole('button', {
      name: 'Jump to 0:42: missed ledgetrap',
    });
    await user.click(sameSourceChip);

    expect(seekMock).toHaveBeenCalledWith('https://youtu.be/aaa111', 42);
    // Still the same source — no reconstruction.
    expect(screen.getByTestId('vod-player')).toHaveAttribute(
      'data-vod-url',
      'https://youtu.be/aaa111',
    );
  });

  it('a cross-source citation click switches the embedded source AND seeks to the cited second (D-04)', async () => {
    getDelivery.mockResolvedValue(baseSnapshot());
    const user = userEvent.setup();
    renderDelivery();

    await screen.findByTestId('vod-player');
    const crossSourceChip = await screen.findByRole('button', {
      name: 'Jump to 0:10 in Source 2: roll habit',
    });
    await user.click(crossSourceChip);

    await waitFor(() =>
      expect(screen.getByTestId('vod-player')).toHaveAttribute(
        'data-vod-url',
        'https://youtu.be/bbb222',
      ),
    );
    expect(screen.getByTestId('vod-player')).toHaveAttribute('data-start-seconds', '10');
    expect(await screen.findByText('Source 2')).toBeInTheDocument();
  });

  it('Acknowledge posts the ack and shows a persistent confirmation', async () => {
    getDelivery.mockResolvedValue(baseSnapshot());
    const user = userEvent.setup();
    renderDelivery();

    const ackButton = await screen.findByRole('button', { name: '✓ Acknowledge' });
    await user.click(ackButton);

    expect(ackDelivery).toHaveBeenCalledWith('tok123');
    expect(await screen.findByText('Acknowledged')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '✓ Acknowledge' })).not.toBeInTheDocument();
  });

  it('the acknowledged confirmation survives a remount (persisted per-token, per-browser)', async () => {
    getDelivery.mockResolvedValue(baseSnapshot());
    const user = userEvent.setup();
    const { unmount } = renderDelivery();

    await user.click(await screen.findByRole('button', { name: '✓ Acknowledge' }));
    await screen.findByText('Acknowledged');
    unmount();

    renderDelivery();
    expect(await screen.findByText('Acknowledged')).toBeInTheDocument();
    // A remount never re-fires the ack POST.
    expect(ackDelivery).toHaveBeenCalledTimes(1);
  });

  it('does not fire the Viewed transition on snapshot resolve alone (player not yet ready)', async () => {
    getDelivery.mockResolvedValue(baseSnapshot());

    renderDelivery();

    await screen.findByTestId('vod-player');
    expect(markViewedDelivery).not.toHaveBeenCalled();
  });

  it('fires the Viewed transition exactly once, only after the player reports ready', async () => {
    getDelivery.mockResolvedValue(baseSnapshot());
    renderDelivery();

    const readyButton = await screen.findByRole('button', { name: 'mock-ready' });
    expect(markViewedDelivery).not.toHaveBeenCalled();

    act(() => {
      readyButton.click();
    });
    await waitFor(() => expect(markViewedDelivery).toHaveBeenCalledExactlyOnceWith('tok123'));

    // A later ready re-fire never double-fires (fire-once ref).
    act(() => {
      readyButton.click();
    });
    expect(markViewedDelivery).toHaveBeenCalledTimes(1);
  });

  it('fires the Viewed transition immediately for a review with no cited VOD at all (no isReady gate to wait on)', async () => {
    getDelivery.mockResolvedValue(baseSnapshot({ citationSources: undefined }));
    renderDelivery();

    await screen.findByText("This review doesn't cite any footage.");
    await waitFor(() => expect(markViewedDelivery).toHaveBeenCalledExactlyOnceWith('tok123'));
  });
});

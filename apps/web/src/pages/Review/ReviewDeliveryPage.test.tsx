import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import { ApiError } from '@/lib/api';
import {
  ONBOARDING_ORIGIN_STORAGE_KEY,
  read as readOnboardingOrigin,
} from '@/lib/onboardingOrigin';
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
// VodPlayer mock — this page's own citation seek-vs-switch logic (D-04) and
// `DeliveryVodNotesTab`'s switch logic are what's under test here, not the
// real YouTube/Twitch embed (already covered by useVodPlayer.test.ts /
// VodManagerPage.test.tsx). `seekRef` is assigned synchronously during
// render (mirrors the real `VodPlayer`'s own
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

/** The two tab panels, in JSX order (VOD Notes, Review Notes) — Phase 21
 * Plan 02's Review Notes panel is `forceMount`-ed (so its player can fire
 * `onReady` for the crawler-safe Viewed gate regardless of which tab is
 * visually active), so BOTH panels are simultaneously present in the DOM;
 * every player/section query in these tests scopes into the specific panel
 * it cares about via `within(...)` rather than a bare `screen.getBy...`. */
function tabPanels() {
  return screen.getAllByRole('tabpanel', { hidden: true });
}
function vodNotesPanel() {
  return tabPanels()[0]!;
}
function reviewNotesPanel() {
  return tabPanels()[1]!;
}

async function switchToReviewNotesTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Review Notes' }));
}

describe('ReviewDeliveryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    ackDelivery.mockResolvedValue({ acknowledged: true });
    markViewedDelivery.mockResolvedValue({ viewed: true });
  });

  it('renders coach identity, publication date, and the explanation ahead of the two-tab shell', async () => {
    getDelivery.mockResolvedValue(baseSnapshot());

    renderDelivery();

    expect(await screen.findByText('Review from Coach Brendan')).toBeInTheDocument();
    expect(screen.getByText(/Published/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Watch the referenced footage with click-to-seek notes in the VOD Notes tab, or read the full write-up in the Review Notes tab — no account needed to view this link.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'VOD Notes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Review Notes' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('renders the friendly unavailable page for a 404 (unknown/revoked token), leaking nothing', async () => {
    getDelivery.mockRejectedValue(new ApiError(404, 'This delivery is no longer available'));

    renderDelivery('/r/dead-token');

    expect(await screen.findByText('This review is no longer available')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'VOD Notes' })).not.toBeInTheDocument();
  });

  describe('VOD Notes tab (DLVX-01/02, active by default)', () => {
    it('falls back to the citationSources-derived VODs when the delivery has no frozen includedVods (T-21-06)', async () => {
      getDelivery.mockResolvedValue(baseSnapshot());

      renderDelivery();

      await screen.findByRole('tab', { name: 'VOD Notes' });
      const panel = vodNotesPanel();
      expect(within(panel).getByText('Now playing')).toBeInTheDocument();
      expect(within(panel).getByTestId('vod-player')).toHaveAttribute(
        'data-vod-url',
        'https://youtu.be/aaa111',
      );
      // 2 citationSources -> a switcher between the two fallback "sources".
      expect(within(panel).getByRole('combobox')).toBeInTheDocument();
    });

    it('renders the delivery-specific frozen includedVods when present, in preference to the citationSources fallback', async () => {
      getDelivery.mockResolvedValue(
        baseSnapshot({
          includedVods: [
            {
              matchId: 'm9',
              label: 'Frozen matchup',
              vodUrl: 'https://youtu.be/ccc333',
              timestamps: [{ seconds: 5, note: 'frozen note' }],
            },
          ],
        }),
      );

      renderDelivery();

      await screen.findByRole('tab', { name: 'VOD Notes' });
      const panel = vodNotesPanel();
      expect(within(panel).getByTestId('vod-player')).toHaveAttribute(
        'data-vod-url',
        'https://youtu.be/ccc333',
      );
      expect(within(panel).getByText('Frozen matchup')).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: /frozen note/ })).toBeInTheDocument();
      // A single VOD -> no switcher.
      expect(within(panel).queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('shows its own empty state when both includedVods and citationSources are empty', async () => {
      getDelivery.mockResolvedValue(baseSnapshot({ citationSources: [], sections: [] }));

      renderDelivery();

      await screen.findByRole('tab', { name: 'VOD Notes' });
      expect(
        within(vodNotesPanel()).getByText('No footage was included with this delivery.'),
      ).toBeInTheDocument();
      expect(within(vodNotesPanel()).queryByTestId('vod-player')).not.toBeInTheDocument();
    });
  });

  describe('Review Notes tab (the existing published-review render, unchanged behavior)', () => {
    it('renders the delivered sections and the now-playing citation source, gated on citationSources.length > 0', async () => {
      getDelivery.mockResolvedValue(baseSnapshot());
      const user = userEvent.setup();
      renderDelivery();

      await switchToReviewNotesTab(user);

      const panel = reviewNotesPanel();
      expect(within(panel).getByText('Now playing')).toBeInTheDocument();
      expect(within(panel).getByTestId('vod-player')).toHaveAttribute(
        'data-vod-url',
        'https://youtu.be/aaa111',
      );
      expect(within(panel).getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
      expect(within(panel).getByRole('heading', { name: 'Priorities' })).toBeInTheDocument();
      expect(within(panel).getByText('Strong week overall.')).toBeInTheDocument();
    });

    it('a same-source citation click seeks the already-mounted player without switching source', async () => {
      getDelivery.mockResolvedValue(baseSnapshot());
      const user = userEvent.setup();
      renderDelivery();

      await switchToReviewNotesTab(user);
      const panel = reviewNotesPanel();
      const sameSourceChip = await within(panel).findByRole('button', {
        name: 'Jump to 0:42: missed ledgetrap',
      });
      await user.click(sameSourceChip);

      expect(seekMock).toHaveBeenCalledWith('https://youtu.be/aaa111', 42);
      // Still the same source — no reconstruction.
      expect(within(panel).getByTestId('vod-player')).toHaveAttribute(
        'data-vod-url',
        'https://youtu.be/aaa111',
      );
    });

    it('a cross-source citation click switches the embedded source AND seeks to the cited second (D-04)', async () => {
      getDelivery.mockResolvedValue(baseSnapshot());
      const user = userEvent.setup();
      renderDelivery();

      await switchToReviewNotesTab(user);
      const panel = reviewNotesPanel();
      const crossSourceChip = await within(panel).findByRole('button', {
        name: 'Jump to 0:10 in Source 2: roll habit',
      });
      await user.click(crossSourceChip);

      await waitFor(() =>
        expect(within(panel).getByTestId('vod-player')).toHaveAttribute(
          'data-vod-url',
          'https://youtu.be/bbb222',
        ),
      );
      expect(within(panel).getByTestId('vod-player')).toHaveAttribute('data-start-seconds', '10');
      expect(within(panel).getByText('Source 2')).toBeInTheDocument();
    });

    // REV-01: a review with zero VOD sources (no citations anywhere in its
    // sections) must render cleanly on the anonymous recipient page — the
    // noSource copy in place of the player, no empty player shell, and the
    // sections themselves still rendering below.
    it('REV-01: renders the noSource copy with no video/player element, while sections still render below, for a zero-citation-source delivery', async () => {
      getDelivery.mockResolvedValue(
        baseSnapshot({
          citationSources: [],
          sections: [
            { id: 'summary', kind: 'summary', title: null, body: 'No footage cited this cycle.' },
          ],
        }),
      );
      const user = userEvent.setup();
      renderDelivery();

      await switchToReviewNotesTab(user);
      const panel = reviewNotesPanel();
      expect(within(panel).getByText("This review doesn't cite any footage.")).toBeInTheDocument();
      expect(within(panel).queryByTestId('vod-player')).not.toBeInTheDocument();
      expect(within(panel).getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
      expect(within(panel).getByText('No footage cited this cycle.')).toBeInTheDocument();
    });
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

    await screen.findAllByTestId('vod-player');
    expect(markViewedDelivery).not.toHaveBeenCalled();
  });

  it('fires the Viewed transition exactly once, only after the (forceMount-ed) Review Notes player reports ready, regardless of which tab is visually active', async () => {
    getDelivery.mockResolvedValue(baseSnapshot());
    renderDelivery();

    await screen.findByRole('tab', { name: 'VOD Notes' });
    // The Review Notes tab is NOT the visually active tab here — proving the
    // Viewed transition still fires without the recipient ever clicking it.
    const readyButton = within(reviewNotesPanel()).getByRole('button', { name: 'mock-ready' });
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

    await screen.findByRole('tab', { name: 'VOD Notes' });
    await waitFor(() => expect(markViewedDelivery).toHaveBeenCalledExactlyOnceWith('tok123'));
  });

  describe('signup CTA (ONBD-01/D-02 — a net-new element this page had none of before)', () => {
    it('renders a signup CTA on the success path', async () => {
      getDelivery.mockResolvedValue(baseSnapshot());
      renderDelivery();

      expect(await screen.findByRole('link', { name: 'Get started free' })).toBeInTheDocument();
    });

    it('stamps the onboardingOrigin as kind coachReview with the current /r/:token path on CTA click, distinct from shareReferral', async () => {
      getDelivery.mockResolvedValue(baseSnapshot());
      const user = userEvent.setup();
      renderDelivery('/r/tok123');

      const ctaLink = await screen.findByRole('link', { name: 'Get started free' });
      await user.click(ctaLink);

      expect(readOnboardingOrigin()).toMatchObject({
        kind: 'coachReview',
        returnPath: '/r/tok123',
      });
      // Never the referral bridge's own key — the two layers stay separate.
      expect(window.localStorage.getItem(ONBOARDING_ORIGIN_STORAGE_KEY)).not.toBeNull();
      expect(window.localStorage.getItem('smash-tracker.shareReferral')).toBeNull();
    });
  });

  describe('kind "session" (Phase 20 Plan 04 origin, restructured into the SAME two-tab shell by Phase 21 Plan 02)', () => {
    function sessionSnapshot(overrides: Partial<PublicShareSnapshot> = {}): PublicShareSnapshot {
      return {
        createdAt: 1_700_000_000_000,
        kind: 'session',
        coachDisplayName: 'Coach Brendan',
        sessionDate: 1_700_000_000_000,
        sessionCharacterTags: [8],
        sessionSummary: 'Worked on neutral game and ledgetraps.',
        sessionHomework: [
          { text: 'Practice ledgetraps', done: true },
          { text: 'Fix roll habit', done: false },
        ],
        includedVods: [
          { matchId: 'm1', label: 'Fox vs Falco', vodUrl: 'https://youtu.be/session111' },
        ],
        reviewedMomentsCount: 0,
        ...overrides,
      } as PublicShareSnapshot;
    }

    it('renders the two-tab shell — VOD Notes over includedVods, Review Notes with the summary and homework list', async () => {
      getDelivery.mockResolvedValue(sessionSnapshot());
      const user = userEvent.setup();

      renderDelivery();

      expect(await screen.findByText('Training session from Coach Brendan')).toBeInTheDocument();
      expect(screen.getByText('Fox')).toBeInTheDocument();

      // VOD Notes tab is active by default.
      const vodPanel = vodNotesPanel();
      expect(within(vodPanel).getByTestId('vod-player')).toHaveAttribute(
        'data-vod-url',
        'https://youtu.be/session111',
      );

      await user.click(screen.getByRole('tab', { name: 'Review Notes' }));
      expect(screen.getByText('Worked on neutral game and ledgetraps.')).toBeInTheDocument();
      expect(screen.getByText('Practice ledgetraps')).toBeInTheDocument();
      expect(screen.getByText('Fix roll habit')).toBeInTheDocument();
    });

    it('never renders the coachReview-only Acknowledge control or fires the Viewed transition', async () => {
      getDelivery.mockResolvedValue(sessionSnapshot());

      renderDelivery();

      await screen.findByText('Training session from Coach Brendan');
      expect(screen.queryByRole('button', { name: '✓ Acknowledge' })).not.toBeInTheDocument();
      expect(markViewedDelivery).not.toHaveBeenCalled();
    });

    it('shows the empty-homework copy, and the VOD Notes empty state, when both are absent', async () => {
      const user = userEvent.setup();
      getDelivery.mockResolvedValue(sessionSnapshot({ sessionHomework: [], includedVods: [] }));

      renderDelivery();

      await screen.findByText('Training session from Coach Brendan');
      expect(screen.getByText('No footage was included with this delivery.')).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: 'Review Notes' }));
      expect(await screen.findByText('No homework this session.')).toBeInTheDocument();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import type { YouTubePlayerConfig, YouTubePlayerInstance } from '@/lib/useVodPlayer';
import { ApiError } from '@/lib/api';
import { logProductEvent } from '@/lib/firebase';
import { stamp } from '@/lib/shareReferral';
import { ShareViewPage } from './ShareViewPage';

const getPublic = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      vodShares: {
        getPublic: (...args: unknown[]) => getPublic(...args),
      },
    },
  };
});

vi.mock('@/lib/firebase', () => ({
  logProductEvent: vi.fn(),
}));

vi.mock('@/lib/shareReferral', () => ({
  stamp: vi.fn(),
  read: vi.fn(() => null),
  clear: vi.fn(),
}));

type YTGlobal = NonNullable<Window['YT']>;

/** Removes any injected vendor scripts/globals so `useVodPlayer`'s module-level singleton loaders start clean for every test — mirrors `VodManagerPage.test.tsx`'s convention. */
function resetVendorGlobals() {
  document.head.querySelectorAll('script').forEach((el) => el.remove());
  delete (window as { YT?: unknown }).YT;
  delete (window as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
}

function baseSnapshot(overrides: Partial<PublicShareSnapshot> = {}): PublicShareSnapshot {
  return {
    createdAt: 1_700_000_000_000,
    result: 'win',
    fighterId: 1, // Mario
    opponentFighterId: 10, // Luigi
    stage: { id: 1, name: 'Battlefield' },
    matchDate: 1_700_000_000_000,
    vodUrl: 'https://youtube.com/watch?v=abc123',
    vodStartSeconds: 0,
    reviewedMomentsCount: 2,
    timestamps: [
      { seconds: 10, note: 'First punish' },
      { seconds: 83, note: 'Great edgeguard' },
    ],
    tags: ['neutral'],
    ownerDisplayName: 'TestPlayer',
    redaction: { includedNotes: true, includedTags: true, showDisplayName: true },
    ...overrides,
  };
}

function baseRecapSnapshot(overrides: Partial<PublicShareSnapshot> = {}): PublicShareSnapshot {
  return {
    createdAt: 1_700_000_000_000,
    kind: 'recap',
    recapSource: 'startgg',
    tournamentName: 'Genesis 10',
    tournamentDate: 1_700_000_000_000,
    placement: 3,
    seed: 5,
    numEntrants: 128,
    setRecordWins: 4,
    setRecordLosses: 1,
    notableWinOpponentName: 'MkLeo',
    notableWinOpponentSeed: 1,
    characterFighterIds: [1, 10],
    reviewedMomentsCount: 2,
    ownerDisplayName: 'TestPlayer',
    ...overrides,
  };
}

function renderShare(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/s/:token" element={<ShareViewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mountYouTubePlayer(overrides: Partial<YouTubePlayerInstance> = {}) {
  let capturedConfig: YouTubePlayerConfig | undefined;
  const seekTo = vi.fn();
  const playVideo = vi.fn();
  const Player = vi.fn(function (
    this: unknown,
    _el: HTMLElement,
    config: YouTubePlayerConfig,
  ): YouTubePlayerInstance {
    capturedConfig = config;
    return {
      seekTo,
      playVideo,
      pauseVideo: vi.fn(),
      destroy: vi.fn(),
      getCurrentTime: vi.fn(() => 0),
      ...overrides,
    };
  });
  window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };
  return { Player, seekTo, playVideo, getConfig: () => capturedConfig };
}

describe('ShareViewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVendorGlobals();
  });

  afterEach(() => {
    resetVendorGlobals();
  });

  it('renders the header (fighters, reviewed-moments count) and the player container for an active snapshot', async () => {
    getPublic.mockResolvedValue(baseSnapshot());
    const { Player } = mountYouTubePlayer();

    renderShare('/s/tok123');

    expect(await screen.findByText(/Mario vs\. Luigi/)).toBeInTheDocument();
    expect(screen.getByText('2 reviewed moments')).toBeInTheDocument();
    expect(screen.getByText('Shared by TestPlayer')).toBeInTheDocument();
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
  });

  it('clicking a timestamp row seeks the player and highlights that row (no mutation, no API write)', async () => {
    getPublic.mockResolvedValue(baseSnapshot());
    const { Player, seekTo, playVideo, getConfig } = mountYouTubePlayer();
    const user = userEvent.setup();

    renderShare('/s/tok123');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      getConfig()?.events?.onReady?.();
    });

    const noteText = await screen.findByText('First punish');
    const row = noteText.closest('button');
    expect(row).not.toBeNull();
    await user.click(row!);

    expect(seekTo).toHaveBeenCalledWith(10, true);
    expect(playVideo).toHaveBeenCalled();
    expect(row).toHaveClass('bg-accent');
    // Read-only: exactly one call ever reaches the API (the initial GET) —
    // clicking a row never fires a second request.
    expect(getPublic).toHaveBeenCalledTimes(1);
  });

  it('seeks to and highlights the matching row for a ?t= deep link once the player is ready (VIEW-03)', async () => {
    getPublic.mockResolvedValue(baseSnapshot());
    const { Player, seekTo, getConfig } = mountYouTubePlayer();

    renderShare('/s/tok123?t=1:23');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      getConfig()?.events?.onReady?.();
    });

    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(83, true));
    const noteText = await screen.findByText('Great edgeguard');
    expect(noteText.closest('button')).toHaveClass('bg-accent');
  });

  it('renders the friendly unavailable page for a 404 (revoked or unknown token), leaking nothing (VIEW-05)', async () => {
    getPublic.mockRejectedValue(new ApiError(404, 'This share is no longer available'));

    const { unmount } = renderShare('/s/dead-token');

    expect(await screen.findByText('This review is no longer available')).toBeInTheDocument();
    const unknownTokenBody = screen.getByText(
      'The link may have been revoked, or it never existed.',
    );
    expect(unknownTokenBody).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to grandfinals.gg' })).toHaveAttribute('href', '/');

    // No oracle: an identical 404 body (per the API's own no-oracle guarantee,
    // see 06-01) renders the EXACT same page for a revoked token as for an
    // unknown one — nothing client-side ever branches on which case it was.
    unmount();
    getPublic.mockRejectedValue(new ApiError(404, 'This share is no longer available'));
    renderShare('/s/revoked-token');
    expect(await screen.findByText('This review is no longer available')).toBeInTheDocument();
    expect(
      screen.getByText('The link may have been revoked, or it never existed.'),
    ).toBeInTheDocument();
  });

  it('renders the "review your own set" CTA linking home (VIEW-04)', async () => {
    getPublic.mockResolvedValue(baseSnapshot());
    mountYouTubePlayer();

    renderShare('/s/tok123');

    expect(await screen.findByText('Review your own set')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get started free' })).toHaveAttribute('href', '/');
  });

  it('renders RecapView (tournament name + set record, no player) for a kind: recap snapshot', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot());

    renderShare('/s/tok123');

    expect(await screen.findByText('Genesis 10')).toBeInTheDocument();
    expect(screen.getByText('4–1 set record')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('renders a Download button linking to the og.png asset with the download attribute for a recap snapshot', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot());

    renderShare('/s/tok123');

    const downloadLink = await screen.findByRole('link', { name: /Download image/ });
    expect(downloadLink).toHaveAttribute('href', '/s/tok123/og.png');
    expect(downloadLink).toHaveAttribute('download');
  });

  it('renders the Set timeline section (round label, opponent + placement, score, stage chips) when sets are present (07-09)', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        detail: 'full',
        sets: [
          {
            roundLabel: 'Winners Round 3',
            opponentName: 'RivalTag',
            opponentPlacement: 17,
            wins: 3,
            losses: 1,
            win: true,
            stages: ['Battlefield', "Yoshi's Story"],
          },
          {
            roundLabel: 'Grand Finals',
            opponentName: 'MkLeo',
            wins: 1,
            losses: 3,
            win: false,
          },
        ],
      }),
    );

    renderShare('/s/tok123');

    expect(await screen.findByText('Set timeline')).toBeInTheDocument();
    expect(screen.getByText('Winners Round 3')).toBeInTheDocument();
    expect(screen.getByText('RivalTag · 17th')).toBeInTheDocument();
    expect(screen.getByText('3–1')).toBeInTheDocument();
    expect(screen.getByText('Battlefield')).toBeInTheDocument();
    expect(screen.getByText("Yoshi's Story")).toBeInTheDocument();
    // Second set has no opponentPlacement — bare opponent tag, no ordinal.
    expect(screen.getByText('MkLeo')).toBeInTheDocument();
    expect(screen.getByText('1–3')).toBeInTheDocument();
  });

  it('renders per-game sprite pairs + stage chips for a set carrying games (07-10 walkthrough amendment round 2)', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        detail: 'full',
        sets: [
          {
            roundLabel: 'Winners Round 3',
            opponentName: 'RivalTag',
            wins: 2,
            losses: 1,
            win: true,
            games: [
              { fighterId: 1, opponentFighterId: 10, stageName: 'Battlefield', win: true },
              { fighterId: 1, opponentFighterId: 10, stageName: "Yoshi's Story", win: false },
              { fighterId: 1, opponentFighterId: 10, stageName: 'Battlefield', win: true },
            ],
          },
        ],
      }),
    );

    renderShare('/s/tok123');

    const heading = await screen.findByText('Set timeline');
    const timelineSection = heading.closest('div')!;
    // Sprite images for each game (Mario=fighter 1, Luigi=fighter 10) —
    // scoped to the set-timeline section since the top "Characters played"
    // section above it also renders a Mario/Luigi sprite each.
    expect(within(timelineSection).getAllByAltText('Mario')).toHaveLength(3);
    expect(within(timelineSection).getAllByAltText('Luigi')).toHaveLength(3);
    // Stage chips per game.
    expect(within(timelineSection).getAllByText('Battlefield')).toHaveLength(2);
    expect(within(timelineSection).getByText("Yoshi's Story")).toBeInTheDocument();
  });

  it('falls back to the old set-level stage-chip row for a pre-07-10 set with no games array (backward compatible)', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        detail: 'full',
        sets: [
          {
            roundLabel: 'Winners Round 3',
            opponentName: 'RivalTag',
            wins: 3,
            losses: 1,
            win: true,
            stages: ['Battlefield', "Yoshi's Story"],
          },
        ],
      }),
    );

    renderShare('/s/tok123');

    const heading = await screen.findByText('Set timeline');
    const timelineSection = heading.closest('div')!;
    expect(within(timelineSection).getByText('Battlefield')).toBeInTheDocument();
    expect(within(timelineSection).getByText("Yoshi's Story")).toBeInTheDocument();
    // No per-game sprites are rendered for a set with no `games` array.
    expect(within(timelineSection).queryByAltText('Mario')).not.toBeInTheDocument();
  });

  it('renders the opponent tag as an external link when opponentUrl is present (start.gg, 07-11 walkthrough round 3)', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        detail: 'full',
        sets: [
          {
            roundLabel: 'Winners Round 3',
            opponentName: 'RivalTag',
            wins: 3,
            losses: 1,
            win: true,
            opponentUrl: 'https://start.gg/user/07dc2239',
          },
        ],
      }),
    );

    renderShare('/s/tok123');

    const opponentLink = await screen.findByRole('link', { name: 'View RivalTag on start.gg' });
    expect(opponentLink).toHaveAttribute('href', 'https://start.gg/user/07dc2239');
    expect(opponentLink).toHaveAttribute('target', '_blank');
    expect(opponentLink).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders the opponent tag as a parry.gg external link when recapSource is parrygg', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        recapSource: 'parrygg',
        detail: 'full',
        sets: [
          {
            roundLabel: 'Winners Round 3',
            opponentName: 'RivalTag',
            wins: 3,
            losses: 1,
            win: true,
            opponentUrl: 'https://parry.gg/profile/3f9a1c2e-1234-4abc-89ef-abcdef012345',
          },
        ],
      }),
    );

    renderShare('/s/tok123');

    const opponentLink = await screen.findByRole('link', { name: 'View RivalTag on parry.gg' });
    expect(opponentLink).toHaveAttribute(
      'href',
      'https://parry.gg/profile/3f9a1c2e-1234-4abc-89ef-abcdef012345',
    );
  });

  it('renders a set-page link when setUrl is present (start.gg only)', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        detail: 'full',
        sets: [
          {
            roundLabel: 'Winners Round 3',
            opponentName: 'RivalTag',
            wins: 3,
            losses: 1,
            win: true,
            setUrl:
              'https://start.gg/tournament/genesis-10/event/ultimate-singles/set/12345/summary',
          },
        ],
      }),
    );

    renderShare('/s/tok123');

    const setLink = await screen.findByRole('link', { name: 'View Winners Round 3 on start.gg' });
    expect(setLink).toHaveAttribute(
      'href',
      'https://start.gg/tournament/genesis-10/event/ultimate-singles/set/12345/summary',
    );
    expect(setLink).toHaveAttribute('target', '_blank');
    expect(setLink).toHaveAttribute('rel', 'noreferrer');
  });

  it('omits the opponent/set external-link affordances entirely when opponentUrl/setUrl are absent', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        detail: 'full',
        sets: [
          {
            roundLabel: 'Winners Round 3',
            opponentName: 'RivalTag',
            wins: 3,
            losses: 1,
            win: true,
          },
        ],
      }),
    );

    renderShare('/s/tok123');

    await screen.findByText('Set timeline');
    expect(screen.queryByRole('link', { name: /View RivalTag/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View Winners Round 3/ })).not.toBeInTheDocument();
  });

  it('omits the Set timeline section entirely for a "summary" recap (no sets)', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot());

    renderShare('/s/tok123');

    await screen.findByText('Genesis 10');
    expect(screen.queryByText('Set timeline')).not.toBeInTheDocument();
  });

  it('renders a "View bracket on start.gg" link when tournamentUrl is present (recapSource startgg)', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        tournamentUrl: 'https://start.gg/tournament/genesis-10/event/ultimate-singles',
      }),
    );

    renderShare('/s/tok123');

    const bracketLink = await screen.findByRole('link', { name: /View bracket on start\.gg/ });
    expect(bracketLink).toHaveAttribute(
      'href',
      'https://start.gg/tournament/genesis-10/event/ultimate-singles',
    );
    expect(bracketLink).toHaveAttribute('target', '_blank');
    expect(bracketLink).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders a "View bracket on parry.gg" link when recapSource is parrygg', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        recapSource: 'parrygg',
        tournamentUrl: 'https://example.com/some-verified-parrygg-url',
      }),
    );

    renderShare('/s/tok123');

    expect(
      await screen.findByRole('link', { name: /View bracket on parry\.gg/ }),
    ).toBeInTheDocument();
  });

  it('omits the bracket-link button entirely when tournamentUrl is absent', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot());

    renderShare('/s/tok123');

    await screen.findByText('Genesis 10');
    expect(screen.queryByText(/View bracket on/)).not.toBeInTheDocument();
  });

  it('omits the reviewed-moments line for a recap snapshot with a zero count', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot({ reviewedMomentsCount: 0 }));

    renderShare('/s/tok123');

    await screen.findByText('Genesis 10');
    expect(screen.queryByText(/reviewed moment/)).not.toBeInTheDocument();
  });

  it('renders the reviewed-moments line for a recap snapshot with a positive count', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot({ reviewedMomentsCount: 3 }));

    renderShare('/s/tok123');

    expect(await screen.findByText('3 reviewed moments')).toBeInTheDocument();
  });

  it('still renders the player for a vod-review snapshot (kind absent) — regression', async () => {
    getPublic.mockResolvedValue(baseSnapshot());
    const { Player } = mountYouTubePlayer();

    renderShare('/s/tok123');

    expect(await screen.findByText(/Mario vs\. Luigi/)).toBeInTheDocument();
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
  });

  it('fires share_opened (share_kind: review) and stamps the referral bridge once a vod-review snapshot resolves (FUNNEL-01/02)', async () => {
    getPublic.mockResolvedValue(baseSnapshot());
    mountYouTubePlayer();

    renderShare('/s/tok123');

    await screen.findByText(/Mario vs\. Luigi/);
    expect(logProductEvent).toHaveBeenCalledExactlyOnceWith('share_opened', {
      share_kind: 'review',
    });
    expect(stamp).toHaveBeenCalledExactlyOnceWith('tok123');
  });

  it('fires share_opened (share_kind: recap) and stamps the referral bridge once a recap snapshot resolves (FUNNEL-01/02)', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot());

    renderShare('/s/tok123');

    await screen.findByText('Genesis 10');
    expect(logProductEvent).toHaveBeenCalledExactlyOnceWith('share_opened', {
      share_kind: 'recap',
    });
    expect(stamp).toHaveBeenCalledExactlyOnceWith('tok123');
  });

  it('never fires share_opened or stamps the referral for a 404 (revoked/unknown token)', async () => {
    getPublic.mockRejectedValue(new ApiError(404, 'This share is no longer available'));

    renderShare('/s/dead-token');

    await screen.findByText('This review is no longer available');
    expect(logProductEvent).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
  });
});

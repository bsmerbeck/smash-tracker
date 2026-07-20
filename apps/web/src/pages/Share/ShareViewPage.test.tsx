import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import type { YouTubePlayerConfig, YouTubePlayerInstance } from '@/lib/useVodPlayer';
import { ApiError } from '@/lib/api';
import { postCanonicalEvent } from '@/lib/canonicalEvents';
import { logProductEvent } from '@/lib/firebase';
import { stamp } from '@/lib/shareReferral';
import { read as readOnboardingOrigin } from '@/lib/onboardingOrigin';
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

vi.mock('@/lib/canonicalEvents', () => ({
  postCanonicalEvent: vi.fn(),
}));

vi.mock('@/lib/shareReferral', () => ({
  stamp: vi.fn(),
  read: vi.fn(() => null),
  clear: vi.fn(),
}));

// Phase 8: a fixed, deterministic coach identity — the real module's
// crypto.randomUUID()-backed id would make "own vs. not-own" note fixtures
// unpredictable across test runs.
const MY_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const getStoredDisplayNameMock = vi.fn<() => string | null>(() => null);
const setDisplayNameMock = vi.fn((name: string) => {
  // Mirrors the real module's persist-then-read-back semantics closely
  // enough for the name-prompt gate: once set, subsequent reads see it.
  getStoredDisplayNameMock.mockReturnValue(name);
});

vi.mock('@/lib/coachSession', () => ({
  getOrCreateSessionId: () => MY_SESSION_ID,
  getStoredDisplayName: () => getStoredDisplayNameMock(),
  setDisplayName: (name: string) => setDisplayNameMock(name),
}));

// Phase 8: the coach edit-session query + write mutations — mocked so every
// PRE-EXISTING (view-tier/recap) test never fires a real fetch, and the new
// coach-specific tests below control the session response deterministically.
const coachSessionQuery = vi.fn<() => { data: PublicShareSnapshot | undefined }>(() => ({
  data: undefined,
}));
// FB-04/CR-01: `ShareViewPage` threads per-call mutation options through
// `createCoachNote.mutate` for EVERY name-bearing create — the deferred
// FIRST write carries `{ onSuccess, onError }` (the name-commit path), and
// a write reusing a STORED name carries `{ onError }` alone (the stored
// name can still 409 on THIS review — it's a global per-browser record
// while the server's uniqueness check is per-match). This default
// implementation mirrors a SUCCESSFUL server write by invoking `onSuccess`
// synchronously, matching every pre-existing test's expectation that a
// write "just succeeds". Individual 409 tests below override this with
// `mockImplementationOnce` to simulate a name-collision rejection instead.
const createCoachNoteMutate = vi.fn(
  (_payload: unknown, options?: { onSuccess?: () => void; onError?: (error: unknown) => void }) => {
    options?.onSuccess?.();
  },
);
const updateCoachNoteMutate = vi.fn();
const deleteCoachNoteMutate = vi.fn();
// WR-03: the name prompt gates its submit on the create mutation's pending
// state — tests flip this to simulate an in-flight first write.
let createCoachNoteIsPending = false;

vi.mock('@/hooks/useCoachNotes', () => ({
  useCoachSession: () => coachSessionQuery(),
  useCreateCoachNote: () => ({
    mutate: createCoachNoteMutate,
    isPending: createCoachNoteIsPending,
  }),
  useUpdateCoachNote: () => ({ mutate: updateCoachNoteMutate }),
  useDeleteCoachNote: () => ({ mutate: deleteCoachNoteMutate }),
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

/** An edit-tier `GET /api/vod-shares/:token/session` response — Phase 8. */
function baseCoachSession(overrides: Partial<PublicShareSnapshot> = {}): PublicShareSnapshot {
  return {
    ...baseSnapshot(),
    permissions: 'edit',
    timestamps: [{ seconds: 10, note: 'Owner note', id: 'owner-note-1' }],
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
    // `onboardingOrigin` (unlike `shareReferral` above) is NOT mocked in this
    // file — it writes to the real jsdom localStorage, so it must be reset
    // between tests to avoid a stamp leaking from one test into the next.
    window.localStorage.clear();
    // Reset the per-test overrides `mockReturnValue`/`mockImplementation`
    // leave behind — `clearAllMocks` only clears call history, not those.
    coachSessionQuery.mockReturnValue({ data: undefined });
    getStoredDisplayNameMock.mockReturnValue(null);
    setDisplayNameMock.mockImplementation((name: string) => {
      getStoredDisplayNameMock.mockReturnValue(name);
    });
    createCoachNoteIsPending = false;
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

    expect(
      await screen.findByText('Your competitive memory, all in one place'),
    ).toBeInTheDocument();
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

  it('renders an inline external link on the recap title when tournamentUrl is present', async () => {
    getPublic.mockResolvedValue(
      baseRecapSnapshot({
        tournamentUrl: 'https://start.gg/tournament/genesis-10/event/ultimate-singles',
      }),
    );

    renderShare('/s/tok123');

    const titleLink = await screen.findByRole('link', { name: 'View Genesis 10 on start.gg' });
    expect(titleLink).toHaveAttribute(
      'href',
      'https://start.gg/tournament/genesis-10/event/ultimate-singles',
    );
    expect(titleLink).toHaveAttribute('target', '_blank');
  });

  it('omits the recap title link when tournamentUrl is absent', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot());

    renderShare('/s/tok123');

    await screen.findByText('Genesis 10');
    expect(screen.queryByRole('link', { name: /View Genesis 10 on/ })).not.toBeInTheDocument();
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

  it('ONBD-01/D-02: stamps the onboardingOrigin as kind vodShare (unambiguous "Review a VOD") for a vod-review snapshot', async () => {
    getPublic.mockResolvedValue(baseSnapshot());
    mountYouTubePlayer();

    renderShare('/s/tok123');

    await screen.findByText(/Mario vs\. Luigi/);
    expect(readOnboardingOrigin()).toMatchObject({ kind: 'vodShare', returnPath: '/s/tok123' });
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

  it('ONBD-01/D-02: stamps the onboardingOrigin as kind recap (unambiguous "Prepare") from RecapView, not vodShare, for a recap snapshot', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot());

    renderShare('/s/tok123');

    await screen.findByText('Genesis 10');
    expect(readOnboardingOrigin()).toMatchObject({ kind: 'recap', returnPath: '/s/tok123' });
  });

  it('never fires share_opened or stamps the referral for a 404 (revoked/unknown token)', async () => {
    getPublic.mockRejectedValue(new ApiError(404, 'This share is no longer available'));

    renderShare('/s/dead-token');

    await screen.findByText('This review is no longer available');
    expect(logProductEvent).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
    expect(readOnboardingOrigin()).toBeNull();
  });

  // MEAS-09: share_view_loaded must be a DISTINCT trigger from share_opened
  // above — it does not fire on snapshot resolve alone, only once the live
  // player reports ready.
  it('does not fire share_view_loaded on snapshot resolve alone (player not yet ready)', async () => {
    getPublic.mockResolvedValue(baseSnapshot());
    mountYouTubePlayer();

    renderShare('/s/tok123');

    await screen.findByText(/Mario vs\. Luigi/);
    // share_opened (GA4) fires immediately, but the canonical
    // share_view_loaded event must not — the player has not signaled ready.
    expect(logProductEvent).toHaveBeenCalledExactlyOnceWith('share_opened', {
      share_kind: 'review',
    });
    expect(postCanonicalEvent).not.toHaveBeenCalled();
  });

  it('fires share_view_loaded (share_kind: review) exactly once, only after the player reports ready', async () => {
    getPublic.mockResolvedValue(baseSnapshot());
    const { Player, getConfig } = mountYouTubePlayer();

    renderShare('/s/tok123');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(postCanonicalEvent).not.toHaveBeenCalled();

    act(() => {
      getConfig()?.events?.onReady?.();
    });

    await waitFor(() =>
      expect(postCanonicalEvent).toHaveBeenCalledExactlyOnceWith('share_view_loaded', {
        share_kind: 'review',
      }),
    );

    // A later onReady re-fire (defensive — the player SDK never calls it
    // twice, but the effect's own ref guard must still hold) never
    // double-fires.
    act(() => {
      getConfig()?.events?.onReady?.();
    });
    expect(postCanonicalEvent).toHaveBeenCalledTimes(1);
  });

  it('fires share_view_loaded (share_kind: recap) for a recap snapshot with no player (no isReady gate applies)', async () => {
    getPublic.mockResolvedValue(baseRecapSnapshot());

    renderShare('/s/tok123');

    await screen.findByText('Genesis 10');
    // A recap snapshot never mounts a video player, so `isReady` from
    // `useVodPlayer` stays at its default (no vodUrl) — RecapView has no
    // playable moment to gate on, so share_view_loaded intentionally never
    // fires here; only share_opened (GA4) does.
    expect(postCanonicalEvent).not.toHaveBeenCalled();
  });

  describe('coach edit-tier affordances (Phase 8)', () => {
    it('renders no composer/quick-tag/edit affordances for a view-tier share (session query resolves undefined)', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({ data: undefined });
      mountYouTubePlayer();

      renderShare('/s/tok123');

      await screen.findByText(/Mario vs\. Luigi/);
      expect(screen.queryByText('Add a note')).not.toBeInTheDocument();
      expect(screen.queryByText('Quick tags')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Edit timestamp/ })).not.toBeInTheDocument();
    });

    it('renders the composer for an edit-tier share; adding a note fires the create mutation with sessionId + displayName', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({ data: baseCoachSession() });
      getStoredDisplayNameMock.mockReturnValue('Coach Ken');
      mountYouTubePlayer();
      const user = userEvent.setup();

      renderShare('/s/tok123');

      await screen.findByText('Add a note');
      await user.type(screen.getByLabelText('Timestamp time'), '1:30');
      await user.type(screen.getByLabelText('Timestamp note'), 'great punish');
      await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

      // CR-01: a stored-name write carries a per-call `{ onError }` (the
      // stored name can still 409 on THIS review).
      expect(createCoachNoteMutate).toHaveBeenCalledExactlyOnceWith(
        {
          sessionId: MY_SESSION_ID,
          displayName: 'Coach Ken',
          seconds: 90,
          note: 'great punish',
        },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    });

    it('shows no edit/delete affordance for a note authored by a DIFFERENT coach session', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({
        data: baseCoachSession({
          timestamps: [
            {
              seconds: 42,
              note: 'Rival coach note',
              id: 'note-other',
              // WR-02: the session response carries display-name-only
              // attribution and NO `own` flag for another session's note.
              coach: { displayName: 'Rival Coach' },
            },
          ],
        }),
      });
      getStoredDisplayNameMock.mockReturnValue('Coach Ken');
      mountYouTubePlayer();

      renderShare('/s/tok123');

      await screen.findByText('Rival coach note');
      expect(screen.getByText('Note by Rival Coach')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Edit timestamp/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Delete timestamp/ })).not.toBeInTheDocument();
    });

    it("shows edit/delete affordances for the coach's OWN note (server-computed `own` flag, WR-02)", async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({
        data: baseCoachSession({
          timestamps: [
            {
              seconds: 42,
              note: 'My own note',
              id: 'note-mine',
              coach: { displayName: 'Coach Ken' },
              own: true,
            },
          ],
        }),
      });
      getStoredDisplayNameMock.mockReturnValue('Coach Ken');
      mountYouTubePlayer();

      renderShare('/s/tok123');

      await screen.findByText('My own note');
      expect(screen.getByRole('button', { name: /Edit timestamp/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Delete timestamp/ })).toBeInTheDocument();
    });

    it('opens the name prompt on the first write when no display name is stored, then never again', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({ data: baseCoachSession() });
      getStoredDisplayNameMock.mockReturnValue(null);
      mountYouTubePlayer();
      const user = userEvent.setup();

      renderShare('/s/tok123');

      await screen.findByText('Add a note');
      await user.type(screen.getByLabelText('Timestamp time'), '0:05');
      await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

      expect(await screen.findByText('What should we call you?')).toBeInTheDocument();
      expect(createCoachNoteMutate).not.toHaveBeenCalled();

      await user.type(screen.getByLabelText('Your name'), 'Coach Ken');
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      expect(setDisplayNameMock).toHaveBeenCalledWith('Coach Ken');
      // FB-04: the first write's `.mutate` call also carries per-call
      // `{ onSuccess, onError }` options — the default mock implementation
      // invokes `onSuccess` synchronously, which is what actually commits
      // the name above.
      expect(createCoachNoteMutate).toHaveBeenCalledExactlyOnceWith(
        {
          sessionId: MY_SESSION_ID,
          displayName: 'Coach Ken',
          seconds: 5,
          note: '',
        },
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      );
      expect(screen.queryByText('What should we call you?')).not.toBeInTheDocument();

      // A second write, now that a name is stored, never reopens the prompt.
      await user.type(screen.getByLabelText('Timestamp time'), '0:07');
      await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

      expect(screen.queryByText('What should we call you?')).not.toBeInTheDocument();
      expect(createCoachNoteMutate).toHaveBeenCalledTimes(2);
    });

    it('FB-04: a 409 on the first write re-opens the name prompt with the name-taken message and never persists the rejected name; a later accepted name commits and creates the note', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({ data: baseCoachSession() });
      getStoredDisplayNameMock.mockReturnValue(null);
      createCoachNoteMutate.mockImplementationOnce((_payload: unknown, options) => {
        options?.onError?.(
          new ApiError(409, 'That name is already taken on this review — pick another.'),
        );
      });
      mountYouTubePlayer();
      const user = userEvent.setup();

      renderShare('/s/tok123');

      await screen.findByText('Add a note');
      await user.type(screen.getByLabelText('Timestamp time'), '0:05');
      await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

      await user.type(await screen.findByLabelText('Your name'), 'Coach Ken');
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      // The prompt re-opens showing the name-taken message — the rejected
      // name is never committed to component state or localStorage
      // (setDisplayName never fires), and no generic save-failed toast
      // handling happens here (toastCoachWriteError's 409 skip is exercised
      // separately in useCoachNotes.test.tsx).
      expect(
        await screen.findByText('That name is already taken on this review — pick another.'),
      ).toBeInTheDocument();
      expect(setDisplayNameMock).not.toHaveBeenCalled();
      expect(createCoachNoteMutate).toHaveBeenCalledTimes(1);

      // A second submission with an accepted name commits and creates the
      // note — the SAME deferred write retries, no need to re-click "Add
      // timestamp".
      await user.clear(screen.getByLabelText('Your name'));
      await user.type(screen.getByLabelText('Your name'), 'Coach Ken 2');
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      expect(setDisplayNameMock).toHaveBeenCalledExactlyOnceWith('Coach Ken 2');
      expect(createCoachNoteMutate).toHaveBeenCalledTimes(2);
      expect(createCoachNoteMutate).toHaveBeenLastCalledWith(
        expect.objectContaining({ displayName: 'Coach Ken 2', seconds: 5, note: '' }),
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      );
      expect(screen.queryByText('What should we call you?')).not.toBeInTheDocument();
    });

    it('CR-01: a 409 on a write with a STORED display name (accepted on a different review) demotes the name and re-opens the prompt — the note is never silently lost', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({ data: baseCoachSession() });
      // "Sam" was stored by an EARLIER review on this browser (the coach
      // session record is global per-browser) — the server's PER-MATCH
      // uniqueness check has never accepted it for THIS review.
      getStoredDisplayNameMock.mockReturnValue('Sam');
      createCoachNoteMutate.mockImplementationOnce((_payload: unknown, options) => {
        options?.onError?.(
          new ApiError(409, 'That name is already taken on this review — pick another.'),
        );
      });
      mountYouTubePlayer();
      const user = userEvent.setup();

      renderShare('/s/tok123');

      await screen.findByText('Add a note');
      await user.type(screen.getByLabelText('Timestamp time'), '0:05');
      await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

      // The prompt opens with the name-taken message instead of silently
      // dropping the write; the rejected candidate is pre-filled for
      // editing, and the stale name is never re-persisted.
      expect(
        await screen.findByText('That name is already taken on this review — pick another.'),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Your name')).toHaveValue('Sam');
      expect(setDisplayNameMock).not.toHaveBeenCalled();
      expect(createCoachNoteMutate).toHaveBeenCalledTimes(1);

      // Submitting a fresh name retries the SAME pending write and commits
      // — no need to re-type the note.
      await user.clear(screen.getByLabelText('Your name'));
      await user.type(screen.getByLabelText('Your name'), 'Sam 2');
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      expect(setDisplayNameMock).toHaveBeenCalledExactlyOnceWith('Sam 2');
      expect(createCoachNoteMutate).toHaveBeenCalledTimes(2);
      expect(createCoachNoteMutate).toHaveBeenLastCalledWith(
        expect.objectContaining({ displayName: 'Sam 2', seconds: 5 }),
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      );
      expect(screen.queryByText('What should we call you?')).not.toBeInTheDocument();
    });

    it('REGRESSION (WR-04): with localStorage completely unavailable, the entered name still flows through and the prompt never loops', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({ data: baseCoachSession() });
      // Storage is dead: persisting silently fails AND read-back keeps
      // returning null (Safari private mode / disabled storage). The flow
      // must rely on component state, never a read-after-write of storage.
      getStoredDisplayNameMock.mockReturnValue(null);
      setDisplayNameMock.mockImplementation(() => {});
      mountYouTubePlayer();
      const user = userEvent.setup();

      renderShare('/s/tok123');

      await screen.findByText('Add a note');
      await user.type(screen.getByLabelText('Timestamp time'), '0:05');
      await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

      await user.type(await screen.findByLabelText('Your name'), 'Coach Ken');
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      // The write carries the ENTERED name — never the (empty) storage value.
      expect(createCoachNoteMutate).toHaveBeenCalledExactlyOnceWith(
        {
          sessionId: MY_SESSION_ID,
          displayName: 'Coach Ken',
          seconds: 5,
          note: '',
        },
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      );

      // A second write reuses the in-state name — the prompt never reopens.
      await user.type(screen.getByLabelText('Timestamp time'), '0:07');
      await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

      expect(screen.queryByText('What should we call you?')).not.toBeInTheDocument();
      expect(createCoachNoteMutate).toHaveBeenCalledTimes(2);
      expect(createCoachNoteMutate).toHaveBeenLastCalledWith(
        expect.objectContaining({ displayName: 'Coach Ken', seconds: 7 }),
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    });

    it('WR-03: the name-prompt submit is inert while the first write is in flight — no duplicate notes from a double click or held Enter', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({ data: baseCoachSession() });
      getStoredDisplayNameMock.mockReturnValue(null);
      // The first write is in flight (the dialog stays open until
      // onSuccess, FB-04) — every further submit must be a no-op.
      createCoachNoteIsPending = true;
      mountYouTubePlayer();
      const user = userEvent.setup();

      renderShare('/s/tok123');

      await screen.findByText('Add a note');
      await user.type(screen.getByLabelText('Timestamp time'), '0:05');
      await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

      await user.type(await screen.findByLabelText('Your name'), 'Coach Ken');
      // The submit button is disabled and Enter (incl. key-repeat) no-ops.
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      await user.keyboard('{Enter}{Enter}{Enter}');
      expect(createCoachNoteMutate).not.toHaveBeenCalled();
    });

    it('ownership-filtered quick-tag merge: an OWNER note at the current second is never mutated — a NEW coach note is created instead', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({
        data: baseCoachSession({
          timestamps: [{ seconds: 0, note: 'Owner note at second 0', id: 'owner-note-1' }],
        }),
      });
      getStoredDisplayNameMock.mockReturnValue('Coach Ken');
      // getCurrentTime defaults to `() => 0` in mountYouTubePlayer — matches
      // the owner note's `seconds: 0` above, exercising the same-second path.
      mountYouTubePlayer();
      const user = userEvent.setup();

      renderShare('/s/tok123');

      await screen.findByText('Quick tags');
      const quickTagButtons = screen.getAllByRole('button', { name: /^Quick tag:/ });
      await user.click(quickTagButtons[0]!);

      // The owner's note is NEVER touched — no update call at all.
      expect(updateCoachNoteMutate).not.toHaveBeenCalled();
      expect(createCoachNoteMutate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: MY_SESSION_ID, seconds: 0, note: '' }),
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    });

    it("a customized quick tag is offered in an own note's add-combobox even before it lands on a note", async () => {
      window.localStorage.setItem(
        'smash-tracker.vodQuickTags',
        JSON.stringify(['my-share-custom']),
      );
      try {
        getPublic.mockResolvedValue(baseSnapshot());
        coachSessionQuery.mockReturnValue({
          data: baseCoachSession({
            timestamps: [
              {
                seconds: 42,
                note: 'My own note',
                id: 'note-mine',
                coach: { displayName: 'Coach Ken' },
                own: true,
              },
            ],
          }),
        });
        getStoredDisplayNameMock.mockReturnValue('Coach Ken');
        mountYouTubePlayer();
        const user = userEvent.setup();

        renderShare('/s/tok123');

        await screen.findByText('My own note');
        await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));

        expect(await screen.findByRole('option', { name: 'my-share-custom' })).toBeInTheDocument();
      } finally {
        window.localStorage.removeItem('smash-tracker.vodQuickTags');
      }
    });

    it('renders the contributor filter with 2+ authors and narrows notes by author', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({
        data: baseCoachSession({
          timestamps: [
            { seconds: 10, note: 'Owner moment', id: 'own-1' },
            {
              seconds: 42,
              note: 'Rival moment',
              id: 'note-other',
              coach: { displayName: 'Rival Coach' },
            },
          ],
        }),
      });
      getStoredDisplayNameMock.mockReturnValue('Coach Ken');
      mountYouTubePlayer();
      const user = userEvent.setup();

      renderShare('/s/tok123');

      await screen.findByText('Owner moment');
      expect(screen.getByText('Filter by contributor')).toBeInTheDocument();
      expect(screen.getByText('Rival moment')).toBeInTheDocument();

      const ownerChip = screen.getByRole('button', { name: 'Filter notes by TestPlayer' });
      const rivalChip = screen.getByRole('button', { name: 'Filter notes by Rival Coach' });
      expect(ownerChip).toBeInTheDocument();
      expect(rivalChip).toBeInTheDocument();

      await user.click(rivalChip);
      expect(screen.queryByText('Owner moment')).not.toBeInTheDocument();
      expect(screen.getByText('Rival moment')).toBeInTheDocument();

      await user.click(rivalChip);
      expect(screen.getByText('Owner moment')).toBeInTheDocument();
      expect(screen.getByText('Rival moment')).toBeInTheDocument();
    });

    it('hides the contributor filter with a single author', async () => {
      getPublic.mockResolvedValue(baseSnapshot());
      coachSessionQuery.mockReturnValue({ data: baseCoachSession() });
      getStoredDisplayNameMock.mockReturnValue('Coach Ken');
      mountYouTubePlayer();

      renderShare('/s/tok123');

      await screen.findByText('Owner note');
      expect(screen.queryByText('Filter by contributor')).not.toBeInTheDocument();
    });
  });
});

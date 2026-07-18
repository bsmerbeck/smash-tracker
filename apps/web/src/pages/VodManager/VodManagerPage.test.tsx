import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { VodManagerPage } from './VodManagerPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { logProductEvent } from '@/lib/firebase';
import { SpriteList } from '@/data/sprites';
import type {
  TwitchPlayerConfig,
  TwitchPlayerInstance,
  YouTubePlayerConfig,
  YouTubePlayerInstance,
} from '@/lib/useVodPlayer';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const getFighters = vi.fn();
const listMatches = vi.fn();
const listOpponents = vi.fn();
const updateMatch = vi.fn();
const createNote = vi.fn();
const updateNote = vi.fn();
const deleteNote = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const listPlaylists = vi.fn().mockResolvedValue([]);
const createPlaylist = vi.fn();
const updatePlaylist = vi.fn();
const removePlaylist = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      update: (...args: unknown[]) => updateMatch(...args),
      createNote: (...args: unknown[]) => createNote(...args),
      updateNote: (...args: unknown[]) => updateNote(...args),
      deleteNote: (...args: unknown[]) => deleteNote(...args),
    },
    opponents: {
      list: (...args: unknown[]) => listOpponents(...args),
    },
    playlists: {
      list: (...args: unknown[]) => listPlaylists(...args),
      create: (...args: unknown[]) => createPlaylist(...args),
      update: (...args: unknown[]) => updatePlaylist(...args),
      remove: (...args: unknown[]) => removePlaylist(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

/** Mutable "server" record shape for the dynamic-mock tests below — the
 * base `makeMatch` fixture plus a reassignable id-bearing note array the
 * note-endpoint mock implementations rewrite in place. */
type MutableMatch = ReturnType<typeof makeMatch> & {
  vodTimestamps?: Record<string, unknown>[];
};

function renderVodManager(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/vod" element={<VodManagerPage />} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

type YTGlobal = NonNullable<Window['YT']>;
type TwitchGlobal = NonNullable<Window['Twitch']>;

/** Removes any injected vendor scripts/globals so the useVodPlayer module-level singleton loaders start clean for every test. */
function resetVendorGlobals() {
  document.head.querySelectorAll('script').forEach((el) => el.remove());
  delete (window as { YT?: unknown }).YT;
  delete (window as { Twitch?: unknown }).Twitch;
  delete (window as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
}

describe('VodManagerPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    resetVendorGlobals();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listOpponents.mockResolvedValue(['rival-one', 'rival-two']);
    updateMatch.mockResolvedValue({});
    createNote.mockResolvedValue({ id: 'n-new', seconds: 0, note: '' });
    updateNote.mockResolvedValue({ id: 'n-new', seconds: 0, note: '' });
    deleteNote.mockResolvedValue(undefined);
    listPlaylists.mockResolvedValue([]);
    createPlaylist.mockResolvedValue({ id: 'p1', name: 'New', createdAt: 1, matchIds: [] });
    updatePlaylist.mockResolvedValue({});
    removePlaylist.mockResolvedValue({});
  });

  afterEach(() => {
    resetVendorGlobals();
  });

  it('applies the deep-linked match t= offset as the player initial start time', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123&t=30s',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.playerVars?.start).toBe(30);
  });

  it('repositions the live player instead of remounting when switching between matches sharing one video identity', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=30s',
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=90s',
      }),
    ]);

    const seekTo = vi.fn();
    const playVideo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
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
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.playerVars?.start).toBe(30);

    // Un-gate seek() (a no-op until the live player reports ready).
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Select match vs rival-two' }));

    await waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());

    // Same underlying video (abc123) as m1 — must NOT remount the player.
    expect(Player).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(90, true));
    expect(playVideo).toHaveBeenCalled();
  });

  it('prefers a match-level vodStartSeconds over the vodUrl t= param as the player initial start time', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123&t=30s',
        vodStartSeconds: 300,
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.playerVars?.start).toBe(300);
  });

  it('repositions to the new match vodStartSeconds (over its t= param) when switching between matches sharing one video identity', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=30s',
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=90s',
        vodStartSeconds: 500,
      }),
    ]);

    const seekTo = vi.fn();
    const playVideo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
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
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));

    // Un-gate seek() (a no-op until the live player reports ready).
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Select match vs rival-two' }));

    await waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());

    // Same underlying video (abc123) as m1 — must NOT remount the player.
    expect(Player).toHaveBeenCalledTimes(1);
    // m2's vodStartSeconds (500) wins over its t=90s param.
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(500, true));
    expect(playVideo).toHaveBeenCalled();
  });

  it('LIST-04: auto-advances to the next playlist match, forcing a fresh player construction (drift recovery) even though they share one video identity', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=30s',
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=90s',
      }),
    ]);
    listPlaylists.mockResolvedValue([
      { id: 'p1', name: 'My Playlist', createdAt: 1, matchIds: ['m1', 'm2'] },
    ]);

    const configs: YouTubePlayerConfig[] = [];
    const destroy = vi.fn();
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      configs.push(config);
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy,
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?playlist=p1&match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      configs[0]?.events?.onReady?.();
    });

    // Fire ENDED via the live SDK constant, never a hardcoded literal — this
    // is the ONLY signal available that the host platform (Twitch's "Up
    // Next" overlay, most notably) may have hijacked the iframe, so the
    // drift-recovery path treats every ENDED as a potential drift and
    // forces a full reconstruction on the SAME-identity advance, trading a
    // brief re-buffer for reliably recovering a hijacked embed.
    act(() => {
      configs[0]?.events?.onStateChange?.({ data: window.YT!.PlayerState.ENDED });
    });

    await waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());
    // Same identity (abc123) — the OLD (potentially-hijacked) instance is
    // destroyed and a NEW one is constructed at the next match's start time.
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(2));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(configs[1]?.videoId).toBe('abc123');
    expect(configs[1]?.playerVars?.start).toBe(90);
  });

  it('LIST-04: auto-advances to the next playlist match with autoplay when the ENDED event fires and they have different video identities', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=xyz789',
      }),
    ]);
    listPlaylists.mockResolvedValue([
      { id: 'p1', name: 'My Playlist', createdAt: 1, matchIds: ['m1', 'm2'] },
    ]);

    const configs: YouTubePlayerConfig[] = [];
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      configs.push(config);
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?playlist=p1&match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(configs[0]?.playerVars?.autoplay).toBe(0);
    act(() => {
      configs[0]?.events?.onReady?.();
    });

    // Fire ENDED on the FIRST (m1/abc123) player instance.
    act(() => {
      configs[0]?.events?.onStateChange?.({ data: window.YT!.PlayerState.ENDED });
    });

    // Different identity (xyz789) — must remount with autoplay requested.
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(2));
    expect(configs[1]?.videoId).toBe('xyz789');
    expect(configs[1]?.playerVars?.autoplay).toBe(1);
    await waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());
  });

  it('LIST-04(a): auto-advances to the next match in LIBRARY view too (no playlist active), using the current filtered/sorted list order', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=xyz789',
      }),
    ]);

    const configs: YouTubePlayerConfig[] = [];
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      configs.push(config);
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    // Library sorts "newest" by default (VodMatchList) — m2 (later `time`)
    // is FIRST in the visible list, so ENDED on m2 must advance to m1.
    renderVodManager('/vod?match=m2');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(configs[0]?.videoId).toBe('xyz789');
    act(() => {
      configs[0]?.events?.onReady?.();
    });

    act(() => {
      configs[0]?.events?.onStateChange?.({ data: window.YT!.PlayerState.ENDED });
    });

    // No playlist active — this is the SAME two-branch advance logic as the
    // playlist case, applied to the Library list order. Different identity
    // -> remounts with autoplay requested.
    await waitFor(() => expect(screen.getByText('vs. rival-one')).toBeInTheDocument());
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(2));
    expect(configs[1]?.videoId).toBe('abc123');
    expect(configs[1]?.playerVars?.autoplay).toBe(1);
  });

  it('LIST-04: ENDED never advances/remounts when the selected match is the LAST one in the visible list, and PAUSES instead (retest fix-up #10)', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    const pauseVideo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo,
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });
    act(() => {
      capturedConfig?.events?.onStateChange?.({ data: window.YT!.PlayerState.ENDED });
    });

    // No next match in the visible list — ENDED must not attempt to
    // advance or remount, but DOES pause (best-effort Twitch "Up Next"
    // hijack preemption — this fixture is YouTube, but the pause call
    // itself is provider-agnostic in useVodPlayer).
    expect(Player).toHaveBeenCalledTimes(1);
    expect(pauseVideo).toHaveBeenCalledTimes(1);
    expect(screen.getByText('vs. rival-one')).toBeInTheDocument();
  });

  it('retest fix-up #1: ENDED on a Twitch VOD with no next match seeks back off the end then pauses (reliably cancels Up-Next autoplay) and flags drift for the next reselect', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://twitch.tv/videos/98765',
      }),
    ]);

    const seek = vi.fn();
    const pause = vi.fn();
    const getDuration = vi.fn(() => 125);
    const destroy = vi.fn();
    const listeners: Record<string, () => void> = {};
    const addEventListener = vi.fn((event: string, callback: () => void) => {
      listeners[event] = callback;
    });
    const configs: TwitchPlayerConfig[] = [];
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: TwitchPlayerConfig,
    ): TwitchPlayerInstance {
      configs.push(config);
      return {
        seek,
        pause,
        addEventListener,
        destroy,
        getCurrentTime: vi.fn(() => 0),
        getDuration,
      };
    });
    (Player as unknown as { READY: string; ENDED: string }).READY = 'ready';
    (Player as unknown as { READY: string; ENDED: string }).ENDED = 'ended';
    window.Twitch = { Player: Player as unknown as TwitchGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      listeners.ready?.();
    });

    // ENDED fires with no next match — seek back off the very end (exiting
    // the ended state, the reliable way to cancel Twitch's "Up Next"
    // countdown) then pause. No advance, no remount fallback needed since
    // the workaround succeeded.
    act(() => {
      listeners.ended?.();
    });
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
    expect(seek).toHaveBeenCalledWith(124);
    expect(Player).toHaveBeenCalledTimes(1);

    // Drift is still flagged regardless of the workaround's outcome —
    // reselecting the SAME (only) match forces a fresh player construction
    // rather than a silent no-op, a second layer of hijack recovery.
    await user.click(screen.getByRole('button', { name: 'Select match vs rival-one' }));
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(2));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(configs[1]?.video).toBe('98765');
  });

  it('retest fix-up #1: ENDED on a Twitch VOD with no next match and no getDuration() falls back to an immediate paused remount', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://twitch.tv/videos/98765',
      }),
    ]);

    const seek = vi.fn();
    const pause = vi.fn();
    const destroy = vi.fn();
    const listeners: Record<string, () => void> = {};
    const addEventListener = vi.fn((event: string, callback: () => void) => {
      listeners[event] = callback;
    });
    const configs: TwitchPlayerConfig[] = [];
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: TwitchPlayerConfig,
    ): TwitchPlayerInstance {
      configs.push(config);
      // No getDuration on this instance — mirrors an embed API surface that
      // doesn't expose it, exercising the remount fallback.
      return { seek, pause, addEventListener, destroy, getCurrentTime: vi.fn(() => 0) };
    });
    (Player as unknown as { READY: string; ENDED: string }).READY = 'ready';
    (Player as unknown as { READY: string; ENDED: string }).ENDED = 'ended';
    window.Twitch = { Player: Player as unknown as TwitchGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      listeners.ready?.();
    });

    act(() => {
      listeners.ended?.();
    });

    // The seek-back+pause workaround couldn't be applied, so a fresh
    // (unstarted, paused) player construction is forced immediately —
    // a fresh embed has no post-roll overlay to cancel.
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(2));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(configs[1]?.video).toBe('98765');
    expect(seek).not.toHaveBeenCalled();
  });

  it('LIST-04: renders Prev/Next playback controls + "N of M" while a playlist is active, and manual Next never autoplays', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=xyz789',
      }),
    ]);
    listPlaylists.mockResolvedValue([
      { id: 'p1', name: 'My Playlist', createdAt: 1, matchIds: ['m1', 'm2'] },
    ]);

    const configs: YouTubePlayerConfig[] = [];
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      configs.push(config);
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?playlist=p1&match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled();
    const nextButton = screen.getByRole('button', { name: 'Next match' });
    expect(nextButton).not.toBeDisabled();

    await user.click(nextButton);

    await waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());
    // Different identity (xyz789) — remounts, but Next must NOT request
    // autoplay (manual navigation never surprise-autoplays).
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(2));
    expect(configs[1]?.playerVars?.autoplay).toBe(0);
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();
  });

  it('drift recovery: reselecting the SAME already-ended match forces a fresh player construction instead of a no-op', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    const configs: YouTubePlayerConfig[] = [];
    const destroy = vi.fn();
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      configs.push(config);
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy,
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      configs[0]?.events?.onReady?.();
    });

    // ENDED fires — the SDK gives no signal about WHETHER the host platform
    // hijacked the iframe (Twitch's "Up Next" overlay), only that playback
    // ended. Reproduces the reported bug: clicking the SAME video again
    // afterward previously did nothing (unchanged searchParams + unchanged
    // video identity meant neither the URL nor the player ever updated).
    act(() => {
      configs[0]?.events?.onStateChange?.({ data: window.YT!.PlayerState.ENDED });
    });
    expect(Player).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Select match vs rival-one' }));

    // Same identity, same match id — the OLD instance is destroyed and a
    // NEW one constructed, restoring the embed rather than silently no-op'ing.
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(2));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(configs[1]?.videoId).toBe('abc123');
  });

  it('renames the active playlist via an explicit Rename -> Save flow, with Escape reverting without mutating', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);
    listPlaylists.mockResolvedValue([
      { id: 'p1', name: 'My Playlist', createdAt: 1, matchIds: ['m1'] },
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?playlist=p1&match=m1');

    // (1) Default view: no bare/unlabeled rename input — only an explicit
    // Rename trigger.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: 'Rename playlist' })).not.toBeInTheDocument();

    // (2) Clicking Rename swaps in a clearly labeled input plus Save/Cancel.
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename playlist' });
    expect(input).toHaveValue('My Playlist');
    expect(screen.getByRole('button', { name: 'Save playlist name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel rename' })).toBeInTheDocument();

    // (3) Escape reverts the draft and exits rename mode WITHOUT mutating.
    await user.type(input, ' extra');
    await user.keyboard('{Escape}');
    expect(updatePlaylist).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Rename playlist' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();

    // (4) Re-entering rename mode re-seeds the draft fresh (the ' extra'
    // from step 3 must not carry over), and Enter saves via a name-only
    // PATCH.
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const input2 = screen.getByRole('textbox', { name: 'Rename playlist' });
    expect(input2).toHaveValue('My Playlist');
    await user.clear(input2);
    await user.type(input2, 'Renamed Playlist{Enter}');

    await waitFor(() =>
      expect(updatePlaylist).toHaveBeenCalledWith('p1', { name: 'Renamed Playlist' }),
    );
    expect(screen.queryByRole('textbox', { name: 'Rename playlist' })).not.toBeInTheDocument();
  });

  it('adds a timestamp note via the inline composer, prefilled from the live position, via the dedicated create-note endpoint', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [{ id: 'n1', seconds: 900, note: 'existing note' }],
      }),
    ]);

    const seekTo = vi.fn();
    const playVideo = vi.fn();
    const getCurrentTime = vi.fn(() => 754);
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return { seekTo, playVideo, pauseVideo: vi.fn(), destroy: vi.fn(), getCurrentTime };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));

    // Un-gate getCurrentTime()/seek() (both no-ops until the live player reports ready).
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) A composer time input and note input render below the player.
    const timeInput = screen.getByLabelText('Timestamp time');
    const noteInput = screen.getByLabelText('Timestamp note');

    // (2) Focusing the time input prefills it from getCurrentTime() (754s -> 12:34).
    await user.click(timeInput);
    expect(timeInput).toHaveValue('12:34');

    // (3) Enter on the note input saves — ONE create against the dedicated
    // note endpoint, never a full-match PATCH (match facts can no longer be
    // stomped by a note write, and vice versa).
    await user.type(noteInput, 'new note{Enter}');

    await waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
    expect(createNote).toHaveBeenCalledWith('m1', { seconds: 754, note: 'new note' });
    expect(updateMatch).not.toHaveBeenCalled();

    // Adding a note must never pause/interrupt playback.
    expect(playVideo).not.toHaveBeenCalled();
  });

  it('retest fix-up #2: the composer saves a tag-only entry — a valid TIME alone with no note text', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [{ id: 'n1', seconds: 900, note: 'existing note' }],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // Time input only — the note input is left blank entirely. Clear the
    // focus-prefilled value (getCurrentTime()) before typing the target time.
    const timeInput = screen.getByLabelText('Timestamp time');
    await user.click(timeInput);
    await user.clear(timeInput);
    await user.type(timeInput, '5:00{Enter}');

    // Saves with no "note text required" error — the empty-note entry goes
    // to the dedicated create endpoint, ready for the user to tag via the
    // row's "+" chip.
    expect(screen.queryByText('Enter a note for this timestamp')).not.toBeInTheDocument();
    await waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
    expect(createNote).toHaveBeenCalledWith('m1', { seconds: 300, note: '' });
    expect(updateMatch).not.toHaveBeenCalled();
  });

  it('edits a timestamp note in place (no dialog), via a single update-by-id against the dedicated note endpoint', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A' },
          { id: 'n2', seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) Clicking pencil on note B's row swaps it into inline time+text inputs prefilled from the row's current values.
    await user.click(screen.getByLabelText('Edit timestamp 1:30'));
    const timeInput = screen.getByLabelText('Edit timestamp time');
    const noteInput = screen.getByLabelText('Edit timestamp note');
    expect(timeInput).toHaveValue('1:30');
    expect(noteInput).toHaveValue('note B');

    // (2) Editing the time, then Enter commits — ONE update-by-id against
    // the dedicated note endpoint, addressed by note B's stable id (never
    // an array position). Re-sorting is the server + read normalizer's job.
    await user.clear(timeInput);
    await user.type(timeInput, '0:10{Enter}');

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    expect(updateNote).toHaveBeenCalledWith('m1', 'n2', { seconds: 10, note: 'note B' });
    expect(updateMatch).not.toHaveBeenCalled();
  });

  it('retest fix-up #2: an in-place row edit allows clearing the note text to empty and saving, keeping tags/time', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A' },
          { id: 'n2', seconds: 90, note: 'note B', tags: ['punish'] },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByLabelText('Edit timestamp 1:30'));
    const noteInput = screen.getByLabelText('Edit timestamp note');
    expect(noteInput).toHaveValue('note B');

    // Clear the note text entirely, then commit — no "note required" error,
    // time/tags are unaffected.
    await user.clear(noteInput);
    await user.keyboard('{Enter}');

    expect(screen.queryByText('Enter a note for this timestamp')).not.toBeInTheDocument();
    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    expect(updateNote).toHaveBeenCalledWith('m1', 'n2', {
      seconds: 90,
      note: '',
      tags: ['punish'],
    });
    expect(updateMatch).not.toHaveBeenCalled();
  });

  it('discards an in-place edit on Escape without mutating', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A' },
          { id: 'n2', seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByLabelText('Edit timestamp 1:30'));
    const timeInput = screen.getByLabelText('Edit timestamp time');
    await user.clear(timeInput);
    await user.type(timeInput, '5:00');
    await user.type(timeInput, '{Escape}');

    expect(updateNote).not.toHaveBeenCalled();
    expect(updateMatch).not.toHaveBeenCalled();
    // Edit mode closed with no value change — the pencil affordance and
    // original note text are back, the edit inputs are gone.
    expect(screen.queryByLabelText('Edit timestamp time')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Edit timestamp 1:30')).toBeInTheDocument();
    expect(screen.getByText('note B')).toBeInTheDocument();
  });

  it('removes a note via an AlertDialog confirm (not an immediate delete), via a single delete-by-id', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A' },
          { id: 'n2', seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) Clicking trash opens a confirm — no immediate delete.
    await user.click(screen.getByLabelText('Delete timestamp 1:30'));
    const alert = await screen.findByRole('alertdialog');
    expect(within(alert).getByText('Delete this timestamp note?')).toBeInTheDocument();

    // (2) Canceling closes the dialog with no mutation.
    await user.click(within(alert).getByRole('button', { name: 'Cancel' }));
    expect(deleteNote).not.toHaveBeenCalled();
    expect(screen.getByText('note B')).toBeInTheDocument();

    // (3) Confirming removes the note via ONE delete-by-id against the
    // dedicated note endpoint — never a rebuilt-array match PATCH.
    await user.click(screen.getByLabelText('Delete timestamp 1:30'));
    const alert2 = await screen.findByRole('alertdialog');
    await user.click(within(alert2).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(deleteNote).toHaveBeenCalledTimes(1));
    expect(deleteNote).toHaveBeenCalledWith('m1', 'n2');
    expect(updateMatch).not.toHaveBeenCalled();
  });

  it('renders note tag chips and adds a preset tag via the note combobox, updating only that note by id without seeking', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A', tags: ['punish'] },
          { id: 'n2', seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    const seekTo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo,
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) note A's existing preset tag renders as a chip with its translated
    // label (scoped to note A's row — the tag filter row in VodMatchList
    // also renders "Punish" as a toggle chip, so a plain text query would
    // be ambiguous).
    const noteARow = screen.getByText('note A').closest('li')!;
    expect(within(noteARow).getByText('Punish')).toBeInTheDocument();

    // (2) Opening note A's add-combobox (scoped to its row) and picking
    // another preset dispatches ONE update-by-id carrying note A's full
    // body with both tags — note B and match facts are never touched, and
    // it never seeks/selects.
    await user.click(within(noteARow).getByRole('combobox', { name: 'Add a tag' }));
    await user.click(await screen.findByRole('option', { name: 'Edgeguard' }));

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    expect(updateNote).toHaveBeenCalledWith('m1', 'n1', {
      seconds: 30,
      note: 'note A',
      tags: ['punish', 'edgeguard'],
    });
    expect(updateMatch).not.toHaveBeenCalled();
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('retest fix-up #4: adds two tags sequentially to the same note via its combobox, both persisting (cap still enforced)', async () => {
    const user = userEvent.setup();
    // Mutable "server" record, gated behind a manually-resolved promise
    // (rather than the usual immediate `Promise.resolve`) — REQUIRED to
    // deterministically reproduce the reported race: both note PATCHes are
    // dispatched while `stamp.tags` (the prop) STILL reflects the
    // pre-either-add state (neither PATCH has resolved/refetched yet), so
    // a fix that recomputes the second add's payload from the stale prop
    // — instead of tracking its own last-dispatched value — would silently
    // drop the first tag.
    let currentMatch: MutableMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ id: 'n1', seconds: 30, note: 'note A' }],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    updateNote.mockImplementation((...args: unknown[]) => {
      const [, noteId, input] = args as [string, string, Record<string, unknown>];
      // Both calls await the SAME gate — resolving in dispatch order once
      // released, mirroring a real backend applying two note PATCHes in
      // the order they were sent.
      return gate.then(() => {
        const notes = currentMatch.vodTimestamps!;
        currentMatch = {
          ...currentMatch,
          vodTimestamps: notes.map((n) => (n.id === noteId ? { id: noteId, ...input } : n)),
        };
        return { id: noteId, ...input };
      });
    });

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(screen.getByText('note A')).toBeInTheDocument());
    const noteARow = screen.getByText('note A').closest('li')!;

    // (1) Add the first tag — its update-by-id is now pending behind the gate.
    await user.click(within(noteARow).getByRole('combobox', { name: 'Add a tag' }));
    await user.click(await screen.findByRole('option', { name: 'Punish' }));
    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));

    // (2) Add a SECOND tag while the first PATCH is STILL pending —
    // `stamp.tags` (the prop) is provably still stale here (no refetch has
    // happened, since nothing has resolved yet).
    await user.click(within(noteARow).getByRole('combobox', { name: 'Add a tag' }));
    await user.click(await screen.findByRole('option', { name: 'Edgeguard' }));
    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(2));

    // (3) Release the gate — both PATCHes resolve in dispatch order.
    releaseGate?.();

    // (4) The FINAL persisted state has BOTH tags — the second add must
    // never silently overwrite the first.
    await waitFor(() => {
      expect(within(noteARow).getByText('Punish')).toBeInTheDocument();
      expect(within(noteARow).getByText('Edgeguard')).toBeInTheDocument();
    });
    expect((currentMatch as unknown as { vodTimestamps: unknown }).vodTimestamps).toEqual([
      { id: 'n1', seconds: 30, note: 'note A', tags: ['punish', 'edgeguard'] },
    ]);
  });

  it('removes a note tag via the chip X, omitting tags from that note only, without disturbing other notes', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A', tags: ['punish'] },
          { id: 'n2', seconds: 90, note: 'note B', tags: ['mistake'] },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(await screen.findByRole('button', { name: 'Remove tag Punish' }));

    // ONE update-by-id targeting note A only — the emptied tag list is
    // omitted from the body entirely (omit-to-clear convention), and note B
    // is never touched.
    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    expect(updateNote).toHaveBeenCalledWith('m1', 'n1', { seconds: 30, note: 'note A' });
    expect(updateMatch).not.toHaveBeenCalled();
  });

  it("a newly-created custom tag appears in a DIFFERENT note's add-combobox after the matches list refetches", async () => {
    const user = userEvent.setup();

    // Dynamic mock: `listMatches`/`updateNote` mirror a real backend (the
    // note PATCH mutates server-side state, and a subsequent GET reflects
    // it) — unlike this file's usual static `mockResolvedValue`, which
    // always resolves to the SAME fixture and so can never expose a real
    // stale-cache bug (the fix under test).
    let storedMatch: MutableMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [
        { id: 'n1', seconds: 30, note: 'note A' },
        { id: 'n2', seconds: 90, note: 'note B' },
      ],
    });
    listMatches.mockImplementation(() => Promise.resolve([storedMatch]));
    updateNote.mockImplementation((...args: unknown[]) => {
      const [, noteId, input] = args as [string, string, Record<string, unknown>];
      const notes = storedMatch.vodTimestamps!;
      storedMatch = {
        ...storedMatch,
        vodTimestamps: notes.map((n) => (n.id === noteId ? { id: noteId, ...input } : n)),
      };
      return Promise.resolve({ id: noteId, ...input });
    });

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) Add a brand-new custom tag to note A's combobox.
    const noteARow = screen.getByText('note A').closest('li')!;
    await user.click(within(noteARow).getByRole('combobox', { name: 'Add a tag' }));
    await user.type(screen.getByPlaceholderText('Search or create a tag...'), 'my-new-tag');
    await user.click(await screen.findByRole('option', { name: 'Create "my-new-tag"' }));

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    // The chip renders on note A immediately (confirms the mutation landed
    // and the matches query already reflects it).
    await waitFor(() => expect(within(noteARow).getByText('my-new-tag')).toBeInTheDocument());

    // (2) Open note B's OWN add-combobox — the custom tag just created on
    // note A must be offered here too (the shared vocabulary, 03-02 locked
    // decision), not just remain visible on the note that created it.
    const noteBRow = screen.getByText('note B').closest('li')!;
    await user.click(within(noteBRow).getByRole('combobox', { name: 'Add a tag' }));
    expect(await screen.findByRole('option', { name: 'my-new-tag' })).toBeInTheDocument();
  });

  it('seeks the live player and highlights the clicked row body; edit/delete on another row do not change the selection (D-13/D-14)', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A' },
          { id: 'n2', seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    const seekTo = vi.fn();
    const playVideo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
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
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // Clicking the row BODY (not pencil/trash) seeks the live player and highlights the row.
    const noteARow = screen.getByText('note A').closest('button')!;
    await user.click(noteARow);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(30, true));
    expect(noteARow).toHaveClass('bg-accent');

    // Editing (then canceling) a DIFFERENT row must not change the selection or re-seek.
    await user.click(screen.getByLabelText('Edit timestamp 1:30'));
    await user.click(screen.getByLabelText('Cancel timestamp edit'));

    expect(noteARow).toHaveClass('bg-accent');
    expect(seekTo).toHaveBeenCalledTimes(1);
  });

  it('shows an Edit affordance on the metadata card; editing and saving persists a full carry-through PATCH', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        notes: 'existing notes',
        vodTimestamps: [{ id: 'n1', seconds: 30, note: 'note A' }],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) The read-only card shows an Edit affordance; clicking it renders the inline form.
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    expect(screen.getByRole('radio', { name: 'Win' })).toBeInTheDocument();

    // (2) Changing a field (result win -> loss) and saving PATCHes once with the full carry-through input.
    await user.click(screen.getByRole('radio', { name: 'Loss' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.win).toBe(false);
    // notes/vodTimestamps/gsp from the fixture are preserved (carry-through).
    expect(input.notes).toBe('existing notes');
    expect(input.gsp).toBe(1_234_567);
    expect(input.vodTimestamps).toEqual([{ id: 'n1', seconds: 30, note: 'note A' }]);

    // (3) Save returns to the read-only view.
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
  });

  it('returns to the read-only view without a mutation on Cancel', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(screen.getByRole('radio', { name: 'Loss' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(updateMatch).not.toHaveBeenCalled();
    expect(screen.getByText('vs. rival-one')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
  });

  it('disables sync-owned fields but keeps notes/vodUrl/vodStartSeconds/gsp editable for a synced match', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        source: 'startgg',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));

    // Sync-owned controls are disabled (mirrors changesSyncOwnedFields).
    expect(screen.getByRole('combobox', { name: 'Your Fighter' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Win' })).toBeDisabled();

    // Annotation fields stay editable.
    expect(screen.getByRole('textbox', { name: 'Notes' })).not.toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'VOD URL' })).not.toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'GSP after match (optional)' })).not.toBeDisabled();
  });

  it('fills the VOD start-time field from the live position via "Use current player time"', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(screen.getByRole('button', { name: 'Use current player time' }));

    expect(screen.getByRole('textbox', { name: 'Match start time in VOD' })).toHaveValue('12:34');
  });

  it('retest fix-up #8: "Add to playlist" renders prominently in the metadata card\'s header row (next to the title, not buried below tags) and adds the match to an existing playlist', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);
    listPlaylists.mockResolvedValue([
      { id: 'p1', name: 'My Playlist', createdAt: 1, matchIds: [] },
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(screen.getByText('vs. rival-one')).toBeInTheDocument());

    // (1) The button lives in the SAME header row as the title (a sibling
    // element), not somewhere further down the card past the tags block.
    const title = screen.getByText('vs. rival-one');
    const addToPlaylistButton = screen.getByRole('combobox', {
      name: 'Add this match to a playlist',
    });
    expect(title.parentElement).toBe(addToPlaylistButton.parentElement?.parentElement);
    // Icon + label, not an icon-only affordance.
    expect(addToPlaylistButton).toHaveTextContent('Add to playlist');

    // (2) Clicking it and picking an existing playlist adds the match.
    await user.click(addToPlaylistButton);
    await user.click(await screen.findByRole('option', { name: 'My Playlist' }));

    await waitFor(() => expect(updatePlaylist).toHaveBeenCalledWith('p1', { matchIds: ['m1'] }));
  });

  it('renders match tag chips and adds a preset tag via the combobox, carrying other fields through', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        tags: ['practice-friendlies'],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) The existing preset tag renders as a chip with its translated label
    // (scoped via the chip's unique remove-button accessible name — the tag
    // filter row in VodMatchList also renders "Practice/Friendlies" as a
    // toggle chip, so a plain text query would be ambiguous).
    expect(
      await screen.findByRole('button', { name: 'Remove tag Practice/Friendlies' }),
    ).toBeInTheDocument();

    // (2) Opening the add-combobox and picking another preset PATCHes with
    // both tags, carrying gsp/vodTimestamps through unchanged.
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.click(await screen.findByRole('option', { name: 'Bad Matchup' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.tags).toEqual(['practice-friendlies', 'bad-matchup']);
    expect(input.gsp).toBe(1_234_567);
  });

  it('removes a match tag via the chip X, omitting tags from the payload when it was the last one', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        tags: ['practice-friendlies'],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(await screen.findByRole('button', { name: 'Remove tag Practice/Friendlies' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input).not.toHaveProperty('tags');
  });

  it('carries match tags through a match-detail edit save even when the VOD link is cleared', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ id: 'n1', seconds: 30, note: 'note A' }],
        tags: ['to-review'],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    const vodUrlInput = screen.getByRole('textbox', { name: 'VOD URL' });
    await user.clear(vodUrlInput);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    // vodTimestamps are dropped (VOD link cleared) but the match tag survives.
    expect(input).not.toHaveProperty('vodTimestamps');
    expect(input.tags).toEqual(['to-review']);
  });

  it('does not remount the player when editing match metadata', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(screen.getByRole('radio', { name: 'Loss' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(Player).toHaveBeenCalledTimes(1);
  });

  it('captures an instant pre-tagged note via a Quick tags panel button, then opens it in edit mode', async () => {
    const user = userEvent.setup();
    // A mutable "server" record so invalidateQueries' refetch (triggered by
    // the note mutations' onSuccess) actually reflects the just-created
    // note — needed here (unlike the read-only-of-call-args tests above)
    // because this test asserts on the freshly-inserted row's rendered edit
    // state, which only appears once TimestampList re-renders with the
    // updated vodTimestamps array. The server assigns the new note's id and
    // returns the array seconds-sorted, exactly like the real normalizer.
    let currentMatch: MutableMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ id: 'n1', seconds: 900, note: 'existing note' }],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));
    createNote.mockImplementation((...args: unknown[]) => {
      const [, input] = args as [string, Record<string, unknown>];
      const created: Record<string, unknown> = { id: 'n-new', ...input };
      currentMatch = {
        ...currentMatch,
        vodTimestamps: [...currentMatch.vodTimestamps!, created].sort(
          (a, b) => (a.seconds as number) - (b.seconds as number),
        ),
      };
      return Promise.resolve(created);
    });
    updateNote.mockImplementation((...args: unknown[]) => {
      const [, noteId, input] = args as [string, string, Record<string, unknown>];
      currentMatch = {
        ...currentMatch,
        vodTimestamps: currentMatch.vodTimestamps!.map((n) =>
          n.id === noteId ? { id: noteId, ...input } : n,
        ),
      };
      return Promise.resolve({ id: noteId, ...input });
    });

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) One click on the panel's preset button instantly captures a note
    // at the current playback time (754s), pre-tagged, empty text — via the
    // dedicated create-note endpoint.
    await user.click(screen.getByRole('button', { name: 'Quick tag: Punish' }));

    await waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
    expect(createNote).toHaveBeenCalledWith('m1', { seconds: 754, note: '', tags: ['punish'] });
    expect(updateMatch).not.toHaveBeenCalled();

    // (2) The freshly-captured row (754s, sorted first by the server) opens
    // in edit mode, keyed by the id the create resolved with.
    const noteInput = await screen.findByLabelText('Edit timestamp note');
    expect(noteInput).toHaveValue('');
    expect(screen.getByLabelText('Edit timestamp time')).toHaveValue('12:34');

    // (3) Typing text and pressing Enter commits it via update-by-id.
    await user.type(noteInput, 'clean edgeguard{Enter}');
    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    expect(updateNote).toHaveBeenCalledWith('m1', 'n-new', {
      seconds: 754,
      note: 'clean edgeguard',
      tags: ['punish'],
    });
  });

  it('retest fix-up #2: quick-tag capture pauses the player at the captured moment WITHOUT seeking, even after the refetch it triggers', async () => {
    const user = userEvent.setup();
    // Same mutable "server" record + dynamic mock pattern as the capture
    // test above — REQUIRED to reproduce the reported bug: a static
    // `mockResolvedValue` always resolves the SAME fixture object, so the
    // `selectedMatch` reference never actually changes on refetch and the
    // bug (reposition effect keyed on object identity) can never surface.
    let currentMatch: MutableMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ id: 'n1', seconds: 900, note: 'existing note' }],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));
    createNote.mockImplementation((...args: unknown[]) => {
      const [, input] = args as [string, Record<string, unknown>];
      const created: Record<string, unknown> = { id: 'n-new', ...input };
      currentMatch = {
        ...currentMatch,
        vodTimestamps: [...currentMatch.vodTimestamps!, created].sort(
          (a, b) => (a.seconds as number) - (b.seconds as number),
        ),
      };
      return Promise.resolve(created);
    });

    const seekTo = vi.fn();
    const pauseVideo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo,
        playVideo: vi.fn(),
        pauseVideo,
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Quick tag: Punish' }));

    // pause() fires (freezing the captured frame) — never seek(), which
    // would jump the player back to its start time.
    await waitFor(() => expect(pauseVideo).toHaveBeenCalledTimes(1));

    // The create's onSuccess invalidateQueries refetch resolves, producing
    // a BRAND NEW `matches`/`selectedMatch` object even though the selected
    // match id (m1) never changed. The reposition effect must recognize
    // this is NOT a match switch and never seek — reproducing the reported
    // "player resets to 0:00" bug if it does.
    await waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText('Edit timestamp note')).toBeInTheDocument());
    expect(seekTo).not.toHaveBeenCalled();
    // Only ONE player construction throughout — no remount either.
    expect(Player).toHaveBeenCalledTimes(1);
  });

  it('retest fix-up #3: the freshly-captured tag stays visible and removable while its row is in edit mode', async () => {
    const user = userEvent.setup();
    let currentMatch: MutableMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));
    createNote.mockImplementation((...args: unknown[]) => {
      const [, input] = args as [string, Record<string, unknown>];
      const created: Record<string, unknown> = { id: 'n-new', ...input };
      currentMatch = {
        ...currentMatch,
        vodTimestamps: [...(currentMatch.vodTimestamps ?? []), created],
      };
      return Promise.resolve(created);
    });
    updateNote.mockImplementation((...args: unknown[]) => {
      const [, noteId, input] = args as [string, string, Record<string, unknown>];
      currentMatch = {
        ...currentMatch,
        vodTimestamps: (currentMatch.vodTimestamps ?? []).map((n) =>
          n.id === noteId ? { id: noteId, ...input } : n,
        ),
      };
      return Promise.resolve({ id: noteId, ...input });
    });

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // Capture drops the new row straight into edit mode.
    await user.click(screen.getByRole('button', { name: 'Quick tag: Punish' }));
    const noteInput = await screen.findByLabelText('Edit timestamp note');
    const editingRow = noteInput.closest('li')!;

    // The captured "Punish" tag chip is visible AND removable while the
    // row is still in edit mode — previously chips only rendered in the
    // read-mode branch.
    expect(within(editingRow).getByText('Punish')).toBeInTheDocument();
    const removeButton = within(editingRow).getByRole('button', { name: 'Remove tag Punish' });
    await user.click(removeButton);

    // The removal dispatches update-by-id with the emptied tag list omitted
    // (omit-to-clear), targeting the id the create resolved with.
    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    expect(updateNote).toHaveBeenCalledWith('m1', 'n-new', { seconds: 754, note: '' });
    // Still in edit mode — removing a tag never closes the row.
    expect(screen.getByLabelText('Edit timestamp note')).toBeInTheDocument();
  });

  it("retest fix-up #5: quick-tag capture at an EXISTING note's exact timecode adds the tag to that note instead of creating a duplicate row", async () => {
    const user = userEvent.setup();
    let currentMatch: MutableMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ id: 'n1', seconds: 754, note: 'existing note', tags: ['punish'] }],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));
    updateNote.mockImplementation((...args: unknown[]) => {
      const [, noteId, input] = args as [string, string, Record<string, unknown>];
      currentMatch = {
        ...currentMatch,
        vodTimestamps: currentMatch.vodTimestamps!.map((n) =>
          n.id === noteId ? { id: noteId, ...input } : n,
        ),
      };
      return Promise.resolve({ id: noteId, ...input });
    });

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        // Same 754s the existing note was captured at.
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });
    await waitFor(() => expect(screen.getByText('existing note')).toBeInTheDocument());

    // Capturing "Edgeguard" at the SAME 754s the existing note already sits
    // at must add the tag to that note via update-by-id, not create a
    // second row.
    await user.click(screen.getByRole('button', { name: 'Quick tag: Edgeguard' }));

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    // ONE row, both tags, note text preserved (not cleared) — no duplicate.
    expect(updateNote).toHaveBeenCalledWith('m1', 'n1', {
      seconds: 754,
      note: 'existing note',
      tags: ['punish', 'edgeguard'],
    });
    expect(createNote).not.toHaveBeenCalled();

    // That SAME (only) row drops into edit mode.
    const noteInput = await screen.findByLabelText('Edit timestamp note');
    expect(noteInput).toHaveValue('existing note');
    expect(screen.queryAllByLabelText('Edit timestamp note')).toHaveLength(1);
  });

  it('retest fix-up #5: quick-tag capture at a timecode with NO existing note still creates a new row (unaffected)', async () => {
    const user = userEvent.setup();
    let currentMatch: MutableMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ id: 'n1', seconds: 900, note: 'existing note' }],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));
    createNote.mockImplementation((...args: unknown[]) => {
      const [, input] = args as [string, Record<string, unknown>];
      const created: Record<string, unknown> = { id: 'n-new', ...input };
      currentMatch = {
        ...currentMatch,
        vodTimestamps: [...currentMatch.vodTimestamps!, created].sort(
          (a, b) => (a.seconds as number) - (b.seconds as number),
        ),
      };
      return Promise.resolve(created);
    });

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        // Different second than the existing note (900s).
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Quick tag: Punish' }));

    // A NEW note at 754s via the dedicated create endpoint — the existing
    // 900s note is never touched.
    await waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
    expect(createNote).toHaveBeenCalledWith('m1', { seconds: 754, note: '', tags: ['punish'] });
    expect(updateNote).not.toHaveBeenCalled();
  });

  it('FUNNEL-01: fires vod_note_created for a quick-tag capture that creates a NEW row, never for one that tags an EXISTING row', async () => {
    const user = userEvent.setup();
    const currentMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ id: 'n1', seconds: 754, note: 'existing note', tags: ['punish'] }],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });
    await waitFor(() => expect(screen.getByText('existing note')).toBeInTheDocument());

    // Same 754s as the existing note — adds a tag to it via update-by-id,
    // does NOT create a row.
    await user.click(screen.getByRole('button', { name: 'Quick tag: Edgeguard' }));
    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    expect(createNote).not.toHaveBeenCalled();
    expect(logProductEvent).not.toHaveBeenCalledWith('vod_note_created');
  });

  it('FUNNEL-01: fires vod_note_created exactly once when a quick-tag capture creates a brand-new row', async () => {
    const user = userEvent.setup();
    const currentMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ id: 'n1', seconds: 900, note: 'existing note' }],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));
    createNote.mockResolvedValue({ id: 'n-new', seconds: 754, note: '', tags: ['punish'] });

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        // Different second than the existing note (900s) — a NEW row.
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Quick tag: Punish' }));

    await waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
    expect(logProductEvent).toHaveBeenCalledExactlyOnceWith('vod_note_created');
  });

  it('blocks a quick-tag capture once the match is at the MAX_TIMESTAMPS cap, via the existing cap toast', async () => {
    const user = userEvent.setup();
    const twentyExisting = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      seconds: i,
      note: `note ${i}`,
    }));
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: twentyExisting,
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Quick tag: Punish' }));

    // Already at the 20-note cap — the click must not create a 21st note.
    expect(createNote).not.toHaveBeenCalled();
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("a custom tag added via Quick Tags Customize is immediately offered in a note's OWN add-combobox, even before it is ever captured onto a note", async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ id: 'n1', seconds: 30, note: 'note A' }],
      }),
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?match=m1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Quick tag: Punish' })).toBeInTheDocument(),
    );
    const panel = screen.getByRole('region', { name: 'Quick tags' });

    // (1) Customize the Quick Tags panel to add a brand-new custom tag —
    // this is device-local (`vodPrefs.ts`) and touches NO match/note data,
    // so it never goes through updateMatch/invalidateQueries at all.
    await user.click(within(panel).getByRole('button', { name: 'Customize quick tags' }));
    await user.click(within(panel).getByRole('combobox', { name: 'Add a tag' }));
    await user.type(screen.getByPlaceholderText('Search or create a tag...'), 'my-quick-custom');
    await user.click(await screen.findByRole('option', { name: 'Create "my-quick-custom"' }));
    await user.click(within(panel).getByRole('button', { name: 'Save quick tags' }));
    expect(updateMatch).not.toHaveBeenCalled();

    // (2) The tag was never applied to any note yet — it must still be
    // offered in note A's regular add-combobox, since from the user's
    // perspective they already "added" it.
    const noteARow = screen.getByText('note A').closest('li')!;
    await user.click(within(noteARow).getByRole('combobox', { name: 'Add a tag' }));
    expect(await screen.findByRole('option', { name: 'my-quick-custom' })).toBeInTheDocument();
  });

  it('customizes the quick-tag panel (adds a custom tag, removes a preset) via an explicit Save, persisting only on Save', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?match=m1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Quick tag: Punish' })).toBeInTheDocument(),
    );
    const panel = screen.getByRole('region', { name: 'Quick tags' });

    // (1) Entering customize mode with no edits yet reads "Done", not
    // "Save" — nothing to persist.
    await user.click(within(panel).getByRole('button', { name: 'Customize quick tags' }));
    expect(
      within(panel).queryByRole('button', { name: 'Quick tag: Punish' }),
    ).not.toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Finish customizing quick tags' }),
    ).toHaveTextContent('Done');

    // (2) Remove the "Punish" preset via its chip X — this is a LOCAL draft
    // edit, not yet persisted.
    await user.click(within(panel).getByRole('button', { name: 'Remove Punish from quick tags' }));
    expect(window.localStorage.getItem('smash-tracker.vodQuickTags')).toBeNull();

    // (3) Once dirty, the primary button becomes "Save" and a sibling
    // "Cancel" appears.
    expect(within(panel).getByRole('button', { name: 'Save quick tags' })).toHaveTextContent(
      'Save',
    );
    expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    // (4) Add a freeform custom tag via the reused TagAddCombobox (scoped
    // to the panel — SelectedMatchMeta renders its OWN "Add a tag" combobox
    // for match-level tags). Still not persisted.
    await user.click(within(panel).getByRole('combobox', { name: 'Add a tag' }));
    await user.type(screen.getByPlaceholderText('Search or create a tag...'), 'my-custom-tag');
    await user.click(await screen.findByText('Create "my-custom-tag"'));
    expect(window.localStorage.getItem('smash-tracker.vodQuickTags')).toBeNull();

    // (5) Save persists the draft and exits customize mode — the button row
    // reflects the new set (Punish gone, the custom tag present).
    await user.click(within(panel).getByRole('button', { name: 'Save quick tags' }));
    expect(
      within(panel).queryByRole('button', { name: 'Quick tag: Punish' }),
    ).not.toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Quick tag: my-custom-tag' }),
    ).toBeInTheDocument();

    const stored = JSON.parse(window.localStorage.getItem('smash-tracker.vodQuickTags')!);
    expect(stored).not.toContain('punish');
    expect(stored).toContain('my-custom-tag');
  });

  it('Cancel discards quick-tag customize edits without persisting, reverting to the pre-edit set', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?match=m1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Quick tag: Punish' })).toBeInTheDocument(),
    );
    const panel = screen.getByRole('region', { name: 'Quick tags' });

    await user.click(within(panel).getByRole('button', { name: 'Customize quick tags' }));
    await user.click(within(panel).getByRole('button', { name: 'Remove Punish from quick tags' }));
    expect(
      within(panel).queryByRole('button', { name: 'Remove Punish from quick tags' }),
    ).not.toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));

    // Reverted to the pre-edit set — Punish is back — and nothing persisted.
    expect(within(panel).getByRole('button', { name: 'Quick tag: Punish' })).toBeInTheDocument();
    expect(window.localStorage.getItem('smash-tracker.vodQuickTags')).toBeNull();
  });

  it('toggles the player between compact and fill via a pure className swap (no remount) and persists the choice', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    const Player = vi.fn(function (this: unknown) {
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));

    // (1) Defaults to compact (retest fix-up #1) — the toggle offers to
    // switch TO full-size.
    const toggle = screen.getByRole('button', { name: 'Switch to full-size player' });
    await user.click(toggle);

    // (2) The toggle flips its own label/icon and the choice persists —
    // but the player itself is NEVER reconstructed by a size change.
    expect(screen.getByRole('button', { name: 'Switch to compact player' })).toBeInTheDocument();
    expect(Player).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('smash-tracker.vodPlayerSize')).toBe('fill');

    // (3) Toggling back to compact also never remounts.
    await user.click(screen.getByRole('button', { name: 'Switch to compact player' }));
    expect(screen.getByRole('button', { name: 'Switch to full-size player' })).toBeInTheDocument();
    expect(Player).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('smash-tracker.vodPlayerSize')).toBe('compact');
  });

  it('compact mode applies the lg+ combination-rail grid placement to the quick-tags and timestamp-list rails (fill mode does not)', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?match=m1');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Switch to full-size player' }),
      ).toBeInTheDocument(),
    );

    // (1) Compact mode (now the default, retest fix-up #1) already applies
    // the lg+ two-column rail placement — the shared rail wrapper (retest
    // fix-up #7: quick tags + notes now share ONE flex column so notes can
    // fill whatever height quick tags doesn't use) carries the grid
    // placement; the notes rail scrolls internally rather than growing the
    // page.
    const rail = screen.getByTestId('vod-rail');
    const quickTagRail = screen.getByTestId('vod-quicktag-rail');
    const timestampRail = screen.getByTestId('vod-timestamp-rail');
    expect(rail.className).toContain('lg:col-start-2');
    expect(rail.className).toContain('lg:row-start-1');
    expect(rail.className).toContain('lg:flex-col');
    expect(rail.className).toContain('lg:self-stretch');
    expect(timestampRail.className).toContain('lg:flex-1');
    expect(timestampRail.className).toContain('lg:min-h-0');
    expect(timestampRail.className).toContain('lg:overflow-y-auto');

    // (2) Switching to fill removes the grid/rail classes.
    await user.click(screen.getByRole('button', { name: 'Switch to full-size player' }));
    expect(rail.className).not.toContain('lg:col-start-2');
    expect(quickTagRail.className).not.toContain('lg:shrink-0');
    expect(timestampRail.className).not.toContain('lg:flex-1');

    // (3) The single VodPlayer instance mounted throughout — the layout
    // swap is a pure className change, never a remount.
    expect(window.YT!.Player).toHaveBeenCalledTimes(1);
  });

  it('retest fix-up #6: the "Add a note" composer is a sticky header above the note list, in both rail and stacked layouts', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ id: 'n1', seconds: 30, note: 'note A' }],
      }),
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(screen.getByText('note A')).toBeInTheDocument());

    // The composer's sticky wrapper is present regardless of playerSize —
    // `sticky` degrades gracefully to the document scroll when there's no
    // internal scrolling ancestor (stacked/fill layout), so it's never
    // conditionally applied only in compact+lg.
    const composerLabel = screen.getByText('Add a note');
    const stickyWrapper = composerLabel.closest('div')?.parentElement;
    expect(stickyWrapper?.className).toContain('sticky');
    expect(stickyWrapper?.className).toContain('top-0');
  });

  it('Prev/Next timestamp buttons seek to and select the previous/next time-sorted note, clamped at the boundaries', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A' },
          { id: 'n2', seconds: 90, note: 'note B' },
          { id: 'n3', seconds: 150, note: 'note C' },
        ],
      }),
    ]);

    const seekTo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo,
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    const prevButton = screen.getByRole('button', { name: 'Previous note' });
    const nextButton = screen.getByRole('button', { name: 'Next note' });

    // (1) Nothing selected yet — Next jumps to the FIRST note.
    await user.click(nextButton);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(30, true));

    // (2) Next again moves forward to the second note.
    await user.click(nextButton);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(90, true));

    // (3) Next again reaches the LAST note; clamped there — a further Next
    // stays on the last note (re-seeks to the same position, never walks
    // off the end).
    await user.click(nextButton);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(150, true));
    seekTo.mockClear();
    await user.click(nextButton);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(150, true));

    // (4) Prev walks back from the clamped last selection.
    await user.click(prevButton);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(90, true));
  });

  it('disables the Prev/Next timestamp buttons when the selected match has zero notes', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?match=m1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Previous note' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Previous note' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next note' })).toBeDisabled();
  });

  it('retest fix-up #9: applying a tag filter that excludes the current selection auto-selects the first still-visible match instead of going blank', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123',
        tags: ['practice-friendlies'],
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=xyz789',
      }),
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    // m2 (newest, untagged) is selected via deep-link.
    renderVodManager('/vod?match=m2');
    await waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());

    // Filtering to the "Practice/Friendlies" tag excludes m2 (untagged) —
    // only m1 remains visible.
    await user.click(screen.getByRole('button', { name: 'Practice/Friendlies' }));

    // The panel must NOT go blank ("Select a match") — it auto-selects the
    // first (only) still-visible match, m1.
    await waitFor(() => expect(screen.getByText('vs. rival-one')).toBeInTheDocument());
    expect(screen.queryByText('Select a match to watch its VOD.')).not.toBeInTheDocument();
  });

  it('retest fix-up #9: cold-open with no ?match= still auto-selects the first visible match (unaffected)', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=xyz789',
      }),
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    // No `?match=` at all — Library sorts newest-first by default, so m2 auto-selects.
    renderVodManager('/vod');
    await waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());
  });

  it('retest fix-up #11: the Twitch proactive end-guard advances to the next match ~1.5s before the video truly ends, without ENDED ever needing to fire', async () => {
    vi.useFakeTimers();
    try {
      // Library sorts "newest" by default (no playlist active) — m1 (later
      // `time`) must sort FIRST so it has a "next" (m2) to advance to.
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          opponent: 'rival-one',
          time: 1_700_000_100_000,
          vodUrl: 'https://twitch.tv/videos/98765',
        }),
        makeMatch({
          id: 'm2',
          opponent: 'rival-two',
          time: 1_700_000_000_000,
          vodUrl: 'https://youtube.com/watch?v=xyz789',
        }),
      ]);

      let currentTime = 0;
      const getCurrentTime = vi.fn(() => currentTime);
      const getDuration = vi.fn(() => 125);
      const listeners: Record<string, () => void> = {};
      const addEventListener = vi.fn((event: string, callback: () => void) => {
        listeners[event] = callback;
      });
      const TwitchPlayer = vi.fn(function (this: unknown): TwitchPlayerInstance {
        return { seek: vi.fn(), pause: vi.fn(), addEventListener, getCurrentTime, getDuration };
      });
      (TwitchPlayer as unknown as { READY: string; ENDED: string }).READY = 'ready';
      (TwitchPlayer as unknown as { READY: string; ENDED: string }).ENDED = 'ended';
      window.Twitch = { Player: TwitchPlayer as unknown as TwitchGlobal['Player'] };

      const ytConfigs: YouTubePlayerConfig[] = [];
      const YTPlayer = vi.fn(function (
        this: unknown,
        _el: HTMLElement,
        config: YouTubePlayerConfig,
      ): YouTubePlayerInstance {
        ytConfigs.push(config);
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      });
      window.YT = {
        Player: YTPlayer as unknown as YTGlobal['Player'],
        PlayerState: { ENDED: 0 },
      };

      renderVodManager('/vod?match=m1');
      await vi.waitFor(() => expect(TwitchPlayer).toHaveBeenCalledTimes(1));
      act(() => {
        listeners.ready?.();
      });
      await vi.waitFor(() => expect(screen.getByText('vs. rival-one')).toBeInTheDocument());

      // Crosses duration(125) - 1.5s while the player is still safely
      // non-ended — the real `ended` listener is NEVER invoked in this test.
      currentTime = 124;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      // Different identity (YouTube xyz789) — the guard trip advances via
      // the SAME path ENDED uses, requesting autoplay on the new
      // construction.
      await vi.waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());
      expect(YTPlayer).toHaveBeenCalledTimes(1);
      expect(ytConfigs[0]?.playerVars?.autoplay).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retest fix-up #11: with no next match, the Twitch proactive end-guard pauses in place (never seeks) and still flags drift for reselect recovery', async () => {
    vi.useFakeTimers();
    try {
      listMatches.mockResolvedValue([
        makeMatch({
          id: 'm1',
          opponent: 'rival-one',
          vodUrl: 'https://twitch.tv/videos/98765',
        }),
      ]);

      let currentTime = 0;
      const getCurrentTime = vi.fn(() => currentTime);
      const getDuration = vi.fn(() => 125);
      const seek = vi.fn();
      const pause = vi.fn();
      const destroy = vi.fn();
      const listeners: Record<string, () => void> = {};
      const addEventListener = vi.fn((event: string, callback: () => void) => {
        listeners[event] = callback;
      });
      const configs: TwitchPlayerConfig[] = [];
      const Player = vi.fn(function (
        this: unknown,
        _el: HTMLElement,
        config: TwitchPlayerConfig,
      ): TwitchPlayerInstance {
        configs.push(config);
        return { seek, pause, addEventListener, destroy, getCurrentTime, getDuration };
      });
      (Player as unknown as { READY: string; ENDED: string }).READY = 'ready';
      (Player as unknown as { READY: string; ENDED: string }).ENDED = 'ended';
      window.Twitch = { Player: Player as unknown as TwitchGlobal['Player'] };

      renderVodManager('/vod?match=m1');
      await vi.waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
      act(() => {
        listeners.ready?.();
      });
      await vi.waitFor(() => expect(screen.getByText('vs. rival-one')).toBeInTheDocument());

      currentTime = 124;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      // Plain pause in place — never the pauseAtEnd seek-back workaround
      // (only needed once the player has ALREADY entered the ended state,
      // which the proactive guard prevents entirely).
      await vi.waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
      expect(seek).not.toHaveBeenCalled();
      expect(Player).toHaveBeenCalledTimes(1);

      // Drift is still flagged — reselecting the SAME match forces a fresh
      // player construction (second layer of hijack recovery). Plain
      // `fireEvent.click` (not `userEvent`, which deadlocks against fake
      // timers here) — a synchronous DOM click is all this needs.
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Select match vs rival-one' }));
      });
      await vi.waitFor(() => expect(Player).toHaveBeenCalledTimes(2));
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(configs[1]?.video).toBe('98765');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retest fix-up #12: toggling a note-tag filter chip hides non-matching notes, and Prev/Next timestamp navigation only visits the VISIBLE set', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A', tags: ['mistake'] },
          { id: 'n2', seconds: 90, note: 'note B', tags: ['punish'] },
          { id: 'n3', seconds: 150, note: 'note C', tags: ['mistake'] },
        ],
      }),
    ]);

    const seekTo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo,
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // All three notes render initially.
    expect(screen.getByText('note A')).toBeInTheDocument();
    expect(screen.getByText('note B')).toBeInTheDocument();
    expect(screen.getByText('note C')).toBeInTheDocument();

    // (1) Toggling the "Mistake" filter chip hides note B (punish-only).
    await user.click(screen.getByRole('button', { name: 'Filter notes by Mistake' }));
    expect(screen.getByText('note A')).toBeInTheDocument();
    expect(screen.queryByText('note B')).not.toBeInTheDocument();
    expect(screen.getByText('note C')).toBeInTheDocument();

    // (2) Prev/Next TIMESTAMP navigation only visits the VISIBLE (filtered)
    // notes — Next skips straight from note A (30s) to note C (150s),
    // never landing on the filtered-out note B (90s).
    const nextButton = screen.getByRole('button', { name: 'Next note' });
    await user.click(nextButton);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(30, true));
    await user.click(nextButton);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(150, true));

    // (3) Clearing the filter (toggling the same chip off) shows all notes
    // again.
    await user.click(screen.getByRole('button', { name: 'Filter notes by Mistake' }));
    expect(screen.getByText('note B')).toBeInTheDocument();
  });

  it('retest fix-up #12: editing a note while a tag filter is active PATCHes the CORRECT underlying note (index mapping survives filtering)', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A', tags: ['mistake'] },
          { id: 'n2', seconds: 90, note: 'note B', tags: ['punish'] },
          { id: 'n3', seconds: 150, note: 'note C', tags: ['mistake'] },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // Filter to "Mistake" — hides note B, leaving note A and note C
    // visible, in that order.
    await user.click(screen.getByRole('button', { name: 'Filter notes by Mistake' }));
    expect(screen.queryByText('note B')).not.toBeInTheDocument();

    // Editing note C — the SECOND VISIBLE row, but the THIRD underlying
    // note (150s, id n3) — must dispatch update-by-id at that exact note,
    // leaving A/B untouched (id addressing survives filtering trivially).
    await user.click(screen.getByLabelText('Edit timestamp 2:30'));
    const noteInput = screen.getByLabelText('Edit timestamp note');
    await user.clear(noteInput);
    await user.type(noteInput, 'note C edited{Enter}');

    await waitFor(() => expect(updateNote).toHaveBeenCalledTimes(1));
    expect(updateNote).toHaveBeenCalledWith('m1', 'n3', {
      seconds: 150,
      note: 'note C edited',
      tags: ['mistake'],
    });
    expect(updateMatch).not.toHaveBeenCalled();
  });

  it('retest fix-up #12: deleting a note while a tag filter is active removes the CORRECT underlying note (index mapping survives filtering)', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { id: 'n1', seconds: 30, note: 'note A', tags: ['mistake'] },
          { id: 'n2', seconds: 90, note: 'note B', tags: ['punish'] },
          { id: 'n3', seconds: 150, note: 'note C', tags: ['mistake'] },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Filter notes by Mistake' }));
    expect(screen.queryByText('note B')).not.toBeInTheDocument();

    // Deleting note C (second visible row, third underlying note, id n3).
    await user.click(screen.getByLabelText('Delete timestamp 2:30'));
    const alert = await screen.findByRole('alertdialog');
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));

    // note A and note B (the filtered-OUT note) both survive untouched —
    // only note C (the note actually clicked) is deleted, by its id.
    await waitFor(() => expect(deleteNote).toHaveBeenCalledTimes(1));
    expect(deleteNote).toHaveBeenCalledWith('m1', 'n3');
    expect(updateMatch).not.toHaveBeenCalled();
  });

  it('retest fix-up #12: the note-tag filter chip row is hidden entirely when no note on the match has any tag', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ id: 'n1', seconds: 30, note: 'note A' }],
      }),
    ]);

    window.YT = {
      Player: vi.fn(function (this: unknown) {
        return {
          seekTo: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo: vi.fn(),
          destroy: vi.fn(),
          getCurrentTime: vi.fn(() => 0),
        };
      }) as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(screen.getByText('note A')).toBeInTheDocument());

    // No note has any tag — the filter chip row never renders.
    expect(screen.queryByText('Filter by tag')).not.toBeInTheDocument();
  });
});

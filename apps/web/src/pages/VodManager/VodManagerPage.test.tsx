import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { VodManagerPage } from './VodManagerPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import type { YouTubePlayerConfig, YouTubePlayerInstance } from '@/lib/useVodPlayer';

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

/** Removes any injected vendor scripts/globals so the useVodPlayer module-level singleton loaders start clean for every test. */
function resetVendorGlobals() {
  document.head.querySelectorAll('script').forEach((el) => el.remove());
  delete (window as { YT?: unknown }).YT;
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

  it('LIST-04: ENDED is a no-op when the selected match is the LAST one in the visible list (no next match to advance to)', async () => {
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
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onStateChange?.({ data: window.YT!.PlayerState.ENDED });
    });

    // No next match in the visible list — ENDED must not attempt to
    // advance or remount.
    expect(Player).toHaveBeenCalledTimes(1);
    expect(screen.getByText('vs. rival-one')).toBeInTheDocument();
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

  it('adds a timestamp note via the inline composer, prefilled from the live position, sorted ascending, carrying through other match fields', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [{ seconds: 900, note: 'existing note' }],
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

    // (3) Enter on the note input saves — single carry-through PATCH.
    await user.type(noteInput, 'new note{Enter}');

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    // Other match fields survive the PATCH untouched.
    expect(input.win).toBe(true);
    expect(input.fighter_id).toBe(mario.id);
    expect(input.gsp).toBe(1_234_567);
    // (4) Ascending sort: the new 754s note lands BEFORE the existing 900s note.
    expect(input.vodTimestamps).toEqual([
      { seconds: 754, note: 'new note' },
      { seconds: 900, note: 'existing note' },
    ]);

    // Adding a note must never pause/interrupt playback.
    expect(playVideo).not.toHaveBeenCalled();
  });

  it('edits a timestamp note in place (no dialog), re-sorting ascending, via a single full-carry-through PATCH', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [
          { seconds: 30, note: 'note A' },
          { seconds: 90, note: 'note B' },
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

    // (2) Editing the time to sort before note A, then Enter commits.
    await user.clear(timeInput);
    await user.type(timeInput, '0:10{Enter}');

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    // Every other match field is carried through unchanged.
    expect(input.win).toBe(true);
    expect(input.fighter_id).toBe(mario.id);
    expect(input.gsp).toBe(1_234_567);
    // The edited entry (now 10s) re-sorts ahead of note A (30s).
    expect(input.vodTimestamps).toEqual([
      { seconds: 10, note: 'note B' },
      { seconds: 30, note: 'note A' },
    ]);
  });

  it('discards an in-place edit on Escape without mutating', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { seconds: 30, note: 'note A' },
          { seconds: 90, note: 'note B' },
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

    expect(updateMatch).not.toHaveBeenCalled();
    // Edit mode closed with no value change — the pencil affordance and
    // original note text are back, the edit inputs are gone.
    expect(screen.queryByLabelText('Edit timestamp time')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Edit timestamp 1:30')).toBeInTheDocument();
    expect(screen.getByText('note B')).toBeInTheDocument();
  });

  it('removes a note via an AlertDialog confirm (not an immediate delete), via a single full-carry-through PATCH', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { seconds: 30, note: 'note A' },
          { seconds: 90, note: 'note B' },
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
    expect(updateMatch).not.toHaveBeenCalled();
    expect(screen.getByText('note B')).toBeInTheDocument();

    // (3) Confirming removes the note via the same full-carry-through PATCH.
    await user.click(screen.getByLabelText('Delete timestamp 1:30'));
    const alert2 = await screen.findByRole('alertdialog');
    await user.click(within(alert2).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.vodTimestamps).toEqual([{ seconds: 30, note: 'note A' }]);
  });

  it('renders note tag chips and adds a preset tag via the note combobox, carrying other notes and match fields through without seeking', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [
          { seconds: 30, note: 'note A', tags: ['punish'] },
          { seconds: 90, note: 'note B' },
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
    // another preset PATCHes both tags onto note A, carrying note B and
    // other match fields through unchanged — and never seeks/selects.
    await user.click(within(noteARow).getByRole('combobox', { name: 'Add a tag' }));
    await user.click(await screen.findByRole('option', { name: 'Edgeguard' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.vodTimestamps).toEqual([
      { seconds: 30, note: 'note A', tags: ['punish', 'edgeguard'] },
      { seconds: 90, note: 'note B' },
    ]);
    expect(input.gsp).toBe(1_234_567);
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('removes a note tag via the chip X, omitting tags from that note only, without disturbing other notes', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { seconds: 30, note: 'note A', tags: ['punish'] },
          { seconds: 90, note: 'note B', tags: ['mistake'] },
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

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.vodTimestamps).toEqual([
      { seconds: 30, note: 'note A' },
      { seconds: 90, note: 'note B', tags: ['mistake'] },
    ]);
  });

  it("a newly-created custom tag appears in a DIFFERENT note's add-combobox after the matches list refetches", async () => {
    const user = userEvent.setup();

    // Dynamic mock: `listMatches`/`updateMatch` mirror a real backend (the
    // PATCH mutates server-side state, and a subsequent GET reflects it) —
    // unlike this file's usual static `mockResolvedValue`, which always
    // resolves to the SAME fixture and so can never expose a real
    // stale-cache bug (the fix under test).
    let storedMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [
        { seconds: 30, note: 'note A' },
        { seconds: 90, note: 'note B' },
      ],
    });
    listMatches.mockImplementation(() => Promise.resolve([storedMatch]));
    updateMatch.mockImplementation((_id: string, input: Record<string, unknown>) => {
      storedMatch = { ...storedMatch, ...input };
      return Promise.resolve({ ...storedMatch, id: 'm1' });
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

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
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
          { seconds: 30, note: 'note A' },
          { seconds: 90, note: 'note B' },
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
        vodTimestamps: [{ seconds: 30, note: 'note A' }],
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
    expect(input.vodTimestamps).toEqual([{ seconds: 30, note: 'note A' }]);

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
        vodTimestamps: [{ seconds: 30, note: 'note A' }],
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
    // updateMatch's onSuccess) actually reflects the just-PATCHed note —
    // needed here (unlike the read-only-of-call-args tests above) because
    // this test asserts on the freshly-inserted row's rendered edit state,
    // which only appears once TimestampList re-renders with the updated
    // vodTimestamps array.
    let currentMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ seconds: 900, note: 'existing note' }],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));
    updateMatch.mockImplementation((...args: unknown[]) => {
      const input = args[1] as Record<string, unknown>;
      currentMatch = { ...currentMatch, ...input };
      return Promise.resolve(currentMatch);
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
    // EXISTING single-PATCH site.
    await user.click(screen.getByRole('button', { name: 'Quick tag: Punish' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.vodTimestamps).toEqual([
      { seconds: 754, note: '', tags: ['punish'] },
      { seconds: 900, note: 'existing note' },
    ]);

    // (2) The freshly-captured row (754s, sorted first) opens in edit mode.
    const noteInput = await screen.findByLabelText('Edit timestamp note');
    expect(noteInput).toHaveValue('');
    expect(screen.getByLabelText('Edit timestamp time')).toHaveValue('12:34');

    // (3) Typing text and pressing Enter commits it via the same PATCH site.
    await user.type(noteInput, 'clean edgeguard{Enter}');
    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(2));
    const [, secondInput] = updateMatch.mock.calls[1] as [string, Record<string, unknown>];
    expect(secondInput.vodTimestamps).toEqual([
      { seconds: 754, note: 'clean edgeguard', tags: ['punish'] },
      { seconds: 900, note: 'existing note' },
    ]);
  });

  it('retest fix-up #2: quick-tag capture pauses the player at the captured moment WITHOUT seeking, even after the refetch it triggers', async () => {
    const user = userEvent.setup();
    // Same mutable "server" record + dynamic mock pattern as the capture
    // test above — REQUIRED to reproduce the reported bug: a static
    // `mockResolvedValue` always resolves the SAME fixture object, so the
    // `selectedMatch` reference never actually changes on refetch and the
    // bug (reposition effect keyed on object identity) can never surface.
    let currentMatch = makeMatch({
      id: 'm1',
      opponent: 'rival-one',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ seconds: 900, note: 'existing note' }],
    });
    listMatches.mockImplementation(() => Promise.resolve([currentMatch]));
    updateMatch.mockImplementation((...args: unknown[]) => {
      const input = args[1] as Record<string, unknown>;
      currentMatch = { ...currentMatch, ...input };
      return Promise.resolve(currentMatch);
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

    // The PATCH's onSuccess invalidateQueries refetch resolves, producing a
    // BRAND NEW `matches`/`selectedMatch` object even though the selected
    // match id (m1) never changed. The reposition effect must recognize
    // this is NOT a match switch and never seek — reproducing the reported
    // "player resets to 0:00" bug if it does.
    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText('Edit timestamp note')).toBeInTheDocument());
    expect(seekTo).not.toHaveBeenCalled();
    // Only ONE player construction throughout — no remount either.
    expect(Player).toHaveBeenCalledTimes(1);
  });

  it('blocks a quick-tag capture once the match is at the MAX_TIMESTAMPS cap, via the existing cap toast', async () => {
    const user = userEvent.setup();
    const twentyExisting = Array.from({ length: 20 }, (_, i) => ({
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

    // Already at the 20-note cap — the click must not PATCH a 21st note.
    expect(updateMatch).not.toHaveBeenCalled();
  });

  it("a custom tag added via Quick Tags Customize is immediately offered in a note's OWN add-combobox, even before it is ever captured onto a note", async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 30, note: 'note A' }],
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
    // the lg+ two-column rail placement — quick tags in the rail's top cell,
    // timestamp list in the bottom cell, scrollable rather than growing the
    // page.
    const quickTagRail = screen.getByTestId('vod-quicktag-rail');
    const timestampRail = screen.getByTestId('vod-timestamp-rail');
    expect(quickTagRail.className).toContain('lg:col-start-2');
    expect(quickTagRail.className).toContain('lg:row-start-1');
    expect(timestampRail.className).toContain('lg:col-start-2');
    expect(timestampRail.className).toContain('lg:overflow-y-auto');

    // (2) Switching to fill removes the grid/rail classes from both rails.
    await user.click(screen.getByRole('button', { name: 'Switch to full-size player' }));
    expect(quickTagRail.className).not.toContain('lg:col-start-2');
    expect(timestampRail.className).not.toContain('lg:col-start-2');

    // (3) The single VodPlayer instance mounted throughout — the layout
    // swap is a pure className change, never a remount.
    expect(window.YT!.Player).toHaveBeenCalledTimes(1);
  });

  it('Prev/Next timestamp buttons seek to and select the previous/next time-sorted note, clamped at the boundaries', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { seconds: 30, note: 'note A' },
          { seconds: 90, note: 'note B' },
          { seconds: 150, note: 'note C' },
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
});

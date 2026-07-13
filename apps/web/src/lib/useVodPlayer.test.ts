import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  TwitchPlayerConfig,
  TwitchPlayerInstance,
  YouTubePlayerConfig,
  YouTubePlayerInstance,
} from './useVodPlayer';

type YTGlobal = NonNullable<Window['YT']>;
type TwitchGlobal = NonNullable<Window['Twitch']>;

/** Removes any injected vendor scripts and globals between tests so the
 * module-level singleton loaders (reset via `vi.resetModules()`) start
 * clean for every test. */
function resetVendorGlobals() {
  document.head.querySelectorAll('script').forEach((el) => el.remove());
  delete (window as { YT?: unknown }).YT;
  delete (window as { Twitch?: unknown }).Twitch;
  delete (window as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
}

describe('useVodPlayer', () => {
  beforeEach(() => {
    vi.resetModules();
    resetVendorGlobals();
  });

  afterEach(() => {
    resetVendorGlobals();
  });

  it('constructs a YT.Player for a youtube vodUrl and gates seek behind onReady', async () => {
    const seekTo = vi.fn();
    const playVideo = vi.fn();
    const pauseVideo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    // `function`, not an arrow, so `new window.YT.Player(...)` can construct it.
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return { seekTo, playVideo, pauseVideo, destroy: vi.fn(), getCurrentTime: vi.fn(() => 42) };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result } = renderHook(() =>
      useVodPlayer({ vodUrl: 'https://www.youtube.com/watch?v=abc123' }),
    );
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.videoId).toBe('abc123');

    // seek() before ready must be a no-op, not throw.
    act(() => {
      result.current.seek(42);
    });
    expect(seekTo).not.toHaveBeenCalled();

    // pause() before ready must also be a no-op, not throw.
    act(() => {
      result.current.pause();
    });
    expect(pauseVideo).not.toHaveBeenCalled();

    act(() => {
      capturedConfig?.events?.onReady?.();
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    act(() => {
      result.current.seek(42);
    });
    expect(seekTo).toHaveBeenCalledWith(42, true);
    expect(playVideo).toHaveBeenCalled();

    act(() => {
      result.current.pause();
    });
    expect(pauseVideo).toHaveBeenCalledTimes(1);

    // getCurrentTime() reads the live position once ready (Math.floor'd).
    expect(result.current.getCurrentTime()).toBe(42);
  });

  it('getCurrentTime() returns 0 without throwing before the player is ready (Pitfall 3 guard)', async () => {
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
        getCurrentTime: vi.fn(() => 99),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'], PlayerState: { ENDED: 0 } };

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result } = renderHook(() =>
      useVodPlayer({ vodUrl: 'https://www.youtube.com/watch?v=abc123' }),
    );

    // Called before construction/onReady (containerRef never attached, so
    // the player never constructs) — must return 0, not throw.
    expect(() => result.current.getCurrentTime()).not.toThrow();
    expect(result.current.getCurrentTime()).toBe(0);
    expect(Player).not.toHaveBeenCalled();
    expect(capturedConfig).toBeUndefined();
    expect(result.current.getCurrentTime()).toBe(0);
  });

  it('constructs a Twitch.Player for a twitch vodUrl with a dynamic parent and gates seek/pause behind READY', async () => {
    const seek = vi.fn();
    const pause = vi.fn();
    const addEventListener = vi.fn((event: string, callback: () => void) => {
      if (event === 'ready') {
        readyCallback = callback;
      }
    });
    let readyCallback: (() => void) | undefined;
    let capturedConfig: TwitchPlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: TwitchPlayerConfig,
    ): TwitchPlayerInstance {
      capturedConfig = config;
      return { seek, pause, addEventListener, getCurrentTime: vi.fn(() => 10) };
    });
    // Real Twitch Embed API exposes the ready-event name as a constant on
    // the constructor (`Twitch.Player.READY === 'ready'`) — NOT the literal
    // string `'Twitch.Player.READY'`. This regression test guards against
    // hardcoding the wrong literal, which silently stops the ready callback
    // from ever firing (bug found via human-verify on the real deploy).
    (Player as unknown as { READY: string }).READY = 'ready';
    window.Twitch = { Player: Player as unknown as TwitchGlobal['Player'] };

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result } = renderHook(() => useVodPlayer({ vodUrl: 'https://twitch.tv/videos/98765' }));
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.video).toBe('98765');
    // Pitfall 4: parent must be derived from the actual serving hostname at
    // runtime, never a hardcoded domain.
    expect(capturedConfig?.parent).toContain(window.location.hostname);
    expect(addEventListener).toHaveBeenCalledWith('ready', expect.any(Function));

    act(() => {
      result.current.seek(10);
    });
    expect(seek).not.toHaveBeenCalled();

    act(() => {
      result.current.pause();
    });
    expect(pause).not.toHaveBeenCalled();

    act(() => {
      readyCallback?.();
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    act(() => {
      result.current.seek(10);
    });
    expect(seek).toHaveBeenCalledWith(10);

    act(() => {
      result.current.pause();
    });
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('reports an unsupported state and constructs no player for an unrecognized host', async () => {
    const YTPlayer = vi.fn();
    const TwitchPlayer = vi.fn();
    window.YT = {
      Player: YTPlayer as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };
    window.Twitch = { Player: TwitchPlayer as unknown as TwitchGlobal['Player'] };

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result } = renderHook(() => useVodPlayer({ vodUrl: 'https://example.com/video' }));

    await waitFor(() => expect(result.current.error).toBe('unsupported'));
    expect(result.current.isReady).toBe(false);
    expect(YTPlayer).not.toHaveBeenCalled();
    expect(TwitchPlayer).not.toHaveBeenCalled();
  });

  it('sets error state when a YouTube onError code indicates the video is unavailable', async () => {
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

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result } = renderHook(() =>
      useVodPlayer({ vodUrl: 'https://www.youtube.com/watch?v=deadvod' }),
    );
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));

    act(() => {
      capturedConfig?.events?.onError?.({ data: 100 });
    });

    await waitFor(() => expect(result.current.error).toBe('unavailable'));
  });

  it('loadYouTubeApi injects the iframe_api script only once across concurrent calls', async () => {
    const { loadYouTubeApi } = await import('./useVodPlayer');

    const first = loadYouTubeApi();
    const second = loadYouTubeApi();

    expect(
      document.head.querySelectorAll('script[src="https://www.youtube.com/iframe_api"]'),
    ).toHaveLength(1);

    window.onYouTubeIframeAPIReady?.();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('loadTwitchApi injects the embed script only once across concurrent calls', async () => {
    const { loadTwitchApi } = await import('./useVodPlayer');

    void loadTwitchApi();
    void loadTwitchApi();

    const scripts = document.head.querySelectorAll(
      'script[src="https://embed.twitch.tv/embed/v1.js"]',
    );
    expect(scripts).toHaveLength(1);
  });

  it('fires onEnded when YouTube reports the ENDED player state via the live SDK constant', async () => {
    const onEnded = vi.fn();
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
    // Real IFrame API exposes ENDED as a numeric constant (documented value
    // 0) off `YT.PlayerState` — read live, never hardcoded.
    window.YT = {
      Player: Player as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result } = renderHook(() =>
      useVodPlayer({ vodUrl: 'https://www.youtube.com/watch?v=abc123', onEnded }),
    );
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));

    // A non-ENDED state change must NOT fire onEnded.
    act(() => {
      capturedConfig?.events?.onStateChange?.({ data: 1 }); // PLAYING
    });
    expect(onEnded).not.toHaveBeenCalled();

    act(() => {
      capturedConfig?.events?.onStateChange?.({ data: window.YT!.PlayerState.ENDED });
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('fires onAutoplayBlocked when YouTube reports its onAutoplayBlocked event', async () => {
    const onAutoplayBlocked = vi.fn();
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
    window.YT = {
      Player: Player as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    const { useVodPlayer } = await import('./useVodPlayer');
    const autoplayOnConstructRef = { current: true };
    const { result } = renderHook(() =>
      useVodPlayer({
        vodUrl: 'https://www.youtube.com/watch?v=abc123',
        onAutoplayBlocked,
        autoplayOnConstructRef,
      }),
    );
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    // autoplayOnConstructRef.current is read inside the construction effect.
    expect(capturedConfig?.playerVars?.autoplay).toBe(1);

    act(() => {
      capturedConfig?.events?.onAutoplayBlocked?.();
    });
    expect(onAutoplayBlocked).toHaveBeenCalledTimes(1);
  });

  it('fires onEnded/onAutoplayBlocked when Twitch fires its live ENDED/PLAYBACK_BLOCKED event names', async () => {
    const onEnded = vi.fn();
    const onAutoplayBlocked = vi.fn();
    const listeners: Record<string, () => void> = {};
    const addEventListener = vi.fn((event: string, callback: () => void) => {
      listeners[event] = callback;
    });
    let capturedConfig: TwitchPlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: TwitchPlayerConfig,
    ): TwitchPlayerInstance {
      capturedConfig = config;
      return { seek: vi.fn(), pause: vi.fn(), addEventListener, getCurrentTime: vi.fn(() => 0) };
    });
    (Player as unknown as { READY: string; ENDED: string; PLAYBACK_BLOCKED: string }).READY =
      'ready';
    (Player as unknown as { READY: string; ENDED: string; PLAYBACK_BLOCKED: string }).ENDED =
      'ended';
    (
      Player as unknown as { READY: string; ENDED: string; PLAYBACK_BLOCKED: string }
    ).PLAYBACK_BLOCKED = 'playback_blocked';
    window.Twitch = { Player: Player as unknown as TwitchGlobal['Player'] };

    const { useVodPlayer } = await import('./useVodPlayer');
    const autoplayOnConstructRef = { current: true };
    const { result } = renderHook(() =>
      useVodPlayer({
        vodUrl: 'https://twitch.tv/videos/98765',
        onEnded,
        onAutoplayBlocked,
        autoplayOnConstructRef,
      }),
    );
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    // autoplayOnConstructRef.current is read inside the construction effect.
    expect(capturedConfig?.autoplay).toBe(true);
    expect(addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith('playback_blocked', expect.any(Function));

    act(() => {
      listeners.ended?.();
    });
    expect(onEnded).toHaveBeenCalledTimes(1);

    act(() => {
      listeners.playback_blocked?.();
    });
    expect(onAutoplayBlocked).toHaveBeenCalledTimes(1);
  });

  it('does not remount the player when autoplayOnConstructRef.current changes without an identity change', async () => {
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
    window.YT = {
      Player: Player as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    const { useVodPlayer } = await import('./useVodPlayer');
    const autoplayOnConstructRef = { current: false };
    const { result, rerender } = renderHook(
      () =>
        useVodPlayer({
          vodUrl: 'https://www.youtube.com/watch?v=abc123',
          autoplayOnConstructRef,
        }),
      { initialProps: undefined },
    );
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.playerVars?.autoplay).toBe(0);

    // Mutate the ref (mirrors handleEnded setting it true) and rerender
    // without changing the video identity — must NOT trigger a second
    // construction (the identity-keyed invariant); a mutated ref alone is
    // never a remount trigger.
    autoplayOnConstructRef.current = true;
    rerender(undefined);
    expect(Player).toHaveBeenCalledTimes(1);
  });

  it('forces a full player reconstruction when remountToken changes, even with an unchanged video identity (drift recovery)', async () => {
    let capturedConfig: YouTubePlayerConfig | undefined;
    const destroy = vi.fn();
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
        destroy,
        getCurrentTime: vi.fn(() => 0),
      };
    });
    window.YT = {
      Player: Player as unknown as YTGlobal['Player'],
      PlayerState: { ENDED: 0 },
    };

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result, rerender } = renderHook(
      ({ remountToken }: { remountToken: number }) =>
        useVodPlayer({ vodUrl: 'https://www.youtube.com/watch?v=abc123', remountToken }),
      { initialProps: { remountToken: 0 } },
    );
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    // Same vodUrl/identity — a plain rerender with an unchanged remountToken
    // must NOT reconstruct (the existing identity-keyed invariant).
    rerender({ remountToken: 0 });
    expect(Player).toHaveBeenCalledTimes(1);

    // Bumping remountToken (mirrors VodManagerPage's drift-recovery
    // handleSelect branch) forces a fresh construction: the old instance is
    // destroyed and a new one is built, even though the identity never
    // changed.
    result.current.containerRef.current = document.createElement('div');
    rerender({ remountToken: 1 });
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(2));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(capturedConfig?.videoId).toBe('abc123');
    // A fresh construction resets isReady until the new instance's onReady
    // fires again.
    expect(result.current.isReady).toBe(false);
  });

  it('pauseAtEnd() on YouTube just calls pauseVideo() and returns true (retest fix-up #1)', async () => {
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

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result } = renderHook(() =>
      useVodPlayer({ vodUrl: 'https://www.youtube.com/watch?v=abc123' }),
    );
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    let handled: boolean | undefined;
    act(() => {
      handled = result.current.pauseAtEnd();
    });
    expect(handled).toBe(true);
    expect(pauseVideo).toHaveBeenCalledTimes(1);
  });

  it('pauseAtEnd() on Twitch seeks back off the end then pauses, returning true (retest fix-up #1)', async () => {
    const seek = vi.fn();
    const pause = vi.fn();
    const getDuration = vi.fn(() => 125);
    const addEventListener = vi.fn((event: string, callback: () => void) => {
      if (event === 'ready') {
        readyCallback = callback;
      }
    });
    let readyCallback: (() => void) | undefined;
    let capturedConfig: TwitchPlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: TwitchPlayerConfig,
    ): TwitchPlayerInstance {
      capturedConfig = config;
      return { seek, pause, addEventListener, getCurrentTime: vi.fn(() => 0), getDuration };
    });
    (Player as unknown as { READY: string }).READY = 'ready';
    window.Twitch = { Player: Player as unknown as TwitchGlobal['Player'] };

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result } = renderHook(() => useVodPlayer({ vodUrl: 'https://twitch.tv/videos/98765' }));
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.video).toBe('98765');
    act(() => {
      readyCallback?.();
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    let handled: boolean | undefined;
    act(() => {
      handled = result.current.pauseAtEnd();
    });
    expect(handled).toBe(true);
    // Twitch's own ENDED-state pause() ignore quirk means a plain pause is
    // insufficient — seek back off the very end (duration - 1) first, THEN
    // pause, so the seek exits the ended state before the pause commits.
    expect(seek).toHaveBeenCalledWith(124);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('pauseAtEnd() on Twitch returns false when getDuration is unavailable, without calling seek/pause (retest fix-up #1 fallback)', async () => {
    const seek = vi.fn();
    const pause = vi.fn();
    const addEventListener = vi.fn((event: string, callback: () => void) => {
      if (event === 'ready') {
        readyCallback = callback;
      }
    });
    let readyCallback: (() => void) | undefined;
    let capturedConfig: TwitchPlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: TwitchPlayerConfig,
    ): TwitchPlayerInstance {
      capturedConfig = config;
      // No getDuration on this instance — mirrors an embed API surface that
      // doesn't expose it.
      return { seek, pause, addEventListener, getCurrentTime: vi.fn(() => 0) };
    });
    (Player as unknown as { READY: string }).READY = 'ready';
    window.Twitch = { Player: Player as unknown as TwitchGlobal['Player'] };

    const { useVodPlayer } = await import('./useVodPlayer');
    const { result } = renderHook(() => useVodPlayer({ vodUrl: 'https://twitch.tv/videos/98765' }));
    result.current.containerRef.current = document.createElement('div');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.video).toBe('98765');
    act(() => {
      readyCallback?.();
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    let handled: boolean | undefined;
    act(() => {
      handled = result.current.pauseAtEnd();
    });
    expect(handled).toBe(false);
    expect(seek).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });
});

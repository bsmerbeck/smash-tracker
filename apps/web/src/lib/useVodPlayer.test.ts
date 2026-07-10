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
    let capturedConfig: YouTubePlayerConfig | undefined;
    // `function`, not an arrow, so `new window.YT.Player(...)` can construct it.
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return { seekTo, playVideo, destroy: vi.fn() };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

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

    act(() => {
      capturedConfig?.events?.onReady?.();
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    act(() => {
      result.current.seek(42);
    });
    expect(seekTo).toHaveBeenCalledWith(42, true);
    expect(playVideo).toHaveBeenCalled();
  });

  it('constructs a Twitch.Player for a twitch vodUrl with a dynamic parent and gates seek behind READY', async () => {
    const seek = vi.fn();
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
      return { seek, addEventListener };
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
      readyCallback?.();
    });
    await waitFor(() => expect(result.current.isReady).toBe(true));

    act(() => {
      result.current.seek(10);
    });
    expect(seek).toHaveBeenCalledWith(10);
  });

  it('reports an unsupported state and constructs no player for an unrecognized host', async () => {
    const YTPlayer = vi.fn();
    const TwitchPlayer = vi.fn();
    window.YT = { Player: YTPlayer as unknown as YTGlobal['Player'] };
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
      return { seekTo: vi.fn(), playVideo: vi.fn(), destroy: vi.fn() };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

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
});

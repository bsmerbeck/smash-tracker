import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { detectVodProvider, toTwitchDuration } from './vod';

/** Config shape accepted by the official `new YT.Player(el, config)` constructor. */
export interface YouTubePlayerConfig {
  videoId: string;
  width?: string | number;
  height?: string | number;
  playerVars?: {
    autoplay?: 0 | 1;
    start?: number;
    origin?: string;
  };
  events?: {
    onReady?: () => void;
    onStateChange?: (event: { data: number }) => void;
    onError?: (event: { data: number }) => void;
    /** Fires any time the browser blocks autoplay or a scripted playback
     * call (`autoplay` param, `loadPlaylist`, `loadVideoById`,
     * `loadVideoByUrl`, `playVideo`) — the authoritative "autoplay was
     * blocked" signal per the official IFrame API reference. */
    onAutoplayBlocked?: () => void;
  };
}

/** The subset of the YouTube IFrame Player instance API this hook uses. */
export interface YouTubePlayerInstance {
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  destroy(): void;
  /** Current playback position, in seconds. Source: developers.google.com/youtube/iframe_api_reference */
  getCurrentTime(): number;
}

/** Config shape accepted by the official `new Twitch.Player(el, config)` constructor. */
export interface TwitchPlayerConfig {
  video: string;
  parent: string[];
  autoplay?: boolean;
  width?: string | number;
  height?: string | number;
  /** Initial playback position, `1h2m3s`-style duration form (see `toTwitchDuration`). */
  time?: string;
}

/** The subset of the Twitch Embed Player instance API this hook uses. */
export interface TwitchPlayerInstance {
  seek(seconds: number): void;
  addEventListener(event: string, callback: () => void): void;
  destroy?(): void;
  /** Current playback position, in seconds. Source: dev.twitch.tv/docs/embed/video-and-clips */
  getCurrentTime(): number;
}

declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLElement, config: YouTubePlayerConfig) => YouTubePlayerInstance;
      /** Numeric player-state constants delivered via `onStateChange`'s
       * `event.data`. `ENDED`'s documented value is `0`, but this MUST
       * always be read off the live constant, never hardcoded — the
       * institutionalized READY-literal discipline (Phase 1). */
      PlayerState: {
        ENDED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
    Twitch?: {
      Player: (new (element: HTMLElement, config: TwitchPlayerConfig) => TwitchPlayerInstance) & {
        /** Event name string fired once the embedded player is ready to be
         * controlled. MUST be read off the constructor — the literal value
         * is not part of the public contract and has shipped as `'ready'`,
         * but relying on the constant keeps this correct if that changes. */
        READY: string;
        /** Event name string fired when the video or stream ends. Same
         * read-off-the-constructor discipline as READY. */
        ENDED: string;
        /** Event name string fired when playback is blocked — "usually
         * fired after an unmuted autoplay or unmuted programmatic call on
         * play()" per the official Embed API reference. Same
         * read-off-the-constructor discipline as READY. */
        PLAYBACK_BLOCKED: string;
      };
    };
  }
}

const YOUTUBE_IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';
const TWITCH_EMBED_API_SRC = 'https://embed.twitch.tv/embed/v1.js';

/** YouTube onError codes that mean the video is permanently unavailable (deleted, private,
 * region-locked, or embedding disabled by the owner) rather than a transient issue. */
const YOUTUBE_UNAVAILABLE_ERROR_CODES = new Set([2, 5, 100, 101, 150]);

let youtubeApiPromise: Promise<void> | null = null;

/**
 * Injects the YouTube IFrame API script (`iframe_api`) at most once per page
 * load and resolves once the global `onYouTubeIframeAPIReady` callback
 * fires. Concurrent/repeat callers share the same in-flight/resolved
 * promise — the callback is global and only fires once for the whole page
 * regardless of how many players are constructed.
 */
export function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) {
    return Promise.resolve();
  }
  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }
  youtubeApiPromise = new Promise((resolve) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = YOUTUBE_IFRAME_API_SRC;
    script.async = true;
    document.head.appendChild(script);
  });
  return youtubeApiPromise;
}

let twitchApiPromise: Promise<void> | null = null;

/**
 * Injects the Twitch Embed API script (`embed/v1.js`) at most once per page
 * load and resolves on script load. Twitch has no global "API ready"
 * callback — each `Twitch.Player` instance signals its OWN readiness via
 * the `Twitch.Player.READY` event once constructed.
 */
export function loadTwitchApi(): Promise<void> {
  if (window.Twitch?.Player) {
    return Promise.resolve();
  }
  if (twitchApiPromise) {
    return twitchApiPromise;
  }
  twitchApiPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = TWITCH_EMBED_API_SRC;
    script.async = true;
    script.addEventListener('load', () => resolve());
    document.head.appendChild(script);
  });
  return twitchApiPromise;
}

export type VodPlayerErrorState = 'unavailable' | 'unsupported';

export interface UseVodPlayerOptions {
  /** The match's raw stored VOD URL (YouTube/Twitch/anything else). */
  vodUrl: string;
  /** Initial playback position, in whole seconds. Only applied at construction time. */
  startSeconds?: number;
  /** Fires when the live player reports its ENDED state — gated on
   * `window.YT.PlayerState.ENDED` / `window.Twitch.Player.ENDED` (SDK
   * constants, never a hardcoded literal). */
  onEnded?: () => void;
  /** Fires when the browser blocks an autoplay-triggering call —
   * YouTube's `onAutoplayBlocked` event / Twitch's `PLAYBACK_BLOCKED`
   * event. The authoritative "show the native play-button fallback"
   * signal (never a timeout heuristic). */
  onAutoplayBlocked?: () => void;
  /** Read ONCE inside the construction effect body (closure-captured,
   * exactly like `startSeconds`) to request autoplay for that one
   * construction only. NEVER added to the identity-keyed effect's
   * dependency array — setting this does not, by itself, trigger a
   * remount; it only takes effect the next time construction actually
   * happens (i.e. a genuine video-identity change). */
  autoplayOnConstruct?: boolean;
}

export interface UseVodPlayerResult {
  /** Attach to the `<div>` the player should render into. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** True once the underlying platform player has fired its ready event. */
  isReady: boolean;
  /** `'unavailable'` (dead/private/region-locked VOD) or `'unsupported'` (non-YouTube/Twitch host), else `null`. */
  error: VodPlayerErrorState | null;
  /** Seeks the live player to `seconds`. No-op until `isReady` is true. */
  seek: (seconds: number) => void;
  /** Reads the live player's current position, in whole seconds. Returns
   * `0` (never throws) until `isReady` is true — a pure on-demand read, not
   * polled. */
  getCurrentTime: () => number;
}

/**
 * Ready-gated player-control hook wrapping the official YouTube IFrame API
 * and Twitch Embed API behind one `{ containerRef, isReady, error, seek }`
 * contract (PLAY-01/PLAY-02/PLAY-03).
 *
 * Invoked by `VodPlayer` (`apps/web/src/pages/VodManager/components/VodPlayer.tsx`).
 * Depends on `detectVodProvider` (`./vod`) to route to the correct vendor
 * API and on the singleton loaders above to avoid double-injecting either
 * vendor script.
 *
 * Per PITFALLS.md Pitfall 1, this hook is a DISTINCT layer from
 * `vodDeepLink`/`formatTimestamp` — those remain display/fallback-link
 * utilities only; this hook is the only thing that ever constructs or
 * seeks a live player instance.
 *
 * The player-construction effect is keyed on video IDENTITY
 * (`${provider}:${videoId}`), not on `vodUrl`/`startSeconds`/the whole
 * match object, so unrelated metadata edits never remount an in-progress
 * playback (PITFALLS.md UX row). This invariant is UNCHANGED by the
 * `onEnded`/`onAutoplayBlocked`/`autoplayOnConstruct` additions below:
 * `onEnded`/`onAutoplayBlocked` are stored in latest-value refs (updated
 * every render, mirroring `VodPlayer.tsx`'s `seekRef`/`getCurrentTimeRef`
 * population pattern) so they never need to appear in the construction
 * effect's deps, and `autoplayOnConstruct` is closure-captured ONCE per
 * construction exactly like `startSeconds` — none of the three ever
 * trigger their own remount.
 */
export function useVodPlayer({
  vodUrl,
  startSeconds,
  onEnded,
  onAutoplayBlocked,
  autoplayOnConstruct,
}: UseVodPlayerOptions): UseVodPlayerResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayerInstance | TwitchPlayerInstance | null>(null);
  const providerRef = useRef<'youtube' | 'twitch' | null>(null);
  const onEndedRef = useRef(onEnded);
  const onAutoplayBlockedRef = useRef(onAutoplayBlocked);
  useEffect(() => {
    onEndedRef.current = onEnded;
    onAutoplayBlockedRef.current = onAutoplayBlocked;
  });

  const detected = detectVodProvider(vodUrl);
  const identityKey =
    detected.provider != null ? `${detected.provider}:${detected.videoId}` : 'unsupported';

  const [trackedIdentityKey, setTrackedIdentityKey] = useState(identityKey);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<VodPlayerErrorState | null>(
    detected.provider === null ? 'unsupported' : null,
  );

  // Reset ready/error state during render when the video identity changes —
  // React's "adjusting state when a prop changes" pattern, not an effect, so
  // switching to a new match's video never flashes the PREVIOUS video's
  // stale ready/error state before the construction effect below re-runs.
  if (identityKey !== trackedIdentityKey) {
    setTrackedIdentityKey(identityKey);
    setIsReady(false);
    setError(detected.provider === null ? 'unsupported' : null);
  }

  useEffect(() => {
    if (detected.provider === null) {
      return;
    }

    let cancelled = false;
    playerRef.current = null;
    providerRef.current = null;

    if (detected.provider === 'youtube') {
      const videoId = detected.videoId;
      loadYouTubeApi().then(() => {
        if (cancelled || !containerRef.current || !window.YT) {
          return;
        }
        const player = new window.YT.Player(containerRef.current, {
          videoId,
          // Fill the aspect-video container (VodPlayer.tsx) instead of the
          // API's fixed 640x390 default.
          width: '100%',
          height: '100%',
          playerVars: {
            // autoplayOnConstruct is closure-captured here, exactly like
            // startSeconds below — read once for THIS construction only,
            // never re-consulted without a genuine identity-change remount.
            autoplay: autoplayOnConstruct ? 1 : 0,
            start: startSeconds ?? 0,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (!cancelled) {
                setIsReady(true);
              }
            },
            onStateChange: (event) => {
              if (!cancelled && window.YT && event.data === window.YT.PlayerState.ENDED) {
                onEndedRef.current?.();
              }
            },
            onError: (event) => {
              if (!cancelled && YOUTUBE_UNAVAILABLE_ERROR_CODES.has(event.data)) {
                setError('unavailable');
              }
            },
            onAutoplayBlocked: () => {
              if (!cancelled) {
                onAutoplayBlockedRef.current?.();
              }
            },
          },
        });
        playerRef.current = player;
        providerRef.current = 'youtube';
      });
    } else {
      const videoId = detected.videoId;
      loadTwitchApi().then(() => {
        if (cancelled || !containerRef.current || !window.Twitch) {
          return;
        }
        const player = new window.Twitch.Player(containerRef.current, {
          video: videoId,
          // Pitfall 4: Twitch refuses to render unless `parent` matches the
          // ACTUAL serving hostname — derive it at runtime, never hardcode a
          // single domain (breaks on localhost/preview-channel hosts).
          parent: [window.location.hostname],
          // autoplayOnConstruct is closure-captured here, exactly like
          // startSeconds below — read once for THIS construction only.
          autoplay: Boolean(autoplayOnConstruct),
          // Fill the aspect-video container (VodPlayer.tsx) instead of the
          // API's fixed 400x300 minimum.
          width: '100%',
          height: '100%',
          // Twitch's initial-position option takes the same `1h2m3s`
          // duration form as its `?t=` deep-link query param, not raw
          // seconds — see `toTwitchDuration`.
          time: toTwitchDuration(startSeconds ?? 0),
        });
        player.addEventListener(window.Twitch.Player.READY, () => {
          if (!cancelled) {
            setIsReady(true);
          }
        });
        player.addEventListener(window.Twitch.Player.ENDED, () => {
          if (!cancelled) {
            onEndedRef.current?.();
          }
        });
        player.addEventListener(window.Twitch.Player.PLAYBACK_BLOCKED, () => {
          if (!cancelled) {
            onAutoplayBlockedRef.current?.();
          }
        });
        playerRef.current = player;
        providerRef.current = 'twitch';
      });
    }

    return () => {
      cancelled = true;
      playerRef.current?.destroy?.();
      playerRef.current = null;
      providerRef.current = null;
    };
    // Intentionally keyed on video IDENTITY only (see doc comment above) —
    // startSeconds/autoplayOnConstruct/detected are captured via closure for
    // the initial construction and must NOT trigger a remount on their own.
    // onEndedRef/onAutoplayBlockedRef are refs (read via .current inside the
    // event handlers above), so they're intentionally excluded too — they
    // always resolve to the latest callback without needing to be a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  function seek(seconds: number) {
    if (!isReady || !playerRef.current) {
      return;
    }
    if (providerRef.current === 'youtube') {
      const player = playerRef.current as YouTubePlayerInstance;
      player.seekTo(seconds, true);
      player.playVideo();
    } else if (providerRef.current === 'twitch') {
      // Twitch's seek() is documented as VOD-only (does not work for live
      // streams) — safe here since VOD Manager only ever deals with VODs,
      // but flagged so this is never accidentally wired into a future
      // live-stream feature.
      (playerRef.current as TwitchPlayerInstance).seek(seconds);
    }
  }

  /** Pure on-demand read of the live player's position — mirrors `seek`'s
   * ready-gate guard exactly. Never added to the construction effect's deps
   * and never polled on an interval/timer (composer `onFocus`-only reads). */
  function getCurrentTime(): number {
    if (!isReady || !playerRef.current) {
      return 0;
    }
    return Math.floor(playerRef.current.getCurrentTime());
  }

  return { containerRef, isReady, error, seek, getCurrentTime };
}

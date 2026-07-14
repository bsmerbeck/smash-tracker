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
  /** Pauses playback. Official method name per
   * developers.google.com/youtube/iframe_api_reference#pauseVideo. */
  pauseVideo(): void;
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
  /** Pauses playback. Official method name per
   * dev.twitch.tv/docs/embed/video-and-clips (Player Methods: `pause()`). */
  pause(): void;
  addEventListener(event: string, callback: () => void): void;
  destroy?(): void;
  /** Current playback position, in seconds. Source: dev.twitch.tv/docs/embed/video-and-clips */
  getCurrentTime(): number;
  /** Duration of the current video, in seconds. Official method name per
   * dev.twitch.tv/docs/embed/video-and-clips (Player Methods: `getDuration()`).
   * Used by `pauseAtEnd` (retest fix-up #1) to seek back off the very end of
   * an ENDED video before pausing — a plain `pause()` issued while already
   * in the ENDED state does not cancel Twitch's "Up Next" autoplay
   * countdown. Optional because callers must feature-detect before relying
   * on it (defensive against embed API surface drift). */
  getDuration?(): number;
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

/** Poll interval for the Twitch proactive end-guard (retest fix-up #11) —
 * narrowly scoped to this one end-of-video check (never a general
 * highlight-tracking poll, which CONTEXT.md forbids). */
const TWITCH_END_GUARD_INTERVAL_MS = 500;

/** How many seconds before the video's reported `getDuration()` the guard
 * fires — see `onEndGuard`'s doc comment for why this needs to fire BEFORE
 * the true end rather than reactively on ENDED. */
const TWITCH_END_GUARD_THRESHOLD_SECONDS = 1.5;

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
  /**
   * Twitch-only proactive end-guard (retest fix-up #11). Twitch's own
   * `ENDED` event fires only once the video has ALREADY reached its true
   * end — at which point the platform's own "Up Next" post-roll overlay has
   * already started its countdown, so a REACTIVE pause (even `pauseAtEnd`'s
   * seek-back-then-pause workaround, issued from the `onEnded` handler) is
   * too late to prevent the overlay from ever appearing. This callback
   * instead fires from a light interval watching the live playback position
   * (500ms, created/destroyed with the player — narrowly scoped to this one
   * end-of-video check, never a general highlight-tracking poll) roughly
   * `TWITCH_END_GUARD_THRESHOLD_SECONDS` BEFORE the video would actually
   * reach its end, while the player is still safely in a non-ended state.
   * The caller decides what to do (advance to a next video, or pause in
   * place) — identical to how it already handles `onEnded`. `onEnded`
   * remains wired as a backstop for BOTH providers: if this guard already
   * fired for the current video, the subsequent real `ENDED` event is a
   * no-op (idempotent, per-identity `firedRef`). Never fires for YouTube —
   * its own `ENDED` event already works reliably with no post-roll hijack
   * risk (see `onEnded`'s doc comment above).
   */
  onEndGuard?: () => void;
  /** Threaded as a REF (never a snapshotted boolean): React refs must not
   * be read during render (`react-hooks/refs`), so the caller (ultimately
   * `VodManagerPage`) passes the ref object itself and this hook reads
   * `.current` ONLY inside the construction effect body below — an effect
   * read is exempt from that rule. Consulted once per construction (same
   * "read once, never a remount trigger on its own" treatment as
   * `startSeconds`) to request autoplay for that one construction only.
   * NEVER added to the identity-keyed effect's dependency array — refs are
   * always safe to omit. */
  autoplayOnConstructRef?: RefObject<boolean>;
  /**
   * Bump this (e.g. an incrementing counter) to force a full player
   * reconstruction even when the video IDENTITY is unchanged — the escape
   * hatch for iframe "drift": after an ENDED event, a host platform's
   * post-roll UI (documented for Twitch: the "Up Next" overlay) can
   * autoplay ITS OWN recommended video into the SAME embedded iframe,
   * silently hijacking it out from under the live player object this hook
   * returned. When the caller detects that (see `VodManagerPage`'s
   * `driftedRef`) and the user reselects a video sharing the SAME identity
   * the player was already showing, the normal "same identity -> no-op /
   * reposition-seek" path is insufficient to recover a hijacked iframe — a
   * fresh construction is required. Combined with `identityKey` to form the
   * actual construction-effect key, so this is a NO-OP remount trigger on
   * its own (an identity change already remounts); it only forces an
   * ADDITIONAL remount when the identity did NOT change. Defaults to `0`.
   */
  remountToken?: number;
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
  /** Pauses the live player in place (no seek). No-op until `isReady` is
   * true — mirrors `seek`'s ready-gate guard. */
  pause: () => void;
  /** ENDED-specific pause (retest fix-up #1) — use ONLY when there's no
   * advance target (Library or playlist end), never for a plain in-place
   * pause (see `pause` above for that). Returns `true` when the video was
   * successfully left in a non-autoplaying state (YouTube: plain
   * `pauseVideo()`; Twitch: seek back off the very end then `pause()`, the
   * reliable way to cancel Twitch's "Up Next" countdown, since a plain
   * `pause()` issued while already ENDED does not cancel it). Returns
   * `false` when the Twitch workaround couldn't be applied reliably (e.g.
   * `getDuration()` is missing or returns an unusable value) — the caller
   * should then fall back to its own remount-based recovery. */
  pauseAtEnd: () => boolean;
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
 * (`${provider}:${videoId}`) combined with `remountToken` (see its doc
 * comment), not on `vodUrl`/`startSeconds`/the whole match object, so
 * unrelated metadata edits never remount an in-progress playback
 * (PITFALLS.md UX row) — `remountToken` defaults to `0` and only the
 * caller's explicit drift-recovery bump changes it. This invariant is
 * UNCHANGED by the `onEnded`/`onAutoplayBlocked`/`autoplayOnConstructRef`
 * additions below: `onEnded`/`onAutoplayBlocked` are stored in latest-value
 * refs (updated every render, mirroring `VodPlayer.tsx`'s
 * `seekRef`/`getCurrentTimeRef` population pattern) so they never need to
 * appear in the construction effect's deps, and
 * `autoplayOnConstructRef.current` is read ONCE per construction, INSIDE
 * the effect body (never during render, per `react-hooks/refs`) — none of
 * the three ever trigger their own remount.
 */
export function useVodPlayer({
  vodUrl,
  startSeconds,
  onEnded,
  onAutoplayBlocked,
  onEndGuard,
  autoplayOnConstructRef,
  remountToken,
}: UseVodPlayerOptions): UseVodPlayerResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayerInstance | TwitchPlayerInstance | null>(null);
  const providerRef = useRef<'youtube' | 'twitch' | null>(null);
  const onEndedRef = useRef(onEnded);
  const onAutoplayBlockedRef = useRef(onAutoplayBlocked);
  const onEndGuardRef = useRef(onEndGuard);
  // Per-construction "already handled the end of this video" latch —
  // reset at the top of the construction effect below (a new video
  // identity or a forced remount always gets a fresh latch). Set the
  // moment EITHER the proactive guard fires OR (if the guard never fires
  // in time / doesn't apply) the real `ENDED` event fires — whichever
  // happens first wins, and the other becomes a no-op (retest fix-up #11).
  const endGuardFiredRef = useRef(false);
  useEffect(() => {
    onEndedRef.current = onEnded;
    onAutoplayBlockedRef.current = onAutoplayBlocked;
    onEndGuardRef.current = onEndGuard;
  });

  const detected = detectVodProvider(vodUrl);
  const identityKey =
    detected.provider != null ? `${detected.provider}:${detected.videoId}` : 'unsupported';
  // The construction effect's ACTUAL key — identity plus `remountToken`, so
  // bumping the token forces a fresh construction even when identity is
  // unchanged (see `remountToken`'s doc comment above).
  const effectKey = `${identityKey}::${remountToken ?? 0}`;

  const [trackedEffectKey, setTrackedEffectKey] = useState(effectKey);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<VodPlayerErrorState | null>(
    detected.provider === null ? 'unsupported' : null,
  );

  // Reset ready/error state during render when the effective construction
  // key changes — React's "adjusting state when a prop changes" pattern,
  // not an effect, so switching to a new match's video (or a forced
  // drift-recovery remount of the SAME video) never flashes stale
  // ready/error state before the construction effect below re-runs.
  if (effectKey !== trackedEffectKey) {
    setTrackedEffectKey(effectKey);
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
    // A fresh construction (new video identity OR a forced drift-recovery
    // remount) always starts with a clean end-guard latch.
    endGuardFiredRef.current = false;
    // autoplayOnConstructRef.current is read HERE, inside the effect body
    // (never during render — react-hooks/refs), exactly once for THIS
    // construction. Mirrors the startSeconds closure-capture treatment
    // below.
    const shouldAutoplay = autoplayOnConstructRef?.current ?? false;

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
            autoplay: shouldAutoplay ? 1 : 0,
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
          autoplay: shouldAutoplay,
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
          // Backstop for the proactive end-guard (retest fix-up #11) below —
          // if the guard already fired for this construction, the real
          // ENDED event is a no-op (idempotent): the advance/pause it would
          // trigger already happened.
          if (!cancelled && !endGuardFiredRef.current) {
            endGuardFiredRef.current = true;
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
    // Intentionally keyed on `effectKey` (video IDENTITY + `remountToken`,
    // see doc comments above) — startSeconds/detected are captured via
    // closure for the initial construction and must NOT trigger a remount
    // on their own. onEndedRef/onAutoplayBlockedRef/autoplayOnConstructRef
    // are all refs (read via .current inside this effect / the event
    // handlers above), so they're intentionally excluded too — reading a
    // ref never needs to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectKey]);

  // Twitch proactive end-guard (retest fix-up #11) — see `onEndGuard`'s doc
  // comment above for the full rationale. A light interval, created only
  // once THIS construction's Twitch player is actually ready (mirrors the
  // construction effect's own async readiness gating) and torn down on
  // every identity change / forced remount / unmount, exactly like any
  // other player-scoped resource. YouTube never enters this branch.
  useEffect(() => {
    if (!isReady || providerRef.current !== 'twitch' || !playerRef.current) {
      return;
    }
    const player = playerRef.current as TwitchPlayerInstance;
    const getDuration = player.getDuration;
    if (typeof getDuration !== 'function') {
      // No getDuration() surface to check against — nothing this guard can
      // do; the ENDED backstop still applies (see the listener above).
      return;
    }
    const intervalId = window.setInterval(() => {
      if (endGuardFiredRef.current) {
        return;
      }
      let duration: number;
      let currentTime: number;
      try {
        duration = getDuration.call(player);
        currentTime = player.getCurrentTime();
      } catch {
        return;
      }
      // VOD metadata not ready yet (or an unusual duration-less stream) —
      // skip this tick rather than misfiring on a 0/NaN duration.
      if (!Number.isFinite(duration) || duration <= 0) {
        return;
      }
      if (currentTime >= duration - TWITCH_END_GUARD_THRESHOLD_SECONDS) {
        endGuardFiredRef.current = true;
        onEndGuardRef.current?.();
      }
    }, TWITCH_END_GUARD_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
    // Keyed on the SAME construction identity as the player-construction
    // effect (`effectKey`) plus `isReady` — a fresh interval starts only
    // once a NEW Twitch player instance actually becomes ready, and is
    // always torn down before the next one starts (identity/remountToken
    // change) or on unmount.
  }, [effectKey, isReady]);

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

  /** Pauses the live player at its CURRENT position — never seeks. Mirrors
   * `seek`'s ready-gate guard exactly. Used by the quick-tag capture flow
   * (retest fix-up #2) to freeze playback at the just-captured moment. */
  function pause() {
    if (!isReady || !playerRef.current) {
      return;
    }
    if (providerRef.current === 'youtube') {
      (playerRef.current as YouTubePlayerInstance).pauseVideo();
    } else if (providerRef.current === 'twitch') {
      (playerRef.current as TwitchPlayerInstance).pause();
    }
  }

  /**
   * ENDED-specific pause — see `UseVodPlayerResult.pauseAtEnd`'s doc
   * comment for the full rationale. When not ready / no live player, treat
   * it as a no-op success (mirrors `pause`'s ready-gate guard: nothing to
   * recover from since no player is showing anything yet).
   */
  function pauseAtEnd(): boolean {
    if (!isReady || !playerRef.current) {
      return true;
    }
    if (providerRef.current === 'youtube') {
      (playerRef.current as YouTubePlayerInstance).pauseVideo();
      return true;
    }
    if (providerRef.current === 'twitch') {
      const twitchPlayer = playerRef.current as TwitchPlayerInstance;
      if (typeof twitchPlayer.getDuration !== 'function') {
        return false;
      }
      let duration: number;
      try {
        duration = twitchPlayer.getDuration();
      } catch {
        return false;
      }
      if (!Number.isFinite(duration) || duration <= 0) {
        return false;
      }
      twitchPlayer.seek(Math.max(0, duration - 1));
      twitchPlayer.pause();
      return true;
    }
    return true;
  }

  return { containerRef, isReady, error, seek, pause, pauseAtEnd, getCurrentTime };
}

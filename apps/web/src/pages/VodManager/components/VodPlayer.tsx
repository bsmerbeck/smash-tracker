import { useEffect } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { useVodPlayer } from '@/lib/useVodPlayer';

export interface VodPlayerProps {
  /** The selected match's raw stored VOD URL. */
  vodUrl: string;
  /** Initial playback position, in whole seconds. Only applied at construction time. */
  startSeconds?: number;
  /** Fires once the underlying player reports ready. */
  onReady?: () => void;
  /** Populated with the live player's `seek` function once available, so a
   * sibling `TimestampList`'s click-to-seek can reach the playing video. */
  seekRef?: RefObject<((seconds: number) => void) | null>;
  /** Populated with the live player's `pause` function once available, so
   * the quick-tag capture flow can freeze playback at the captured moment
   * without seeking (retest fix-up #2). */
  pauseRef?: RefObject<(() => void) | null>;
  /** Populated with the live player's `pauseAtEnd` function once available
   * — the ENDED-specific (no advance target) pause used to reliably cancel
   * a host platform's post-roll "Up Next" autoplay (retest fix-up #1). See
   * `useVodPlayer`'s `pauseAtEnd` doc comment; never used for the quick-tag
   * capture flow (that's `pauseRef` above). */
  pauseAtEndRef?: RefObject<(() => boolean) | null>;
  /** Populated with the live player's `getCurrentTime` function once
   * available, so a sibling `NoteComposer`/inline editor can read the live
   * playback position on-demand (never polled). */
  getCurrentTimeRef?: RefObject<(() => number) | null>;
  /** Fires when the live player reports ENDED (LIST-04 auto-advance). */
  onEnded?: () => void;
  /** Fires when the browser blocks an autoplay-triggering call — the
   * authoritative "show the native play-button fallback" signal. */
  onAutoplayBlocked?: () => void;
  /** Twitch-only proactive end-guard (retest fix-up #11) — fires ~1.5s
   * BEFORE the video actually reaches its end, while the player is still
   * safely in a non-ended state, so the caller can act early enough to
   * prevent Twitch's "Up Next" post-roll overlay from ever appearing. See
   * `useVodPlayer`'s `onEndGuard` doc comment. */
  onEndGuard?: () => void;
  /** Requests autoplay for this ONE player construction only. Passed
   * through to `useVodPlayer` as a REF (never a snapshotted boolean) —
   * React refs must not be read during render (`react-hooks/refs`), so the
   * caller passes the ref object itself; `useVodPlayer` reads `.current`
   * inside its construction effect, never a remount trigger on its own. */
  autoplayOnConstructRef?: RefObject<boolean>;
  /** Bump to force a full player reconstruction even when the video
   * identity is unchanged — drift recovery after a host platform (e.g.
   * Twitch's "Up Next" overlay) hijacks the embedded iframe post-ENDED.
   * Passed straight through to `useVodPlayer`; see its doc comment. */
  remountToken?: number;
}

/**
 * Embeds the selected match's YouTube or Twitch VOD (PLAY-01/PLAY-02) in a
 * bordered `aspect-video` box per UI-SPEC.md's Player Component Visual
 * Contract — a loading skeleton until ready, an inline "no longer
 * available" message on a dead/private VOD (Pitfall 3, replacing the player
 * entirely so layout doesn't jump), or a plain "Open on {host}" link for any
 * non-YouTube/Twitch host (never attempting an embed for an unrecognized
 * URL).
 *
 * Invoked by `VodManagerPage`'s detail panel. All player construction and
 * seek logic lives in `useVodPlayer` (`@/lib/useVodPlayer`) — this
 * component only renders the visual states and exposes `seek` upward via
 * `seekRef` so `TimestampList`'s row clicks reach the live player instance
 * (never a `vodDeepLink` URL reload — PITFALLS.md Pitfall 1).
 */
export function VodPlayer({
  vodUrl,
  startSeconds,
  onReady,
  seekRef,
  pauseRef,
  pauseAtEndRef,
  getCurrentTimeRef,
  onEnded,
  onAutoplayBlocked,
  onEndGuard,
  autoplayOnConstructRef,
  remountToken,
}: VodPlayerProps) {
  const { t } = useTranslation();
  const { containerRef, isReady, error, seek, pause, pauseAtEnd, getCurrentTime } = useVodPlayer({
    vodUrl,
    startSeconds,
    onEnded,
    onAutoplayBlocked,
    onEndGuard,
    autoplayOnConstructRef,
    remountToken,
  });

  useEffect(() => {
    if (seekRef) {
      seekRef.current = seek;
    }
  });

  useEffect(() => {
    if (pauseRef) {
      pauseRef.current = pause;
    }
  });

  useEffect(() => {
    if (pauseAtEndRef) {
      pauseAtEndRef.current = pauseAtEnd;
    }
  });

  useEffect(() => {
    if (getCurrentTimeRef) {
      getCurrentTimeRef.current = getCurrentTime;
    }
  });

  useEffect(() => {
    if (isReady) {
      onReady?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  if (error === 'unsupported') {
    return (
      <div className="aspect-video rounded-lg border bg-muted flex items-center justify-center p-4 text-center">
        <a
          href={vodUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          {t('vodManager.openOnHost', { host: safeHostname(vodUrl) })}
          <ExternalLink className="size-3.5" />
        </a>
      </div>
    );
  }

  if (error === 'unavailable') {
    return (
      <div className="aspect-video rounded-lg border bg-muted flex items-center justify-center p-4 text-center">
        <p className="text-sm text-muted-foreground">{t('vodManager.playerUnavailable')}</p>
      </div>
    );
  }

  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border">
      <div ref={containerRef} className="absolute inset-0 size-full" />
      {!isReady && <div className="absolute inset-0 bg-muted animate-pulse" />}
    </div>
  );
}

/** Best-effort hostname extraction for the "Open on {host}" fallback copy — falls back to the raw URL if it doesn't parse. */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

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
  /** Populated with the live player's `getCurrentTime` function once
   * available, so a sibling `NoteComposer`/inline editor can read the live
   * playback position on-demand (never polled). */
  getCurrentTimeRef?: RefObject<(() => number) | null>;
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
  getCurrentTimeRef,
}: VodPlayerProps) {
  const { t } = useTranslation();
  const { containerRef, isReady, error, seek, getCurrentTime } = useVodPlayer({
    vodUrl,
    startSeconds,
  });

  useEffect(() => {
    if (seekRef) {
      seekRef.current = seek;
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

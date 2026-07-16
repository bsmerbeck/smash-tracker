import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { getFighterById } from '@/data/sprites';
import { PublicLayout } from '@/layouts/PublicLayout';
import { useSeo } from '@/hooks/useSeo';
import { usePublicVodShare } from '@/hooks/useVodShares';
import { useVodPlayer } from '@/lib/useVodPlayer';
import { formatTimestamp, parseFlexibleTimestamp } from '@/lib/vod';
import { tagLabel } from '@/lib/tags';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ShareTimestampRow } from './components/ShareTimestampRow';

/** Best-effort hostname extraction for the "Watch on {host}" fallback link — mirrors `VodPlayer.tsx`'s `safeHostname`. */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Anonymous VOD review page (VIEW-01/02/03/04/05), served at `/s/:token` on
 * `PublicLayout` — no account, no `ProtectedRoute`. Hydrates client-side via
 * `usePublicVodShare` (a second fetch of the same redacted snapshot the
 * server-rendered `/s/:token` HTML shell already used for its OG meta, per
 * RESEARCH.md's architecture diagram: bots read the shell's meta and never
 * run this component). Deliberately bespoke — NOT the VOD Manager's
 * `VodMatchList`/`TimestampList`/chrome — reusing only `useVodPlayer`
 * (read-only usage: no `onUpdateTimestamps`-adjacent callbacks exist on that
 * hook to begin with) and `TimestampRow`'s highlight visual tokens via
 * `ShareTimestampRow`.
 */
export function ShareViewPage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const { data: snapshot, isPending, isError } = usePublicVodShare(token ?? '');

  const deepLinkSeconds = useMemo(() => {
    const raw = searchParams.get('t');
    return raw ? parseFlexibleTimestamp(raw) : null;
  }, [searchParams]);

  const [selectedSeconds, setSelectedSeconds] = useState<number | null>(deepLinkSeconds);
  const appliedDeepLinkRef = useRef(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const { containerRef, isReady, error, seek } = useVodPlayer({
    vodUrl: snapshot?.vodUrl ?? '',
    startSeconds: deepLinkSeconds ?? snapshot?.vodStartSeconds ?? 0,
    onAutoplayBlocked: () => setAutoplayBlocked(true),
  });

  // VIEW-03: seek to the `?t=` deep-link exactly once, the moment the live
  // player reports ready — never re-fires (guarded by a ref, not state, so
  // a later re-render/identity-stable rerun of this effect is a no-op).
  useEffect(() => {
    if (isReady && deepLinkSeconds != null && !appliedDeepLinkRef.current) {
      appliedDeepLinkRef.current = true;
      seek(deepLinkSeconds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, deepLinkSeconds]);

  const unavailable = isError || (!isPending && !snapshot);

  useSeo({
    title: snapshot
      ? `${getFighterById(snapshot.fighterId)?.name ?? t('common.unknown')} vs ${
          getFighterById(snapshot.opponentFighterId)?.name ?? t('common.unknown')
        } — VOD review · grandfinals.gg`
      : unavailable
        ? t('share.unavailableTitle')
        : t('share.loadingTitle'),
    noindex: true,
  });

  if (unavailable) {
    return (
      <PublicLayout>
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t('share.unavailableTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('share.unavailableMessage')}</p>
          <Button asChild>
            <Link to="/">{t('share.unavailableHomeLink')}</Link>
          </Button>
        </div>
      </PublicLayout>
    );
  }

  if (isPending || !snapshot) {
    return (
      <PublicLayout>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-12">
          <div className="h-8 w-64 animate-pulse rounded bg-muted" />
          <div className="aspect-video w-full animate-pulse rounded-lg bg-muted" />
        </div>
      </PublicLayout>
    );
  }

  const fighter = getFighterById(snapshot.fighterId);
  const opponentFighter = getFighterById(snapshot.opponentFighterId);

  function handleSelectTimestamp(seconds: number) {
    seek(seconds);
    setSelectedSeconds(seconds);
  }

  return (
    <PublicLayout>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            {fighter && (
              <img src={fighter.url} alt={fighter.name} className="size-10 shrink-0 rounded" />
            )}
            <span className="text-lg font-semibold">
              {fighter?.name ?? t('common.unknown')} vs.{' '}
              {opponentFighter?.name ?? t('common.unknown')}
            </span>
            {opponentFighter && (
              <img
                src={opponentFighter.url}
                alt={opponentFighter.name}
                className="size-10 shrink-0 rounded"
              />
            )}
            <Badge variant={snapshot.result === 'win' ? 'default' : 'secondary'}>
              {snapshot.result === 'win' ? t('share.resultWin') : t('share.resultLoss')}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {snapshot.stage && <span>{snapshot.stage.name}</span>}
            <span>{new Date(snapshot.matchDate).toLocaleDateString()}</span>
            <span>{t('share.reviewedMoments', { count: snapshot.reviewedMomentsCount })}</span>
          </div>
          {snapshot.tags && snapshot.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {snapshot.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tagLabel(t, tag)}
                </Badge>
              ))}
            </div>
          )}
          {snapshot.ownerDisplayName && (
            <p className="text-sm text-muted-foreground">
              {t('share.sharedBy', { name: snapshot.ownerDisplayName })}
            </p>
          )}
        </div>

        {error === 'unsupported' ? (
          <div className="flex flex-col gap-3 rounded-lg border bg-muted p-4">
            <a
              href={snapshot.vodUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline"
            >
              {t('share.watchOnHost', { host: safeHostname(snapshot.vodUrl) })}
              <ExternalLink className="size-3.5" />
            </a>
            {snapshot.timestamps && snapshot.timestamps.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {snapshot.timestamps.map((stamp, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {formatTimestamp(stamp.seconds)}
                    </span>
                    <span>{stamp.note}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : error === 'unavailable' ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border bg-muted p-4 text-center">
            <p className="text-sm text-muted-foreground">{t('share.videoUnavailable')}</p>
          </div>
        ) : (
          <div className="relative aspect-video overflow-hidden rounded-lg border">
            <div ref={containerRef} className="absolute inset-0 size-full" />
            {!isReady && <div className="absolute inset-0 animate-pulse bg-muted" />}
          </div>
        )}
        {autoplayBlocked && (
          <p className="text-sm text-muted-foreground">
            {t('vodManager.playback.autoplayBlocked')}
          </p>
        )}

        {error === null && snapshot.timestamps && snapshot.timestamps.length > 0 && (
          <div className="flex flex-col gap-2">
            {snapshot.timestamps.map((stamp, i) => (
              <ShareTimestampRow
                key={i}
                stamp={stamp}
                isSelected={selectedSeconds === stamp.seconds}
                onSelect={handleSelectTimestamp}
              />
            ))}
          </div>
        )}

        <div className="rounded-lg border bg-muted/40 p-4 text-center">
          <p className="font-medium">{t('share.ctaTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('share.ctaBody')}</p>
          <Button asChild className="mt-3">
            <Link to="/">{t('share.ctaButton')}</Link>
          </Button>
        </div>
      </div>
    </PublicLayout>
  );
}

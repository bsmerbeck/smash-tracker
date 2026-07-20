import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { PublicLayout } from '@/layouts/PublicLayout';
import { useSeo } from '@/hooks/useSeo';
import {
  useAcknowledgeReviewDelivery,
  useMarkReviewDeliveryViewed,
  useReviewDeliveryPublic,
} from '@/hooks/useReviewDelivery';
import {
  getReviewDeliveryAckedAt,
  hasAcknowledgedReviewDelivery,
  markReviewDeliveryAcknowledged,
} from '@/lib/reviewDeliveryAck';
import { SafeMarkdown } from '@/lib/safeMarkdown';
import { VodPlayer } from '@/pages/VodManager/components/VodPlayer';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import * as onboardingOrigin from '@/lib/onboardingOrigin';

/**
 * D-08/DLV-02: the anonymous, no-account `/r/:token` recipient page for a
 * coach review delivery — a SIBLING to `ShareViewPage` (same public,
 * unauthenticated posture, same crawler-aware "view loaded" discipline), NOT
 * a fork of it: this page consumes ONLY the plan-05 anonymous snapshot
 * (`GET /api/review-deliveries/:token`, `kind: 'coachReview'`), never a
 * workspace/draft/coach-private/other-version read (T-12-25).
 *
 * Renders: coach identity + publication date, an embedded player with the
 * current source's title above it, the delivered sections through the SAME
 * `SafeMarkdown` renderer plan 07 built (never a second implementation), and
 * a single Acknowledge button whose confirmation survives a reload.
 *
 * D-04 multi-VOD citation activation: a citation chip's `onActivate` looks
 * its `matchId` up in `snapshot.citationSources` — a match against the
 * CURRENT source seeks in place; a different source re-keys `<VodPlayer>` by
 * changing its `vodUrl` prop (which itself re-keys `useVodPlayer`'s
 * identity-keyed construction effect — no manual `remountToken` needed) and
 * passes the cited second as the fresh construction's `startSeconds`.
 *
 * D-09/T-12-24 crawler safety: `client_review_view_loaded` fires via a
 * DEDICATED `POST /api/review-deliveries/:token/viewed` call (not the
 * generic `postCanonicalEvent`/`/api/events` X-ingestion route — see
 * `useMarkReviewDeliveryViewed`'s doc comment for why), gated on the
 * player's `isReady` (or immediately, for a review with no cited VOD at
 * all — there is nothing to wait on) via a fire-once ref, mirroring
 * `ShareViewPage`'s `hasFiredShareViewLoadedRef` exactly. NEVER fired from
 * the GET query resolving — a crawler/unfurl fetch only ever GETs, so it
 * never reaches the dedicated route either.
 */
export function ReviewDeliveryPage() {
  const { t } = useTranslation();
  const { token = '' } = useParams<{ token: string }>();
  const { data: snapshot, isPending, isError } = useReviewDeliveryPublic(token);
  const ack = useAcknowledgeReviewDelivery(token);
  const markViewed = useMarkReviewDeliveryViewed(token);

  const citationSources = snapshot?.citationSources ?? [];
  const hasPlayableSource = citationSources.length > 0;

  const [currentSourceRef, setCurrentSourceRef] = useState<string | null>(null);
  const [startSecondsOverride, setStartSecondsOverride] = useState<number | undefined>(undefined);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const seekRef = useRef<((seconds: number) => void) | null>(null);

  // The "already acknowledged in THIS browser" confirmation, seeded from
  // localStorage. Uses React's "adjusting state during render" pattern
  // (mirrors `useVodPlayer.ts`'s `trackedEffectKey` reset and
  // `ReviewComposerPage.tsx`'s own `currentSourceId` seeding) rather than an
  // effect that calls `setState` synchronously in its body — a plain
  // `useState` initializer only runs once per component MOUNT, which would
  // be wrong if this same page instance is ever reused across a token
  // change, so `trackedToken` re-syncs it during render whenever `token`
  // itself changes instead.
  const [trackedToken, setTrackedToken] = useState(token);
  const [ackConfirmed, setAckConfirmed] = useState(() => hasAcknowledgedReviewDelivery(token));
  const [ackedAt, setAckedAt] = useState<number | null>(() => getReviewDeliveryAckedAt(token));
  if (token !== trackedToken) {
    setTrackedToken(token);
    setAckConfirmed(hasAcknowledgedReviewDelivery(token));
    setAckedAt(getReviewDeliveryAckedAt(token));
  }

  // Seeds "now playing" to the FIRST cited source (server-ordered,
  // first-appearance-in-the-document order) the moment the snapshot
  // resolves — never re-picked afterward except by an explicit citation
  // click (handleActivateCitation below). Same render-time-adjustment
  // pattern as the ack-sync block above, not an effect.
  if (currentSourceRef == null && citationSources.length > 0) {
    setCurrentSourceRef(citationSources[0]!.sourceVodRef);
  }

  // Latest-value ref for the fire-once effect below — `markViewed` (a
  // TanStack mutation object) gets a fresh identity every render, so this
  // mirrors `useVodPlayer.ts`'s own `onEndedRef`-style "populated every
  // render, read once inside an effect" pattern rather than putting the
  // whole mutation object in a dependency array.
  const markViewedRef = useRef(markViewed.mutate);
  useEffect(() => {
    markViewedRef.current = markViewed.mutate;
  });

  // D-09/T-12-24: fires the crawler-safe Delivered -> Viewed transition
  // exactly once, gated on a USABLE render — the player reporting `isReady`
  // when one exists, or immediately once the snapshot resolves for a review
  // that cites no VOD at all (nothing to wait on). Never on the GET query
  // resolving alone — a crawler/unfurl fetch only ever GETs the snapshot and
  // never renders React, so it never reaches this effect at all.
  const hasFiredViewedRef = useRef(false);
  useEffect(() => {
    if (!snapshot || hasFiredViewedRef.current) {
      return;
    }
    if (hasPlayableSource && !isPlayerReady) {
      return;
    }
    hasFiredViewedRef.current = true;
    markViewedRef.current();
  }, [snapshot, hasPlayableSource, isPlayerReady]);

  const unavailable = isError || (!isPending && !snapshot);

  useSeo({
    title: snapshot
      ? t('reviewDelivery.seoTitle', { name: snapshot.coachDisplayName ?? '' })
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
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-12">
          <div className="h-6 w-48 animate-pulse rounded bg-muted" />
          <div className="aspect-video w-full animate-pulse rounded-lg bg-muted" />
        </div>
      </PublicLayout>
    );
  }

  const currentSource = citationSources.find((source) => source.sourceVodRef === currentSourceRef);

  function sourceDisplayLabel(
    source: { sourceVodRef: string; label?: string | null },
    index: number,
  ): string {
    return source.label?.trim() || t('reviewDelivery.sourceFallback', { index: index + 1 });
  }

  function handleActivateCitation(matchId: string, seconds: number) {
    if (matchId === currentSourceRef) {
      seekRef.current?.(seconds);
      return;
    }
    const target = citationSources.find((source) => source.sourceVodRef === matchId);
    if (!target) {
      // The citation references a source the server didn't include in
      // `citationSources` (should never happen — every embedded token's
      // source is resolved server-side) — nothing safe to do but ignore.
      return;
    }
    setStartSecondsOverride(seconds);
    setIsPlayerReady(false);
    setCurrentSourceRef(matchId);
  }

  function resolveCitationSource(matchId: string) {
    if (matchId === currentSourceRef) {
      return undefined;
    }
    const index = citationSources.findIndex((source) => source.sourceVodRef === matchId);
    if (index === -1) {
      return undefined;
    }
    return { label: sourceDisplayLabel(citationSources[index]!, index) };
  }

  function handleAcknowledge() {
    ack.mutate(undefined, {
      onSuccess: () => {
        const now = Date.now();
        markReviewDeliveryAcknowledged(token, now);
        setAckConfirmed(true);
        setAckedAt(now);
      },
    });
  }

  // ONBD-01/D-02: `/r/:token` is the AMBIGUOUS origin (a recipient might
  // want to review their own VODs or track improvement — routes to the
  // ASK variant in 13-06, never a claim-shaped path). This page had NO
  // signup CTA before this phase (Pitfall 4) — net-new UI, not a retarget.
  function handleSignupCtaClick() {
    onboardingOrigin.stamp({ kind: 'coachReview', returnPath: `/r/${token}` });
  }

  return (
    <PublicLayout>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t('reviewDelivery.eyebrow')}
          </p>
          <h1 className="text-xl font-semibold tracking-tight">
            {t('reviewDelivery.heading', { name: snapshot.coachDisplayName })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('reviewDelivery.published', {
              date: new Date(snapshot.reviewPublishedAt!).toLocaleDateString(),
            })}
          </p>
        </div>

        {hasPlayableSource && currentSource ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
              {t('reviewDelivery.nowPlaying')}
            </p>
            <p className="text-sm font-medium">
              {sourceDisplayLabel(
                currentSource,
                citationSources.findIndex((source) => source.sourceVodRef === currentSourceRef),
              )}
            </p>
            <VodPlayer
              vodUrl={currentSource.vodUrl}
              startSeconds={startSecondsOverride}
              seekRef={seekRef}
              onReady={() => setIsPlayerReady(true)}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('reviewDelivery.noSource')}</p>
        )}

        {snapshot.sections && snapshot.sections.length > 0 ? (
          <div className="flex flex-col gap-4">
            {snapshot.sections.map((section) => (
              <div key={section.id} className="rounded-lg border bg-card">
                <div className="border-b px-3.5 py-2">
                  <h2 className="text-sm font-semibold">
                    {section.kind === 'general'
                      ? section.title?.trim() ||
                        t('coaching.reviews.composer.sections.kinds.general')
                      : t(`coaching.reviews.composer.sections.kinds.${section.kind}`)}
                  </h2>
                </div>
                <div className="px-3.5 py-3">
                  <SafeMarkdown
                    body={section.body}
                    onActivateCitation={handleActivateCitation}
                    resolveCitationSource={resolveCitationSource}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('reviewDelivery.sectionsEmpty')}</p>
        )}

        <div
          className={cn(
            'flex items-center gap-3 rounded-lg border p-4',
            ackConfirmed && 'border-green-500 bg-green-50 dark:border-green-800 dark:bg-green-950',
          )}
        >
          {ackConfirmed ? (
            <div className="flex-1 text-sm">
              <p className="flex items-center gap-1.5 font-semibold text-green-700 dark:text-green-400">
                <Check className="size-4" aria-hidden="true" />
                {t('reviewDelivery.ack.confirmedTitle')}
              </p>
              <p className="text-muted-foreground">
                {t('reviewDelivery.ack.confirmedDetail', {
                  date: ackedAt ? new Date(ackedAt).toLocaleDateString() : '',
                })}
              </p>
            </div>
          ) : (
            <>
              <p className="flex-1 text-sm">{t('reviewDelivery.ack.prompt')}</p>
              <Button type="button" onClick={handleAcknowledge} disabled={ack.isPending}>
                {t('reviewDelivery.ack.button')}
              </Button>
            </>
          )}
        </div>

        <div className="rounded-lg border bg-muted/40 p-4 text-center">
          <p className="font-medium">{t('reviewDelivery.cta.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('reviewDelivery.cta.body')}</p>
          <Button asChild className="mt-3">
            <Link to="/" onClick={handleSignupCtaClick}>
              {t('reviewDelivery.cta.button')}
            </Link>
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">{t('reviewDelivery.footer')}</p>
      </div>
    </PublicLayout>
  );
}

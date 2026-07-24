import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { IncludedVod, PublicShareSnapshot } from '@smash-tracker/shared';
import { PublicLayout } from '@/layouts/PublicLayout';
import { useSeo } from '@/hooks/useSeo';
import { useFighterNameResolver } from '@/hooks/useFighterName';
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
import { DeliveryVodNotesTab } from '@/pages/Review/components/DeliveryVodNotesTab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import * as onboardingOrigin from '@/lib/onboardingOrigin';

/** The two-tab shell's tab identifiers — shared between the coachReview and session renders (both share the SAME shell, Phase 21 Plan 02). */
type DeliveryTab = 'vodNotes' | 'reviewNotes';

/**
 * Phase 21 Plan 02 (DLVX-01/02/03) back-compat fallback: for a pre-Phase-21
 * delivery (no `includedVods` frozen at creation), the "VOD Notes" tab still
 * shows the review's cited footage (player-only, no timestamped notes —
 * `citationSources` never carried a per-source note list) rather than an
 * empty tab. Maps ONLY already-public `citationSources` fields (T-21-06) —
 * no new data source introduced.
 */
function citationSourcesAsIncludedVods(
  citationSources: PublicShareSnapshot['citationSources'],
): IncludedVod[] {
  return (citationSources ?? []).map((source) => ({
    matchId: source.sourceVodRef,
    label: source.label,
    vodUrl: source.vodUrl,
  }));
}

/**
 * D-08/DLV-02: the anonymous, no-account `/r/:token` recipient page for a
 * coach review delivery — a SIBLING to `ShareViewPage` (same public,
 * unauthenticated posture, same crawler-aware "view loaded" discipline), NOT
 * a fork of it: this page consumes ONLY the plan-05 anonymous snapshot
 * (`GET /api/review-deliveries/:token`, `kind: 'coachReview'`), never a
 * workspace/draft/coach-private/other-version read (T-12-25).
 *
 * Renders: coach identity + publication date, a short explanation
 * paragraph, and a two-tab shell (Phase 21 Plan 02, DLVX-01/02/03) — "VOD
 * Notes" (`DeliveryVodNotesTab` over the delivery's frozen `includedVods`,
 * click-to-seek timestamped notes with a switcher for 2+ VODs) and "Review
 * Notes" (the delivered sections through the SAME `SafeMarkdown` renderer
 * plan 07 built, with its own conditional citation player STILL gated on
 * `citationSources.length > 0` — unchanged from before this restructure).
 * Below the tabs: a single Acknowledge button whose confirmation survives a
 * reload.
 *
 * D-04 multi-VOD citation activation (Review Notes tab only): a citation
 * chip's `onActivate` looks its `matchId` up in `snapshot.citationSources` —
 * a match against the CURRENT source seeks in place; a different source
 * re-keys `<VodPlayer>` by changing its `vodUrl` prop (which itself re-keys
 * `useVodPlayer`'s identity-keyed construction effect — no manual
 * `remountToken` needed) and passes the cited second as the fresh
 * construction's `startSeconds`.
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
 *
 * Phase 20 Plan 04 (SESS-01/02) introduced an early kind-branch rendering a
 * SEPARATE `SessionDeliveryView` when `snapshot.kind === 'session'` — Phase
 * 21 Plan 02 restructures it into the SAME two-tab shell (see its own doc
 * comment below), still with no viewed/ack lifecycle (deliberately out of
 * scope, unchanged from Phase 20).
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

  // Phase 21 Plan 02 (DLVX-01): which of the two-tab shell's tabs is active.
  // Defaults to VOD Notes — the coach's timestamped annotation effort IS the
  // delivery now, not an afterthought behind the written review.
  const [activeTab, setActiveTab] = useState<DeliveryTab>('vodNotes');

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
    // Phase 20 Plan 04 (SESS-01/02): sessions deliberately have no
    // viewed/ack lifecycle this phase — never fire the coachReview-only
    // Delivered -> Viewed transition for a session-kind snapshot (its
    // shareId grammar wouldn't resolve via `resolveCoachReviewShareRef`
    // anyway, but skipping here avoids a wasted 404 round-trip).
    if (!snapshot || hasFiredViewedRef.current || snapshot.kind === 'session') {
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
      ? snapshot.kind === 'session'
        ? t('reviewDelivery.session.seoTitle', { name: snapshot.coachDisplayName ?? '' })
        : t('reviewDelivery.seoTitle', { name: snapshot.coachDisplayName ?? '' })
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

  // Phase 20 Plan 04 (SESS-01/02): a session-kind snapshot renders an
  // entirely separate, minimal view — never the coachReview layout below
  // (which reads coachReview-only fields like `sections`/`citationSources`
  // that a session snapshot structurally lacks).
  if (snapshot.kind === 'session') {
    return <SessionDeliveryView snapshot={snapshot} />;
  }

  const currentSource = citationSources.find((source) => source.sourceVodRef === currentSourceRef);

  // Phase 21 Plan 02 (DLVX-01/T-21-06): the "VOD Notes" tab's source list —
  // the frozen, coach-picked `includedVods` when this delivery has any, else
  // a GRACEFUL back-compat fallback derived from the already-public
  // `citationSources` (a pre-Phase-21 delivery, or one with zero picks).
  const vodNotesSources: IncludedVod[] =
    snapshot.includedVods && snapshot.includedVods.length > 0
      ? snapshot.includedVods
      : citationSourcesAsIncludedVods(citationSources);

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

        <p className="text-sm text-muted-foreground">{t('reviewDelivery.explanation')}</p>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as DeliveryTab)}>
          <TabsList>
            <TabsTrigger value="vodNotes">{t('reviewDelivery.tabs.vodNotes')}</TabsTrigger>
            <TabsTrigger value="reviewNotes">{t('reviewDelivery.tabs.reviewNotes')}</TabsTrigger>
          </TabsList>

          <TabsContent value="vodNotes" className="pt-4">
            <DeliveryVodNotesTab vods={vodNotesSources} />
          </TabsContent>

          {/* Rule 1 (auto-fixed bug): `forceMount` keeps this panel's `VodPlayer`
              mounted even while the VOD Notes tab is showing — the D-09/T-12-24
              crawler-safe Viewed transition below is gated on THIS player's
              `isReady` (`hasPlayableSource && !isPlayerReady`), so without
              `forceMount` a recipient who never clicks into Review Notes would
              never fire Viewed at all. `TabsContent`'s own
              `data-[state=inactive]:hidden` class still visually hides it. */}
          <TabsContent value="reviewNotes" forceMount className="flex flex-col gap-4 pt-4">
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
          </TabsContent>
        </Tabs>

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

/**
 * Phase 20 Plan 04 (Coaching Workflow, Training Sessions & VOD-less
 * Reviews, SESS-01/02, T-20-15) origin, RESTRUCTURED by Phase 21 Plan 02
 * (DLVX-01) into the SAME two-tab shell the coachReview render above uses:
 * coach identity + session date + character-tag chips + the explanation
 * paragraph, then Tabs — "VOD Notes" (`DeliveryVodNotesTab` over the
 * session's frozen `includedVods`) and "Review Notes" (the summary via
 * `SafeMarkdown` + the read-only homework checklist). The labels-only
 * linked-VOD reference list this view used to render is dropped — the rich
 * VOD Notes tab replaces it. The snapshot's `session*`/`includedVods`
 * fields are the ONLY fields this component reads — there is no path to
 * `coachPrivateNotes` (structurally absent from the frozen snapshot by
 * shape, per `clientVisibleSessionSchema`/`sessionDeliveries.ts`). Sessions
 * still have no ack/CTA/viewed lifecycle (unchanged from Phase 20).
 */
function SessionDeliveryView({ snapshot }: { snapshot: PublicShareSnapshot }) {
  const { t } = useTranslation();
  const fighterName = useFighterNameResolver();
  const [activeTab, setActiveTab] = useState<DeliveryTab>('vodNotes');

  const characterTags = snapshot.sessionCharacterTags ?? [];
  const homework = snapshot.sessionHomework ?? [];
  const includedVods = snapshot.includedVods ?? [];

  return (
    <PublicLayout>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t('reviewDelivery.session.eyebrow')}
          </p>
          <h1 className="text-xl font-semibold tracking-tight">
            {t('reviewDelivery.session.heading', { name: snapshot.coachDisplayName })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('reviewDelivery.session.dateLabel', {
              date: snapshot.sessionDate ? new Date(snapshot.sessionDate).toLocaleDateString() : '',
            })}
          </p>
        </div>

        {characterTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {characterTags.map((fighterId) => (
              <Badge key={fighterId} variant="outline">
                {fighterName(fighterId)}
              </Badge>
            ))}
          </div>
        )}

        <p className="text-sm text-muted-foreground">{t('reviewDelivery.explanation')}</p>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as DeliveryTab)}>
          <TabsList>
            <TabsTrigger value="vodNotes">{t('reviewDelivery.tabs.vodNotes')}</TabsTrigger>
            <TabsTrigger value="reviewNotes">{t('reviewDelivery.tabs.reviewNotes')}</TabsTrigger>
          </TabsList>

          <TabsContent value="vodNotes" className="pt-4">
            <DeliveryVodNotesTab vods={includedVods} />
          </TabsContent>

          <TabsContent value="reviewNotes" className="flex flex-col gap-4 pt-4">
            {snapshot.sessionSummary ? (
              <div className="rounded-lg border bg-card px-3.5 py-3">
                <SafeMarkdown body={snapshot.sessionSummary} />
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">
                {t('reviewDelivery.session.homeworkHeading')}
              </h2>
              {homework.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('reviewDelivery.session.homeworkEmpty')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {homework.map((item, index) => (
                    <li key={index} className="flex items-center gap-2 text-sm">
                      <span
                        aria-label={
                          item.done
                            ? t('reviewDelivery.session.homeworkItemDoneAria', { item: item.text })
                            : t('reviewDelivery.session.homeworkItemTodoAria', { item: item.text })
                        }
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded-sm border',
                          item.done && 'border-green-600 bg-green-600 text-white',
                        )}
                      >
                        {item.done ? <Check className="size-3" /> : null}
                      </span>
                      <span className={cn(item.done && 'text-muted-foreground line-through')}>
                        {item.text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </PublicLayout>
  );
}

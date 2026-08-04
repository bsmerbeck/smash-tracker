import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ApiError } from '@/lib/api';
import { useCredits } from '@/hooks/useBilling';
import {
  useSubmitSynthesis,
  useSynthesisJob,
  usePracticePlan,
} from '@/hooks/usePostEventSynthesis';
import { SafeMarkdown } from '@/lib/safeMarkdown';
import { BuyCreditsDialog } from '@/components/billing/BuyCreditsDialog';
import { usePostEventCheckoutReturn } from './usePostEventCheckoutReturn';

/**
 * `PostEventSynthesisCard` is the ONE intentionally monetized surface on
 * the post-event review mode of `PrepBriefPage` (28-UI-SPEC.md §5, the
 * `prepPaid/PrepPaidReportsCard` precedent applied to review mode). It
 * lives in this sibling `postEventPaid/` directory — outside
 * `pages/Tournaments/postEvent/` — specifically so the free review
 * surface's monetization-vocabulary gate keeps protecting it (28-11 extends
 * the Tournaments-tree structural gate so {`prepPaid/`, `postEventPaid/`}
 * is the exact permitted-monetization set). This card renders ONLY when
 * the composing page (28-10) has confirmed the server reports
 * `paidReportsAvailable === true` — it NEVER derives that decision itself,
 * and never reads `entryKey`/annotation counts to re-derive a gate.
 */
export interface PostEventSynthesisCardProps {
  /** The tournament entry this review belongs to — threaded through the submit/poll hooks. */
  entryKey: string;
  /**
   * The number of the player's OWN stored VOD-timestamp annotations for
   * this event — the client mirror of the server's 409 no-evidence
   * precondition (review WR-02: VOD timestamps only, over the full
   * synced+manual review-results union — match-level tags never satisfy
   * the server and do not count here). Zero means the purchase button must
   * not render at all (never a bare disabled control); the composing page
   * (28-10) is the single source for this count.
   */
  annotatedEvidenceCount: number;
}

export function PostEventSynthesisCard({
  entryKey,
  annotatedEvidenceCount,
}: PostEventSynthesisCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const credits = useCredits();
  const { data: jobData } = useSynthesisJob(entryKey);
  const submitSynthesis = useSubmitSynthesis(entryKey);

  // The `?billing=` Stripe Checkout return trip — see
  // usePostEventCheckoutReturn.ts for why this handling lives here rather
  // than on PrepBriefPage.
  usePostEventCheckoutReturn();

  const [submitPending, setSubmitPending] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [insufficientCredits, setInsufficientCredits] = useState(false);
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const job = jobData?.job ?? null;
  const { data: planData } = usePracticePlan(
    isExpanded && job?.status === 'succeeded' ? job.resultRef : undefined,
  );

  const creditsData = credits.data;
  const freeAccess = creditsData?.freeAccess ?? false;
  const availablePacks = creditsData?.packs ?? [];
  const canBuyCredits = !freeAccess && availablePacks.length > 0;

  // Every purchase-path state below is mutually exclusive — exactly one
  // renders. The needAnnotations/buyCta split (both apply only with no
  // outstanding job, or a resolved refund) mirrors
  // `PrepPaidReportsCard`'s `showPurchaseControls` gating.
  const hasNoActiveJob = !job || job.status === 'refunded';
  const hasAnnotations = annotatedEvidenceCount > 0;

  function handleSubmitError(error: unknown) {
    if (error instanceof ApiError && error.status === 402) {
      setInsufficientCredits(true);
      setSubmitFailed(false);
      setBuyCreditsOpen(true);
      return;
    }
    setSubmitFailed(true);
    setInsufficientCredits(false);
  }

  function handleBuy() {
    setSubmitPending(true);
    setSubmitFailed(false);
    setInsufficientCredits(false);
    submitSynthesis.mutate(undefined, {
      onError: handleSubmitError,
      onSettled: () => setSubmitPending(false),
    });
  }

  function toggleView() {
    setIsExpanded((current) => !current);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          {t('postEventPaid.title')}
        </CardTitle>
        <CardDescription>{t('postEventPaid.description')}</CardDescription>
        {(freeAccess || creditsData) && (
          <p className="text-xs text-muted-foreground">
            {freeAccess
              ? t('postEventPaid.balance.freeAccess')
              : t('postEventPaid.balance.credits', { count: creditsData?.balance ?? 0 })}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!hasAnnotations && hasNoActiveJob && (
          <div className="flex flex-col items-center gap-1 py-6 text-center">
            <h3 className="text-sm font-medium">{t('postEventPaid.needAnnotations.title')}</h3>
            <p className="text-sm text-muted-foreground">
              {t('postEventPaid.needAnnotations.body')}
            </p>
          </div>
        )}

        {hasAnnotations && hasNoActiveJob && (
          <div className="flex flex-col gap-2">
            {job?.status === 'refunded' && (
              <Badge variant="outline" className="w-fit">
                {t('postEventPaid.jobStatus.refunded')}
              </Badge>
            )}
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <Button type="button" disabled={submitPending} onClick={handleBuy}>
                <Sparkles className={submitPending ? 'animate-spin' : ''} />
                {t('postEventPaid.buyCta')}
              </Button>
            </div>
            {insufficientCredits && (
              <p className="text-sm text-muted-foreground">
                {t('postEventPaid.insufficientCredits.body')}{' '}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  onClick={() => setBuyCreditsOpen(true)}
                >
                  {t('postEventPaid.insufficientCredits.buyCta')}
                </Button>{' '}
                {t('postEventPaid.insufficientCredits.toGenerate')}
              </p>
            )}
            {submitFailed && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {t('postEventPaid.error.submitFailed')}
              </div>
            )}
          </div>
        )}

        {(job?.status === 'queued' || job?.status === 'running') && (
          <div className="flex items-center gap-3 rounded-md border p-3">
            {job.status === 'queued' && (
              <Badge variant="outline">{t('postEventPaid.jobStatus.queued')}</Badge>
            )}
            {job.status === 'running' && (
              <Badge variant="secondary">
                <Sparkles className="animate-spin" />
                {t('postEventPaid.jobStatus.running')}
              </Badge>
            )}
          </div>
        )}

        {job?.status === 'failed' && (
          <div className="flex items-center gap-3 rounded-md border p-3">
            <Badge variant="destructive">{t('postEventPaid.jobStatus.failedPendingRefund')}</Badge>
          </div>
        )}

        {job?.status === 'succeeded' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <Badge variant="success">{t('postEventPaid.jobStatus.succeeded')}</Badge>
              <Button type="button" variant="link" size="sm" onClick={toggleView}>
                {isExpanded
                  ? t('postEventPaid.jobStatus.hidePlan')
                  : t('postEventPaid.jobStatus.viewPlan')}
              </Button>
            </div>

            {isExpanded && planData && (
              <div className="flex flex-col gap-4 rounded-md border p-3">
                <SafeMarkdown body={planData.plan.summary} />
                {planData.plan.focusAreas.map((focusArea, index) => (
                  <div key={`${focusArea.title}-${index}`} className="flex flex-col gap-2">
                    <SafeMarkdown
                      body={`### ${focusArea.title}\n\n${focusArea.evidence}`}
                      onActivateCitation={(matchId) =>
                        // IN-04: encode — matchId is a push key today (URL-safe),
                        // but every API-path interpolation in lib/api.ts encodes,
                        // and stored data must never be trusted to stay URL-clean.
                        navigate(`/vod?match=${encodeURIComponent(matchId)}`)
                      }
                    />
                    {focusArea.drills.length > 0 && (
                      <ul className="list-disc pl-5 text-sm">
                        {focusArea.drills.map((drill, drillIndex) => (
                          <li key={drillIndex}>{drill}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>

      {canBuyCredits && (
        <BuyCreditsDialog
          open={buyCreditsOpen}
          onOpenChange={setBuyCreditsOpen}
          packs={availablePacks}
          returnTo={{ returnTo: 'prep', entryKey }}
        />
      )}
    </Card>
  );
}

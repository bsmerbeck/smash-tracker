import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { StoredPracticePlan } from '@smash-tracker/shared';
import { ApiError } from '@/lib/api';
import { useCredits } from '@/hooks/useBilling';
import { useIsDemoAccount } from '@/hooks/useIsDemoAccount';
import {
  useSubmitSynthesis,
  useSynthesisJob,
  usePracticePlan,
} from '@/hooks/usePostEventSynthesis';
import { SafeMarkdown } from '@/lib/safeMarkdown';
import { BuyCreditsDialog } from '@/components/billing/BuyCreditsDialog';
import {
  failedJobBadgeCopy,
  resolveReportJobCharge,
  type FailedJobBadgeCopy,
} from '@/lib/reportJobCharge';
import { ClaimSectionBody } from '@/components/claims/ClaimAtomLine';
import { DroppedClaimsNote } from '@/components/claims/DroppedClaimsNote';
import { WithheldProseNote } from '@/components/claims/WithheldProseNote';
import { PaidRecommendedActionsCard } from '@/components/claims/PaidRecommendedActionsCard';
import { resolveClaimSection, type ResolvedClaimSection } from '@/components/claims/claimSection';
import { usePostEventCheckoutReturn } from './usePostEventCheckoutReturn';

/**
 * Plan 39-09 (RPT-06): the claims-era practice plan's claim-anchored
 * sections, in the expanded plan view. The overview section's connective IS
 * the plan's `summary` (plan 39-08's projection), so its claims render
 * without restating it; the other two sections lead with their own heading.
 * A heading renders only for a non-empty section.
 */
const PLAN_CLAIM_SECTIONS = [
  { id: 'overview', headingKey: null },
  { id: 'gameplan', headingKey: 'scout.aiReport.gameplan' },
  { id: 'watchFor', headingKey: 'scout.aiReport.watchFor' },
] as const;

function planSection(
  plan: StoredPracticePlan,
  id: (typeof PLAN_CLAIM_SECTIONS)[number]['id'],
): ResolvedClaimSection {
  const resolved = resolveClaimSection(plan.sections?.[id], plan.claims);
  if (id !== 'overview') {
    return resolved;
  }
  if (resolved.kind === 'claims' || resolved.kind === 'abstained') {
    return { ...resolved, connective: '' };
  }
  return { kind: 'empty' };
}

/**
 * Post-plan fix (39-10): the failure badge's four wordings, each ONE complete
 * string. Refund wording is reachable only from a job that was charged
 * (`@/lib/reportJobCharge`).
 */
const FAILED_BADGE_KEYS: Record<FailedJobBadgeCopy, string> = {
  pendingRefund: 'postEventPaid.jobStatus.failedPendingRefund',
  refunded: 'postEventPaid.jobStatus.refunded',
  noCharge: 'postEventPaid.jobStatus.failedNoCharge',
  chargeUnknown: 'postEventPaid.jobStatus.failedChargeUnknown',
};

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
  // Phase 30.3 (Gate 6): no Buy Credits control anywhere it renders, for a
  // demo/research account (owner/Codex hard gate).
  const isDemoAccount = useIsDemoAccount();
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
  const canBuyCredits = !freeAccess && availablePacks.length > 0 && !isDemoAccount;

  // Every purchase-path state below is mutually exclusive — exactly one
  // renders. The needAnnotations/buyCta split (both apply only with no
  // outstanding job, or a resolved refund) mirrors
  // `PrepPaidReportsCard`'s `showPurchaseControls` gating.
  const hasNoActiveJob = !job || job.status === 'refunded';
  const hasAnnotations = annotatedEvidenceCount > 0;

  // Plan 39-10 (D-21, review C4-M2): the validation caption is TWO clauses on
  // TWO conditions, never one sentence. The CAUSE keys on an allowlist of ONE
  // value — `failureReason === 'validation'`; an absent reason or any other
  // (including one this client does not know yet) renders nothing new.
  const showValidationCause = job?.failureReason === 'validation';
  // Post-plan fix (39-10, owner decision 2026-09-25): whether this job took a
  // credit. `status === 'refunded'` alone cannot say: `failJob` also writes the
  // refunded terminal for a ZERO-SPEND post_event_synthesis failure (Phase 28
  // CR-02 — so the entry stays resubmittable) with no refundCredit call. The
  // job's persisted `wasCharged` decides when present (it survives a later
  // change to the viewer's free-access status); an older job falls back to a
  // LOADED credits read (every spend site sets `spent = !freeAccess`); neither
  // known is 'unknown', which says less rather than something false. The
  // failure badge and the RETURN clause ("your credit was returned") both
  // read this one fact.
  const charge = resolveReportJobCharge({
    wasCharged: job?.wasCharged,
    freeAccess: creditsData?.freeAccess,
  });
  const failedBadgeKey =
    job?.status === 'failed' || job?.status === 'refunded'
      ? FAILED_BADGE_KEYS[failedJobBadgeCopy(job.status, charge)]
      : null;
  const showCreditReturned =
    showValidationCause && job?.status === 'refunded' && charge === 'charged';
  const validationCaption = showValidationCause ? (
    <p className="flex flex-wrap gap-x-1 text-xs text-muted-foreground" data-validation-caption="">
      <span>{t('postEventPaid.jobStatus.failedReason.validation')}</span>
      {showCreditReturned && (
        <span data-validation-caption-return="">
          {t('postEventPaid.jobStatus.failedReason.validationRefunded')}
        </span>
      )}
    </p>
  ) : null;

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
            {job?.status === 'refunded' && failedBadgeKey && (
              <Badge variant="outline" className="w-fit">
                {t(failedBadgeKey)}
              </Badge>
            )}
            {job?.status === 'refunded' && validationCaption}
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <Button type="button" disabled={submitPending} onClick={handleBuy}>
                <Sparkles className={submitPending ? 'animate-spin' : ''} />
                {t('postEventPaid.buyCta')}
              </Button>
            </div>
            {/* Phase 30.3 (Gate 6): also gated on `canBuyCredits` (which
                already folds in `!isDemoAccount`) — no Buy Credits control
                anywhere it renders, including this inline insufficient-
                credits hint. */}
            {insufficientCredits && canBuyCredits && (
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
          <div className="flex flex-col items-start gap-2 rounded-md border p-3">
            {failedBadgeKey && <Badge variant="destructive">{t(failedBadgeKey)}</Badge>}
            {validationCaption}
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
                {planData.plan.sections != null &&
                  PLAN_CLAIM_SECTIONS.map(({ id, headingKey }) => {
                    const section = planSection(planData.plan, id);
                    if (section.kind === 'empty') {
                      return null;
                    }
                    return (
                      <div key={id} className="flex flex-col gap-2" data-plan-claim-section={id}>
                        {headingKey && <h3 className="text-sm font-semibold">{t(headingKey)}</h3>}
                        <ClaimSectionBody
                          section={planData.plan.sections?.[id]}
                          claims={planData.plan.claims}
                          resolved={section}
                        />
                      </div>
                    );
                  })}
                {/* Plan 39-11 (RPT-09 / D-12): the plan's recommended actions,
                    once, after the last focus area / claim section —
                    claims-era plans only. */}
                {planData.plan.sections != null && (
                  <PaidRecommendedActionsCard
                    actions={planData.plan.actions}
                    claims={planData.plan.claims}
                  />
                )}
                {/* Plan 39-10 (D-07 / D-20): once each, after the last
                    focus area / claim section, from the stored counts. */}
                <DroppedClaimsNote count={planData.plan.droppedClaimCount} />
                <WithheldProseNote
                  strippedSectionCount={planData.plan.strippedSectionCount}
                  claimSchemaVersion={planData.plan.claimSchemaVersion}
                  validation={planData.plan.validation}
                />
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

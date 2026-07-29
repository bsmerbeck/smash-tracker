import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import {
  PREP_BUNDLE_SIZE,
  isReportReadyBinding,
  type PrepPresenceMap,
  type ScoutBindingMap,
  type ScoutReportRecord,
} from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';
import { postCanonicalEvent } from '@/lib/canonicalEvents';
import { useCredits } from '@/hooks/useBilling';
import { usePrepReportJobs } from '@/hooks/usePrepReportJobs';
import {
  executeBundleChildren,
  useGeneratePrepReport,
  useStartPrepBundle,
} from '@/hooks/usePrepPaidReports';
import { BuyCreditsDialog } from '@/components/billing/BuyCreditsDialog';
import { ScoutAiReportCard } from '@/pages/Scout/components/ScoutAiReportCard';
import { OpponentBindingConfirm } from './OpponentBindingConfirm';
import { usePrepPaidCheckoutReturn } from './usePrepPaidCheckoutReturn';

/**
 * `PrepPaidReportsCard` is the ONE intentionally monetized surface in the
 * entire Tournaments tree (27-CONTEXT.md, RPT-04). It lives in this sibling
 * `prepPaid/` directory — outside `pages/Tournaments/prep/` — specifically
 * so `prepStructuralIntegrity.test.ts`'s monetization-vocabulary gate keeps
 * protecting Phase 26's free prep brief untouched (27-11 extends that gate
 * to confirm this file is the only permitted exception). This card renders
 * ONLY when the composing page has confirmed the server reports
 * `paidReportsAvailable === true` — it never derives that decision itself.
 * It is also the single firing site of `prep_offer_viewed`, the impression
 * event Phase 26 catalogued in the canonical-event allowlist with no
 * firing site of its own.
 */
export interface PrepPaidReportsCardProps {
  /** The tournament entry this brief belongs to — threaded through every purchase/binding hook. */
  entryKey: string;
  /** The SAME curated presence map `LikelyOpponentsCard` renders — this card duplicates no scouting content. */
  likelyOpponents: PrepPresenceMap;
  /** Confirmed scout bindings keyed by canonical opponent name, from the resolved prep brief. */
  scoutBindings: ScoutBindingMap;
}

/** The purchase this card most recently attempted — drives where the insufficient-credits/submit-failed hint renders. */
type PurchaseTarget = { kind: 'single'; name: string } | { kind: 'bundle' };

function samePurchaseTarget(a: PurchaseTarget | null, b: PurchaseTarget): boolean {
  if (!a) {
    return false;
  }
  if (a.kind !== b.kind) {
    return false;
  }
  return a.kind === 'single' && b.kind === 'single' ? a.name === b.name : true;
}

export function PrepPaidReportsCard({
  entryKey,
  likelyOpponents,
  scoutBindings,
}: PrepPaidReportsCardProps) {
  const { t } = useTranslation();
  const credits = useCredits();
  const { jobsByOpponentName } = usePrepReportJobs(entryKey);
  const generateReport = useGeneratePrepReport(entryKey);
  const startBundle = useStartPrepBundle(entryKey);

  // The `?billing=` Stripe Checkout return trip — see
  // usePrepPaidCheckoutReturn.ts for why this handling lives here rather
  // than on PrepBriefPage.
  usePrepPaidCheckoutReturn();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingSingle, setPendingSingle] = useState<string | null>(null);
  const [bundlePending, setBundlePending] = useState(false);
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);
  const [insufficientCreditsFor, setInsufficientCreditsFor] = useState<PurchaseTarget | null>(null);
  const [submitFailedFor, setSubmitFailedFor] = useState<PurchaseTarget | null>(null);
  const [expandedOpponent, setExpandedOpponent] = useState<string | null>(null);
  const [expandedReport, setExpandedReport] = useState<ScoutReportRecord | null>(null);

  const curatedNames = Object.keys(likelyOpponents).sort((a, b) => a.localeCompare(b));
  const creditsData = credits.data;
  const freeAccess = creditsData?.freeAccess ?? false;
  const availablePacks = creditsData?.packs ?? [];
  const canBuyCredits = !freeAccess && availablePacks.length > 0;

  const reportReadyCount = curatedNames.filter((name) => {
    const binding = scoutBindings[name];
    return binding ? isReportReadyBinding(binding) : false;
  }).length;

  // Impression event (Phase 26's catalogued `prep_offer_viewed`, T-27-49):
  // fires exactly once per mount, empty payload, ref-guarded so React
  // Strict Mode's double-invoke and any query refetch cannot duplicate it.
  // This card not mounting (paidReportsAvailable !== true) is exactly how
  // the event structurally cannot fire — the composing page never fires it
  // on the card's behalf.
  const hasFiredOfferViewedRef = useRef(false);
  useEffect(() => {
    if (hasFiredOfferViewedRef.current) {
      return;
    }
    hasFiredOfferViewedRef.current = true;
    postCanonicalEvent('prep_offer_viewed', {});
  }, []);

  // The inline "view report" expand reuses the existing `ScoutAiReportCard`
  // (Scout page's own report viewer) verbatim, fetched by the succeeded
  // job's `resultRef` — no new report-rendering component is built. Plain
  // fetch/state (not a react-query hook) since this is a one-off, on-demand
  // lookup for whichever single row is currently expanded. No synchronous
  // `setState` at the top of the effect body (react-hooks/set-state-in-effect):
  // a stale report simply fails the render-time identity check below
  // (`job.resultRef === expandedReport.id`) rather than being eagerly
  // cleared here.
  useEffect(() => {
    const resultRef = expandedOpponent
      ? jobsByOpponentName[expandedOpponent]?.resultRef
      : undefined;
    if (!resultRef) {
      return;
    }
    let cancelled = false;
    api.reports
      .get(resultRef)
      .then((record) => {
        if (!cancelled) {
          setExpandedReport(record);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExpandedReport(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expandedOpponent, jobsByOpponentName]);

  function toggleSelection(name: string, next: boolean) {
    setSelected((current) => {
      const nextSet = new Set(current);
      if (next) {
        nextSet.add(name);
      } else {
        nextSet.delete(name);
      }
      return nextSet;
    });
  }

  function toggleView(name: string) {
    setExpandedOpponent((current) => (current === name ? null : name));
  }

  function handlePurchaseError(target: PurchaseTarget, error: unknown) {
    if (error instanceof ApiError && error.status === 402) {
      setInsufficientCreditsFor(target);
      setSubmitFailedFor(null);
      setBuyCreditsOpen(true);
    } else {
      setSubmitFailedFor(target);
      setInsufficientCreditsFor(null);
    }
  }

  function handleBuySingle(name: string) {
    setPendingSingle(name);
    setInsufficientCreditsFor(null);
    setSubmitFailedFor(null);
    generateReport.mutate(
      { opponentName: name },
      {
        onError: (error) => handlePurchaseError({ kind: 'single', name }, error),
        onSettled: () => setPendingSingle(null),
      },
    );
  }

  function handleBuyBundle() {
    const opponentNames = Array.from(selected);
    const bundleId = crypto.randomUUID();
    setBundlePending(true);
    setInsufficientCreditsFor(null);
    setSubmitFailedFor(null);
    startBundle.mutate(
      { bundleId, opponentNames },
      {
        onSuccess: (data) => {
          setSelected(new Set());
          // Fire-and-forget: each child's own status thereafter comes from
          // the polling hook (`usePrepReportJobs`), not from this call's
          // own resolution.
          void executeBundleChildren(generateReport.mutateAsync, data.jobs);
        },
        onError: (error) => handlePurchaseError({ kind: 'bundle' }, error),
        onSettled: () => setBundlePending(false),
      },
    );
  }

  let bundleHint: string;
  if (curatedNames.length < PREP_BUNDLE_SIZE) {
    bundleHint = t('prepPaid.bundle.needMore', { count: PREP_BUNDLE_SIZE - curatedNames.length });
  } else if (reportReadyCount < PREP_BUNDLE_SIZE) {
    bundleHint = t('prepPaid.bundle.needConfirmed', {
      count: PREP_BUNDLE_SIZE - reportReadyCount,
    });
  } else {
    bundleHint = t('prepPaid.bundle.progress', { selected: selected.size });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          {t('prepPaid.title')}
        </CardTitle>
        <CardDescription>{t('prepPaid.description')}</CardDescription>
        {(freeAccess || creditsData) && (
          <p className="text-xs text-muted-foreground">
            {freeAccess
              ? t('prepPaid.balance.freeAccess')
              : t('prepPaid.balance.credits', { count: creditsData?.balance ?? 0 })}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {curatedNames.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center">
            <h3 className="text-sm font-medium">{t('prepPaid.empty.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('prepPaid.empty.body')}</p>
          </div>
        ) : (
          <>
            {curatedNames.map((name) => {
              const binding = scoutBindings[name];
              const reportReady = binding ? isReportReadyBinding(binding) : false;
              const job = jobsByOpponentName[name];
              const showPurchaseControls = reportReady && (!job || job.status === 'refunded');
              const checkboxId = `prep-paid-bundle-${entryKey}-${name}`;
              const isChecked = selected.has(name);
              const checkboxDisabled = !isChecked && selected.size >= PREP_BUNDLE_SIZE;
              const isPendingThis = pendingSingle === name;
              const isExpanded = expandedOpponent === name;
              const hasInsufficientCreditsHint = samePurchaseTarget(insufficientCreditsFor, {
                kind: 'single',
                name,
              });
              const hasSubmitFailedHint = samePurchaseTarget(submitFailedFor, {
                kind: 'single',
                name,
              });

              return (
                <div key={name} className="flex flex-col gap-2 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">{name}</span>
                    <div className="flex items-center gap-2">
                      {showPurchaseControls && (
                        <>
                          <Checkbox
                            id={checkboxId}
                            checked={isChecked}
                            disabled={checkboxDisabled}
                            aria-label={t('prepPaid.opponent.bundleCheckboxAria', { name })}
                            onCheckedChange={(next) => toggleSelection(name, next === true)}
                          />
                          <Label htmlFor={checkboxId} className="text-xs">
                            {t('prepPaid.opponent.bundleCheckbox')}
                          </Label>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isPendingThis}
                            onClick={() => handleBuySingle(name)}
                          >
                            <Sparkles className={isPendingThis ? 'animate-spin' : ''} />
                            {t('prepPaid.opponent.buyCta')}
                          </Button>
                        </>
                      )}
                      {reportReady && job?.status === 'refunded' && (
                        <Badge variant="outline">{t('prepPaid.jobStatus.refunded')}</Badge>
                      )}
                      {job?.status === 'queued' && (
                        <Badge variant="outline">{t('prepPaid.jobStatus.queued')}</Badge>
                      )}
                      {job?.status === 'running' && (
                        <Badge variant="secondary">
                          <Sparkles className="animate-spin" />
                          {t('prepPaid.jobStatus.running')}
                        </Badge>
                      )}
                      {job?.status === 'succeeded' && (
                        <>
                          <Badge variant="success">{t('prepPaid.jobStatus.succeeded')}</Badge>
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            onClick={() => toggleView(name)}
                          >
                            {isExpanded
                              ? t('prepPaid.jobStatus.hideReport')
                              : t('prepPaid.jobStatus.viewReport')}
                          </Button>
                        </>
                      )}
                      {job?.status === 'failed' && (
                        <Badge variant="destructive">
                          {t('prepPaid.jobStatus.failedPendingRefund')}
                        </Badge>
                      )}
                    </div>
                  </div>

                  <OpponentBindingConfirm entryKey={entryKey} name={name} binding={binding} />

                  {hasInsufficientCreditsHint && (
                    <p className="text-sm text-muted-foreground">
                      {t('prepPaid.insufficientCredits.body')}{' '}
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-sm"
                        onClick={() => setBuyCreditsOpen(true)}
                      >
                        {t('prepPaid.insufficientCredits.buyCta')}
                      </Button>{' '}
                      {t('prepPaid.insufficientCredits.toGenerate')}
                    </p>
                  )}
                  {hasSubmitFailedHint && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                      {t('prepPaid.error.submitFailed')}
                    </div>
                  )}

                  {isExpanded && expandedReport && expandedReport.id === job?.resultRef && (
                    <ScoutAiReportCard record={expandedReport} />
                  )}
                </div>
              );
            })}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                <span className="text-xs text-muted-foreground">{bundleHint}</span>
                <Button
                  type="button"
                  disabled={selected.size !== PREP_BUNDLE_SIZE || bundlePending}
                  onClick={handleBuyBundle}
                >
                  <Sparkles className={bundlePending ? 'animate-spin' : ''} />
                  {t('prepPaid.bundle.buyCta')}
                </Button>
              </div>
              {samePurchaseTarget(insufficientCreditsFor, { kind: 'bundle' }) && (
                <p className="text-sm text-muted-foreground">
                  {t('prepPaid.insufficientCredits.body')}{' '}
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-sm"
                    onClick={() => setBuyCreditsOpen(true)}
                  >
                    {t('prepPaid.insufficientCredits.buyCta')}
                  </Button>{' '}
                  {t('prepPaid.insufficientCredits.toGenerate')}
                </p>
              )}
              {samePurchaseTarget(submitFailedFor, { kind: 'bundle' }) && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {t('prepPaid.error.submitFailed')}
                </div>
              )}
            </div>
          </>
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

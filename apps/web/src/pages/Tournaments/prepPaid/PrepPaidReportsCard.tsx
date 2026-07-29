import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import {
  PREP_BUNDLE_SIZE,
  isReportReadyBinding,
  type PrepPresenceMap,
  type ScoutBindingMap,
} from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { postCanonicalEvent } from '@/lib/canonicalEvents';
import { useCredits } from '@/hooks/useBilling';
import { usePrepReportJobs } from '@/hooks/usePrepReportJobs';
import { useGeneratePrepReport, useStartPrepBundle } from '@/hooks/usePrepPaidReports';
import { OpponentBindingConfirm } from './OpponentBindingConfirm';

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

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingSingle, setPendingSingle] = useState<string | null>(null);
  const [bundlePending, setBundlePending] = useState(false);

  const curatedNames = Object.keys(likelyOpponents).sort((a, b) => a.localeCompare(b));
  const creditsData = credits.data;
  const freeAccess = creditsData?.freeAccess ?? false;

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

  function handleBuySingle(name: string) {
    setPendingSingle(name);
    generateReport.mutate(
      { opponentName: name },
      {
        onSettled: () => setPendingSingle(null),
      },
    );
  }

  function handleBuyBundle() {
    const opponentNames = Array.from(selected);
    const bundleId = crypto.randomUUID();
    setBundlePending(true);
    startBundle.mutate(
      { bundleId, opponentNames },
      {
        onSuccess: () => {
          setSelected(new Set());
        },
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
                        <Badge variant="success">{t('prepPaid.jobStatus.succeeded')}</Badge>
                      )}
                      {job?.status === 'failed' && (
                        <Badge variant="destructive">
                          {t('prepPaid.jobStatus.failedPendingRefund')}
                        </Badge>
                      )}
                    </div>
                  </div>

                  <OpponentBindingConfirm entryKey={entryKey} name={name} binding={binding} />
                </div>
              );
            })}

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
          </>
        )}
      </CardContent>
    </Card>
  );
}

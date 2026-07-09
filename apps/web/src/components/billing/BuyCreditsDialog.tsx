import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CreditPackId, CreditsStatus } from '@smash-tracker/shared';
import { ApiError } from '@/lib/api';
import { useCheckout } from '@/hooks/useBilling';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

function formatUsd(amountCents: number): string {
  return (amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function perReportUsd(amountCents: number, credits: number): string {
  return (amountCents / 100 / credits).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

/**
 * V7-C: "Buy credits" dialog — the two credit packs (`CREDIT_PACKS`, fetched
 * from `GET /api/billing/credits` so pricing never gets hardcoded in the
 * client) as selectable cards, then "Continue to checkout" creates a Stripe
 * Checkout Session and redirects the browser to Stripe's hosted page.
 *
 * Controlled (`open`/`onOpenChange`) rather than owning its own trigger,
 * because it needs to open from two places on the Scout page: automatically
 * when generation returns 402, and manually via a "Buy credits" affordance.
 */
export function BuyCreditsDialog({
  open,
  onOpenChange,
  packs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packs: CreditsStatus['packs'];
}) {
  const { t } = useTranslation();
  const [selectedPackId, setSelectedPackId] = useState<CreditPackId | null>(packs[0]?.id ?? null);
  const checkout = useCheckout();

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      checkout.reset();
    }
  }

  function handleContinue() {
    if (!selectedPackId) {
      return;
    }
    checkout.mutate(selectedPackId);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('billing.title')}</DialogTitle>
          <DialogDescription>{t('billing.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {packs.map((pack) => {
            const selected = pack.id === selectedPackId;
            return (
              <button
                key={pack.id}
                type="button"
                onClick={() => setSelectedPackId(pack.id)}
                aria-pressed={selected}
                className={cn(
                  'flex items-center justify-between rounded-lg border p-4 text-left transition-colors',
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
                )}
              >
                <div>
                  <p className="font-medium">{pack.label}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('billing.perReport', {
                      price: perReportUsd(pack.amountCents, pack.credits),
                    })}
                  </p>
                </div>
                <p className="text-lg font-semibold">{formatUsd(pack.amountCents)}</p>
              </button>
            );
          })}
        </div>

        {checkout.isError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {checkout.error instanceof ApiError
              ? checkout.error.message
              : t('billing.checkoutError')}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            onClick={handleContinue}
            disabled={!selectedPackId || checkout.isPending}
          >
            {checkout.isPending ? t('billing.redirecting') : t('billing.continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

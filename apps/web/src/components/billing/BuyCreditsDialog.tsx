import { useState } from 'react';
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
          <DialogTitle>Buy report credits</DialogTitle>
          <DialogDescription>
            Each AI scouting report costs one credit. Pick a pack — you'll be redirected to Stripe
            to complete the purchase.
          </DialogDescription>
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
                    {perReportUsd(pack.amountCents, pack.credits)} per report
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
              : 'Something went wrong starting checkout. Please try again.'}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleContinue}
            disabled={!selectedPackId || checkout.isPending}
          >
            {checkout.isPending ? 'Redirecting…' : 'Continue to checkout'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

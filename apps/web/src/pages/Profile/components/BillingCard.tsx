import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BuyCreditsDialog } from '@/components/billing/BuyCreditsDialog';
import { useCredits } from '@/hooks/useBilling';
import { useReportsConfig } from '@/hooks/useScoutReports';

function formatUsd(amountCents: number): string {
  return (amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Profile > Billing: mirrors ScoutPage's credits UI (V7-C), just without the
 * scouting context around it. Hidden entirely when AI reports are disabled
 * for this deployment (`reportsConfig.enabled === false`) — same rule
 * ScoutPage uses to hide its own report-generation UI.
 */
export function BillingCard() {
  const reportsConfig = useReportsConfig();
  const credits = useCredits();
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);

  if (!reportsConfig.data?.enabled) {
    return null;
  }

  const creditsData = credits.data;
  const freeAccess = creditsData?.freeAccess ?? reportsConfig.data?.freeAccess ?? false;
  const packs = creditsData?.packs ?? [];
  const canBuyCredits = !freeAccess && packs.length > 0;
  const cheapestPack = packs[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
        <CardDescription>AI scouting report credits.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {freeAccess ? (
          <Badge variant="success" className="self-start">
            Free access
          </Badge>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">{creditsData?.balance ?? 0} credits</span>
            </div>
            {cheapestPack && (
              <p className="text-sm text-muted-foreground">
                Packs start at {formatUsd(cheapestPack.amountCents)} for {cheapestPack.credits}{' '}
                reports.
              </p>
            )}
            {canBuyCredits && (
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() => setBuyCreditsOpen(true)}
              >
                Buy credits
              </Button>
            )}
          </>
        )}
      </CardContent>
      <BuyCreditsDialog open={buyCreditsOpen} onOpenChange={setBuyCreditsOpen} packs={packs} />
    </Card>
  );
}

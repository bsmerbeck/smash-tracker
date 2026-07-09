import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BuyCreditsDialog } from '@/components/billing/BuyCreditsDialog';
import { useCredits } from '@/hooks/useBilling';
import { useReportsConfig } from '@/hooks/useScoutReports';

function formatUsd(amountCents: number, locale: string): string {
  return (amountCents / 100).toLocaleString(locale, { style: 'currency', currency: 'USD' });
}

/**
 * Profile > Billing: mirrors ScoutPage's credits UI (V7-C), just without the
 * scouting context around it. Hidden entirely when AI reports are disabled
 * for this deployment (`reportsConfig.enabled === false`) — same rule
 * ScoutPage uses to hide its own report-generation UI.
 */
export function BillingCard() {
  const { t, i18n } = useTranslation();
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
        <CardTitle>{t('profile.billing.title')}</CardTitle>
        <CardDescription>{t('profile.billing.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {freeAccess ? (
          <Badge variant="success" className="self-start">
            {t('profile.billing.freeAccess')}
          </Badge>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">
                {t('profile.billing.credits', { count: creditsData?.balance ?? 0 })}
              </span>
            </div>
            {cheapestPack && (
              <p className="text-sm text-muted-foreground">
                {t('profile.billing.packsStartAt', {
                  price: formatUsd(cheapestPack.amountCents, i18n.language),
                  count: cheapestPack.credits,
                })}
              </p>
            )}
            {canBuyCredits && (
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() => setBuyCreditsOpen(true)}
              >
                {t('profile.billing.buyCredits')}
              </Button>
            )}
          </>
        )}
      </CardContent>
      <BuyCreditsDialog open={buyCreditsOpen} onOpenChange={setBuyCreditsOpen} packs={packs} />
    </Card>
  );
}

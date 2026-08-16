import { useTranslation } from 'react-i18next';
import type { EnrichmentStockAttribution } from '@/lib/enrichmentEvidence';
import { LiquipediaAttributionBadge } from './LiquipediaAttributionBadge';

/**
 * Phase 30.3 Gate 5 (web evidence-surfaces worker): the stocks-left evidence
 * a Liquipedia observation may carry, for surfaces that have no OTHER
 * stocksLeft display of their own (`SelectedMatchMeta`'s match-detail
 * `<dl>`). A surface that already shows the recorded `match.stocksLeft`
 * value (`SetTimeline`'s `GameChip` tooltip, Phase 30.3 Gate 4) renders the
 * bare `LiquipediaAttributionBadge` (variant="stocks") instead, right next
 * to that existing number — this component would only duplicate it.
 *
 * Reuses the SAME plural phrasing `tournaments.timeline.stocksLeft_one`/
 * `_other` established, via its own `enrichment.attribution.stocksLeftValue_
 * one`/`_other` keys (own namespace, consistent with every other
 * `enrichment.attribution.*` key this badge family uses).
 *
 * Renders nothing when `stocks` is `null`/`undefined` — mirrors
 * `LiquipediaCharacterEvidence`/`LiquipediaAttributionBadge`'s own contract.
 */
export function LiquipediaStockEvidence({
  stocks,
}: {
  stocks: EnrichmentStockAttribution | null | undefined;
}) {
  const { t } = useTranslation();

  if (stocks == null) {
    return null;
  }

  return (
    <div
      data-testid="liquipedia-stock-evidence"
      className="flex flex-col gap-0.5 text-xs text-muted-foreground"
    >
      <span className="text-foreground">
        {t('enrichment.attribution.stocksLeftValue', { count: stocks.stocksLeft })}
      </span>
      <LiquipediaAttributionBadge attribution={stocks} variant="stocks" />
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { isValidatedRecord, type ProvenanceFields } from './provenance';

/**
 * Phase 39 (plan 39-10, RPT-10 / D-08): the legacy / unvalidated provenance
 * label. Renders NOTHING for a validated record — silence is the default —
 * and an outline badge with an explanatory tooltip for every other record,
 * decided by `isValidatedRecord` (fail-closed: a half-written record is
 * labelled, never shown as validated).
 *
 * Tone (UI-SPEC §B): informative provenance, the same register as
 * `OpponentSourceBadge` and the `shared.evidence.type.*` sentences. The copy
 * says what is UNKNOWN about an older report (it predates claim checking),
 * never that it is wrong — outline variant only, no warning colour, no icon.
 *
 * `row` is the reports-library list variant (badge alone); `card` is the
 * opened-report variant (badge plus the one-line `reports.legacy.explain`
 * sentence beside it). The component carries its own `TooltipProvider` so
 * it renders the same under any host (MainLayout, the paid prep card, a test).
 */
export interface LegacyReportBadgeProps extends ProvenanceFields {
  variant: 'row' | 'card';
}

export function LegacyReportBadge({
  claimSchemaVersion,
  validation,
  variant,
}: LegacyReportBadgeProps) {
  const { t } = useTranslation();
  if (isValidatedRecord({ claimSchemaVersion, validation })) {
    return null;
  }

  const badge = (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" tabIndex={0} data-legacy-report-badge={variant}>
            {t('reports.legacy.badge')}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{t('reports.legacy.tooltip')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  if (variant === 'row') {
    return badge;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {badge}
      <span>{t('reports.legacy.explain')}</span>
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import {
  LIQUIPEDIA_ATTRIBUTION_LICENSE_URL,
  type ResearchEnrichmentAttributionEntry,
} from '@smash-tracker/shared';

/**
 * Phase 30.2 Plan 11 (ENR-09, OWNER POSTURE 2026-08-11): the ONE reusable
 * attribution affordance for a Liquipedia-derived stage or VOD value,
 * modelled on `apps/web/src/pages/Coaching/components/ResearchBadge.tsx`'s
 * take-the-record-as-a-prop-and-render shape.
 *
 * The `variant` prop names WHICH field the calling surface is attributing
 * (stage vs. VOD) — it is never derived from the record itself, because
 * `researchEnrichmentAttributionEntrySchema` stores at most ONE observation's
 * page identity per match key (the API route's `buildEnrichmentAttributionEntry`
 * prefers the stage half of the witness when both exist), so the record alone
 * cannot always distinguish "this is a stage fact" from "this is a VOD fact"
 * for a match enriched on both fields. The calling surface (the stage cell,
 * the VOD dropdown, the attach dialog, the edit form, the VOD manager) knows
 * which field it is describing and passes that context explicitly.
 *
 * Renders NOTHING when `attribution` is `null`/`undefined` — every call site
 * is a `record && <LiquipediaAttributionBadge .../>` guard, never an
 * unconditional render, so an un-enriched account's UI stays byte-identical.
 *
 * Never uses React's raw-HTML injection escape hatch: `rawStage` is
 * untrusted third-party wiki text (RESEARCH section 15, V5) and every value
 * below flows through ordinary JSX text-node interpolation, which React
 * escapes by construction.
 */
export type LiquipediaAttributionVariant = 'stage' | 'vod';

export function LiquipediaAttributionBadge({
  attribution,
  variant,
}: {
  attribution: ResearchEnrichmentAttributionEntry | null | undefined;
  variant: LiquipediaAttributionVariant;
}) {
  const { t } = useTranslation();

  if (attribution == null) {
    return null;
  }

  const labelKey =
    variant === 'stage' ? 'enrichment.attribution.stage' : 'enrichment.attribution.vod';

  // RESEARCH section 4.3: `stageForm` is `'normal'` for the UNSTATED common
  // case (never an assertion of "hazards on") and is otherwise `'hazardless'
  // | 'omega' | 'battlefield' | 'unknown'` — a qualifier renders for every
  // STATED form, never for the unstated normal form, so the source's marker
  // survives into the UI rather than being silently stripped.
  const showQualifier =
    attribution.stageForm != null &&
    attribution.stageForm !== 'normal' &&
    attribution.rawStage != null;

  return (
    <span
      data-testid="liquipedia-attribution-badge"
      className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
    >
      <span data-testid="liquipedia-attribution-label">{t(labelKey)}</span>
      {showQualifier && (
        <span data-testid="liquipedia-attribution-qualifier">
          {t('enrichment.attribution.stageFormQualifier', {
            raw: attribution.rawStage,
            form: t(`enrichment.attribution.stageForm.${attribution.stageForm}`),
          })}
        </span>
      )}
      {attribution.sourcePageUrl != null && (
        <a
          data-testid="liquipedia-attribution-link"
          href={attribution.sourcePageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          {t('enrichment.attribution.sourceLink')}
        </a>
      )}
    </span>
  );
}

/**
 * The licence-reference line the OWNER POSTURE block requires reachable from
 * every surface where a derived fact renders — placed ONCE per surface
 * (footer position), never per-row, so attribution is complete without
 * clutter. The two placements this plan wires are the coverage panel footer
 * (`DataCoveragePanel.tsx`, Task 3) and the VOD manager footer
 * (`VodManagerPage.tsx`, Task 2).
 */
export function LiquipediaLicenseNote() {
  const { t } = useTranslation();
  return (
    <p data-testid="liquipedia-license-note" className="text-xs text-muted-foreground">
      {t('enrichment.attribution.license')}{' '}
      <a
        href={LIQUIPEDIA_ATTRIBUTION_LICENSE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        {t('enrichment.attribution.licenseLinkText')}
      </a>
    </p>
  );
}

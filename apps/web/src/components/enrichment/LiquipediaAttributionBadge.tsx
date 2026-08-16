import { useTranslation } from 'react-i18next';
import {
  LIQUIPEDIA_ATTRIBUTION_LICENSE_URL,
  type ResearchEnrichmentStageAttribution,
  type ResearchEnrichmentVodAttribution,
} from '@smash-tracker/shared';
import type {
  EnrichmentCharacterAttribution,
  EnrichmentStockAttribution,
} from '@/lib/enrichmentEvidence';

/**
 * Phase 30.2 Plan 11 (ENR-09, OWNER POSTURE 2026-08-11): the ONE reusable
 * attribution affordance for a Liquipedia-derived stage or VOD value,
 * modelled on `apps/web/src/pages/Coaching/components/ResearchBadge.tsx`'s
 * take-the-record-as-a-prop-and-render shape.
 *
 * TAKES ONE FIELD'S HALF, NEVER THE WHOLE ENTRY (30.2 gap-closure BLOCKER
 * 2). `researchEnrichmentAttributionEntrySchema` now reports two
 * INDEPENDENT halves per match key — `entry.stage` and `entry.vod`, each
 * built from its own witness members and its own observation. A caller
 * passes the half for the field it is describing (`entry.stage` for a stage
 * rendering, `entry.vod` for a VOD one) and the `variant` that names it.
 * Passing the wrong half is what the previous single-slot shape did
 * implicitly, and it produced two user-visible errors: a user-entered VOD
 * labelled as Liquipedia-derived on a stage-only-enriched row, and a VOD
 * badge linking to the STAGE observation's page. The `href` below therefore
 * always comes from the half it was handed and no other.
 *
 * Renders NOTHING when `attribution` is `null`/`undefined` — every call site
 * is a `half && <LiquipediaAttributionBadge .../>` guard, never an
 * unconditional render, so an un-enriched account's UI stays byte-identical.
 *
 * Never uses React's raw-HTML injection escape hatch: `rawStage` is
 * untrusted third-party wiki text (RESEARCH section 15, V5) and every value
 * below flows through ordinary JSX text-node interpolation, which React
 * escapes by construction.
 *
 * Phase 30.3 Gate 5: `'characters'`/`'stocks'` name the two new evidence
 * halves (`apps/web/src/lib/enrichmentEvidence.ts`) — same badge, same
 * absence-renders-nothing contract, a distinct label per variant.
 */
export type LiquipediaAttributionVariant = 'stage' | 'vod' | 'characters' | 'stocks';

/**
 * Any half of an attribution entry. The VOD half is structurally identical
 * to the shared base source shape, and the Gate 5 `characters`/`stocks`
 * halves both EXTEND that same base (`enrichmentEvidence.ts`) — so passing
 * either to this badge is a plain structural widening, not a special case.
 */
export type LiquipediaAttributionHalf =
  | ResearchEnrichmentStageAttribution
  | ResearchEnrichmentVodAttribution
  | EnrichmentCharacterAttribution
  | EnrichmentStockAttribution;

const VARIANT_LABEL_KEYS: Record<LiquipediaAttributionVariant, string> = {
  stage: 'enrichment.attribution.stage',
  vod: 'enrichment.attribution.vod',
  characters: 'enrichment.attribution.characters',
  stocks: 'enrichment.attribution.stocks',
};

export function LiquipediaAttributionBadge({
  attribution,
  variant,
}: {
  attribution: LiquipediaAttributionHalf | null | undefined;
  variant: LiquipediaAttributionVariant;
}) {
  const { t } = useTranslation();

  if (attribution == null) {
    return null;
  }

  const labelKey = VARIANT_LABEL_KEYS[variant];

  // The stage-only members exist on the STAGE half only — the VOD half's
  // schema has no such keys at all, so this narrowing is total.
  const rawStage = 'rawStage' in attribution ? attribution.rawStage : null;
  const stageForm = 'stageForm' in attribution ? attribution.stageForm : null;

  // RESEARCH section 4.3: `stageForm` is `'normal'` for the UNSTATED common
  // case (never an assertion of "hazards on") and is otherwise `'hazardless'
  // | 'omega' | 'battlefield' | 'unknown'` — a qualifier renders for every
  // STATED form, never for the unstated normal form, so the source's marker
  // survives into the UI rather than being silently stripped.
  const showQualifier = stageForm != null && stageForm !== 'normal' && rawStage != null;

  return (
    <span
      data-testid="liquipedia-attribution-badge"
      className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
    >
      <span data-testid="liquipedia-attribution-label">{t(labelKey)}</span>
      {showQualifier && (
        <span data-testid="liquipedia-attribution-qualifier">
          {t('enrichment.attribution.stageFormQualifier', {
            raw: rawStage,
            form: t(`enrichment.attribution.stageForm.${stageForm}`),
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

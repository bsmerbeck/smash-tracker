import type { TFunction } from 'i18next';
import type {
  EvidenceClaim,
  Insight,
  InsightState,
  InsightTemplateId,
  RateValue,
} from '@smash-tracker/shared';
import { confidenceTierFor } from '@smash-tracker/shared';
import { formatGrouped } from '@/lib/format';
import { formatPercent } from '@/lib/formatPercent';

/**
 * Plan 39.1-52 (UI-SPEC §9.3-9.4 "a sample is labelled by what it is"; UAT 39.1
 * tests 7, 26, 29, 34, 35 — F2/F8/F22/F23): the ONE evidence caption builder
 * every insight host calls.
 *
 * - `horizon` — a recent window compared with the lifetime record
 *   (`twoHorizon.<horizon>`).
 * - `lifetime` — an all-time record or cohort (`allTimeOnly`); it never names a
 *   recent horizon.
 * - `event` — one named event, its own window (`single`).
 * - `host` — the template's own card renders its caption; the builder returns
 *   `null`, never a mislabelled horizon line.
 */
export type EvidenceShape = 'horizon' | 'lifetime' | 'event' | 'host';

/**
 * The per-template sample shape. Exhaustive over `InsightTemplateId`, so a new
 * template fails typecheck until it is classified. Never derived from
 * `insight.window`: rosterShift's horizon trend branch and secondaryPayoff's
 * lifetime cohort branches both carry `fromMs: null`, while pocketCost's
 * lifetime cohort carries a real `fromMs`.
 */
export const EVIDENCE_SHAPE_DEFAULT: Record<InsightTemplateId, EvidenceShape> = {
  formNow: 'horizon',
  characterMovers: 'horizon',
  rivalMovers: 'horizon',
  ratingMove: 'horizon',
  rosterShift: 'horizon',
  rosterCore: 'lifetime',
  bestMatchup: 'lifetime',
  worstMatchup: 'lifetime',
  secondaryPayoff: 'lifetime',
  pocketCost: 'lifetime',
  lastEventRecap: 'event',
  tiltCost: 'host',
  sessionFatigue: 'host',
  settingGap: 'host',
  volumeForm: 'host',
  mixShift: 'host',
  playRhythm: 'host',
  tierGap: 'host',
  matchupOrPlayer: 'host',
};

/**
 * Per-branch overrides where a template's states sample differently.
 * rosterShift's `hidden` and `steady` branches share one 0-game claim between
 * `recent` and `baseline`; as `lifetime` with that claim abstained they print
 * no caption.
 */
export const EVIDENCE_SHAPE_BY_STATE: Partial<
  Record<InsightTemplateId, Partial<Record<InsightState, EvidenceShape>>>
> = {
  rosterShift: { hidden: 'lifetime', steady: 'lifetime' },
};

/** A pure (templateId, state) lookup — it never reads the window, date ranges or claim values. */
export function resolveEvidenceShape(
  insight: Pick<Insight, 'templateId' | 'state'>,
): EvidenceShape {
  return (
    EVIDENCE_SHAPE_BY_STATE[insight.templateId]?.[insight.state] ??
    EVIDENCE_SHAPE_DEFAULT[insight.templateId]
  );
}

type EvidencedRate = Extract<EvidenceClaim<RateValue>, { kind: 'evidenced' }>;

function recordOf(claim: EvidencedRate, locale: string): string {
  return `${formatGrouped(claim.value.wins, locale)}–${formatGrouped(claim.value.losses, locale)}`;
}

/** The cue interpolation, or i18next's `bare` context (the sentence without its trailing cue) when no tier exists. */
function cueValues(
  tier: ReturnType<typeof confidenceTierFor>,
  count: number,
  t: TFunction,
): { cue: string } | { context: 'bare' } {
  return tier
    ? { cue: t(`shared.evidence.sampleCueGlyph.${tier}`, { count }) }
    : { context: 'bare' };
}

function allTimeOnly(claim: EvidencedRate, t: TFunction, locale: string): string {
  return t('insights.evidence.allTimeOnly', {
    record: recordOf(claim, locale),
    rate: formatPercent(claim.value.rate, locale),
    ...cueValues(claim.sample.confidenceTier, claim.value.total, t),
  });
}

function single(
  claim: EvidencedRate,
  t: TFunction,
  locale: string,
  cue: ReturnType<typeof cueValues>,
): string {
  return t('insights.evidence.single', { record: recordOf(claim, locale), ...cue });
}

/**
 * The insight's evidence caption, or `null` when there is nothing true to
 * print (or the template's own card owns its caption). `opts.cueCount`
 * keeps a host's own cue semantics for the horizon line (the formNow heroes
 * cue on the window / counted games).
 */
export function buildInsightEvidenceLine(
  insight: Insight,
  t: TFunction,
  locale: string,
  opts?: { cueCount?: number },
): string | null {
  const recent = insight.recent.kind === 'evidenced' ? insight.recent : null;
  const baseline = insight.baseline.kind === 'evidenced' ? insight.baseline : null;
  switch (resolveEvidenceShape(insight)) {
    case 'host':
      return null;
    case 'event':
      return recent
        ? single(recent, t, locale, cueValues(recent.sample.confidenceTier, recent.value.total, t))
        : null;
    case 'lifetime':
      return recent ? allTimeOnly(recent, t, locale) : null;
    case 'horizon': {
      if (recent) {
        const cueCount = opts?.cueCount ?? recent.value.total;
        const tier =
          opts?.cueCount === undefined ? recent.sample.confidenceTier : confidenceTierFor(cueCount);
        const cue = cueValues(tier, cueCount, t);
        if (baseline && baseline.value.total > 0) {
          return t(`insights.evidence.twoHorizon.${insight.horizon}`, {
            recentRecord: `${recordOf(recent, locale)} · ${formatPercent(recent.value.rate, locale)}`,
            baselineRate: formatPercent(baseline.value.rate, locale),
            baselineGames: baseline.value.total,
            ...cue,
          });
        }
        // F23: never "over 0" — a missing or empty baseline is the single-sample form.
        return single(recent, t, locale, cue);
      }
      return baseline && baseline.value.total > 0 ? allTimeOnly(baseline, t, locale) : null;
    }
  }
}
